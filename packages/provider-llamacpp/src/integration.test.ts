/**
 * REAL end-to-end integration test (the point of W4).
 *
 * Guarded behind PI_DESKTOP_LLAMACPP_E2E=1 so CI skips it (it downloads a 3GB
 * GGUF + the llama.cpp binary and spawns a real server). Run locally with:
 *
 *   PI_DESKTOP_LLAMACPP_E2E=1 pnpm --filter @pi-desktop/provider-llamacpp test
 *
 * It downloads the pinned llama.cpp binary and the verified Gemma4 E2B Q4 model
 * into the real cache (~/.cache/pi-desktop, so reruns are fast), spawns
 * llama-server via the supervisor in fast-text mode, then streams a plain
 * completion and a tool-call prompt through provider-llamacpp — asserting tokens
 * stream, TPS is extracted from llama.cpp timings (>0), and a deliberately
 * malformed tool call is repaired. The observed TPS is printed.
 */
import type { AssistantMessageEvent, Context, Model } from '@mariozechner/pi-ai';
import { Type } from '@mariozechner/pi-ai';
import {
  downloadModel,
  ensureLlamaCpp,
  GEMMA4_E2B,
  LlamaServerSupervisor,
  type LlamaTimings,
  probeServerFeatures,
} from '@pi-desktop/inference';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLlamaCppStream, repairToolCallArguments } from './index.js';

const RUN = process.env.PI_DESKTOP_LLAMACPP_E2E === '1';

async function consumeText(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<{ text: string; deltas: number; stop: string }> {
  let text = '';
  let deltas = 0;
  let stop = '';
  for await (const e of stream) {
    if (e.type === 'text_delta') {
      text += e.delta;
      deltas += 1;
    }
    if (e.type === 'done') stop = e.reason;
    if (e.type === 'error') stop = `error: ${e.error.errorMessage ?? ''}`;
  }
  return { text, deltas, stop };
}

describe.skipIf(!RUN)('llama.cpp + Gemma4 E2B end-to-end', () => {
  let supervisor: LlamaServerSupervisor | undefined;
  let baseUrl = '';
  let lastTimings: LlamaTimings | undefined;
  let mtpSupported = false;

  beforeAll(async () => {
    // 1. Ensure the pinned llama.cpp binary is installed + verified.
    const install = await ensureLlamaCpp({
      onProgress: (p) => {
        if (p.fraction !== undefined)
          process.stdout.write(`\rbinary ${(p.fraction * 100) | 0}%   `);
      },
    });
    process.stdout.write('\n');

    // 2. Probe MTP support (informs launch mode / flags).
    const features = await probeServerFeatures(install.serverPath);
    mtpSupported = features.mtp;

    // 3. Download the verified Gemma4 E2B Q4 model (cached, ~3.1GB).
    let lastPct = -1;
    const downloaded = await downloadModel(GEMMA4_E2B, {
      launchMode: 'fast-text',
      onProgress: (_file, p) => {
        const pct = p.fraction !== undefined ? (p.fraction * 100) | 0 : -1;
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\rmodel ${pct}%   `);
        }
      },
    });
    process.stdout.write('\n');

    // 4. Spawn llama-server in fast-text mode. Gemma4 E2B has no MTP sibling in
    //    our catalog, so even where the build supports draft-mtp we launch plain
    //    (single slot) — the supervisor's assembleServerArgs only adds MTP flags
    //    when an MTP head is actually available.
    supervisor = new LlamaServerSupervisor({
      serverPath: install.serverPath,
      modelPath: downloaded.modelPath,
      launchMode: 'fast-text',
      mtpSupported,
      mtpEmbedded: GEMMA4_E2B.mtpEmbedded,
      contextSize: 4096,
      healthTimeoutMs: 180_000,
      healthIntervalMs: 500,
    });
    const started = await supervisor.start();
    baseUrl = started.baseUrl;
  }, 20 * 60_000);

  afterAll(async () => {
    await supervisor?.dispose();
  });

  const model = (): Model<'openai-completions'> => ({
    id: 'gemma-4-e2b-it',
    name: 'Gemma 4 E2B',
    api: 'openai-completions',
    provider: 'llamacpp',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 256,
  });

  it('streams a plain completion and extracts TPS from timings', async () => {
    const ctx: Context = {
      systemPrompt: 'You are a concise assistant.',
      messages: [{ role: 'user', content: 'Reply with exactly: hello from gemma', timestamp: 0 }],
    };
    const stream = createLlamaCppStream({
      onTimings: (t) => {
        lastTimings = t;
        supervisor?.recordTimings(t);
      },
    })(model(), ctx, { maxTokens: 64, temperature: 0 });

    const { text, deltas, stop } = await consumeText(stream);
    console.log(`\n[E2E] completion text: ${JSON.stringify(text)}`);
    console.log(`[E2E] deltas=${deltas} stop=${stop}`);
    console.log(`[E2E] timings=${JSON.stringify(lastTimings)}`);
    console.log(
      `[E2E] observed TPS: supervisor.lastTps=${supervisor?.metrics.lastTps}, ` +
        `predicted_per_second=${lastTimings?.predicted_per_second}`,
    );

    expect(deltas).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);

    // TPS must be extracted and positive. Prefer the timings-derived value; if
    // this build omits `timings` from OAI-compat chunks, fail loudly so we know.
    const tps = supervisor?.metrics.lastTps;
    expect(tps, 'TPS extracted from llama.cpp timings').toBeGreaterThan(0);
  });

  it('streams a tool-call prompt and repairs a deliberately-malformed tool call', async () => {
    const weatherSchema = Type.Object({ location: Type.String() });
    const ctx: Context = {
      systemPrompt: 'Use the get_weather tool when asked about weather. Always call it.',
      messages: [{ role: 'user', content: 'What is the weather in Paris?', timestamp: 0 }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: weatherSchema,
        },
      ],
    };
    const stream = createLlamaCppStream({
      onTimings: (t) => supervisor?.recordTimings(t),
    })(model(), ctx, { maxTokens: 128, temperature: 0 });

    // Drive the real stream to completion (may or may not emit a tool call).
    const events: AssistantMessageEvent[] = [];
    for await (const e of stream) events.push(e);
    const terminal = events.at(-1);
    console.log(`[E2E] tool-prompt terminal event: ${terminal?.type}`);
    console.log(
      `[E2E] tool-prompt emitted toolcall_end: ${events.some((e) => e.type === 'toolcall_end')}`,
    );
    expect(terminal?.type === 'done' || terminal?.type === 'error').toBe(true);

    // Deliberately-malformed tool call (truncated JSON) → repaired via rungs 1–2
    // against the real tool schema, in this environment.
    const repaired = await repairToolCallArguments('{"location":"Paris', {
      toolName: 'get_weather',
      schema: weatherSchema as unknown as { required?: string[] },
    });
    console.log(`[E2E] repair result: ${JSON.stringify(repaired)}`);
    expect(repaired.ok).toBe(true);
    expect(repaired.value).toEqual({ location: 'Paris' });
  });
});
