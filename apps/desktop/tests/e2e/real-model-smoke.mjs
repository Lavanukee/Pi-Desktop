/**
 * Real-model smoke (env-guarded — skips cleanly when the model isn't cached, so
 * CI is unaffected). Drives the FULL local stack end-to-end through the built
 * app: inference-supervisor starts llama.cpp + Gemma 4 E2B, writes pi's
 * models.json, pi restarts to pick it up, then a real prompt streams through
 * pi's llamacpp provider into the renderer thread. Reports observed text + TPS.
 *
 * Run `pnpm build` first, then `node tests/e2e/real-model-smoke.mjs`.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MODEL_ID = 'gemma-4-e2b-it';
const modelPath = path.join(
  homedir(),
  '.cache/pi-desktop/models',
  MODEL_ID,
  'gemma-4-E2B-it-Q4_K_M.gguf',
);

if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('real-model-smoke: app not built — run `pnpm build` first');
  process.exit(1);
}
if (!existsSync(modelPath)) {
  console.log(`real-model-smoke: SKIP — ${MODEL_ID} not cached at ${modelPath}`);
  process.exit(0);
}

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  // Real pi (no PI_BIN) + the store hook. Uses the real ~/.pi so pi reads the
  // models.json the supervisor writes.
  env: { ...process.env, PI_E2E: '1' },
});

function fail(message) {
  throw new Error(`real-model-smoke failed: ${message}`);
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });

  // 1. Start llama-server for Gemma 4 E2B (also writes ~/.pi/agent/models.json).
  console.log('starting llama-server for', MODEL_ID, '…');
  const started = await page.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    MODEL_ID,
  );
  if (!started.success) fail(`start-server: ${started.error}`);
  console.log('server ready at', started.baseUrl);

  // 2. Restart pi so it re-reads models.json, then select the llamacpp model.
  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  if (target === undefined) fail(`no llamacpp model after restart: ${JSON.stringify(models)}`);
  console.log('pi model:', target.provider, target.id, '(api:', target.api, ')');
  // Routing proof: the llamacpp model binds to the custom `llamacpp-stream` api,
  // which is ONLY handled by provider-llamacpp's streamSimple. Its presence means
  // pi loaded our `-e` extensions (not an extension-free self-heal respawn, which
  // would leave this api unhandled). If the stale ~/.pi/agent/extensions/web-tools.ts
  // had collided and crashed pi, we'd never reach here with this api.
  if (target.api !== 'llamacpp-stream') {
    fail(
      `model api is "${target.api}", expected "llamacpp-stream" — chat is NOT routing through provider-llamacpp's streamSimple`,
    );
  }
  const set = await page.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  if (!set.success) fail(`set-model: ${set.error}`);

  // 3. Drive a real prompt and wait for streamed text in the thread.
  const t0 = Date.now();
  const ack = await page.evaluate(() =>
    window.piDesktop.invoke('pi:prompt', {
      message: 'Reply with exactly one short friendly sentence.',
    }),
  );
  if (!ack.success) fail(`prompt: ${ack.error}`);

  await page.waitForFunction(
    () => {
      const { messages, agent } = window.__pi_store().getState();
      const assistant = [...messages].reverse().find((m) => m.kind === 'assistant');
      const text = assistant?.blocks
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return !agent.isStreaming && typeof text === 'string' && text.length > 0;
    },
    { timeout: 180000 },
  );
  const elapsedMs = Date.now() - t0;

  const result = await page.evaluate(() => {
    const { messages } = window.__pi_store().getState();
    const assistant = [...messages].reverse().find((m) => m.kind === 'assistant');
    return {
      text: assistant?.blocks
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
      model: assistant?.model,
      usage: assistant?.usage,
    };
  });
  const status = await page.evaluate(() => window.piDesktop.invoke('llm:get-status', undefined));

  console.log('\n=== real-model smoke result ===');
  console.log('assistant text:', JSON.stringify(result.text));
  console.log('model:', result.model);
  console.log('output tokens:', result.usage?.output, '| elapsed ms:', elapsedMs);
  console.log('supervisor TPS:', JSON.stringify(status.metrics));

  // TPS must still show (llama.cpp timings → the footer). The provider's own
  // onTimings runs inside pi; the supervisor derives the same tok/s from the
  // server's generation-timing stderr line (see supervisor-entry.ts parseTps).
  const observedTps = status.metrics?.avgTps ?? status.metrics?.lastTps;
  if (typeof observedTps !== 'number' || observedTps <= 0) {
    fail(`no TPS surfaced from the timings path: ${JSON.stringify(status.metrics)}`);
  }
  console.log('real-model-smoke OK — chat routed through llamacpp-stream/streamSimple; TPS shown');
} finally {
  await app.close();
}
