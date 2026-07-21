/**
 * The power-user "advanced params" seam, in the pi CHILD.
 *
 * The main desktop chat runs pi as a spawned child, so the request body is only
 * assembled inside that child (buildChatCompletionsRequest). This module registers
 * ONE `before_provider_request` handler there that does two things on every turn:
 *
 *   1. SAMPLING — stamps the user's per-request sampling overrides (temperature,
 *      top_p, …) onto the outgoing body, so a slider change takes effect on the
 *      NEXT turn with no relaunch. Overrides are read from a small JSON file the
 *      main process rewrites on every settings change (path via env), mtime-cached
 *      so the hot path doesn't re-read on every request. Sampling fields are body
 *      params, NOT prompt text, so stamping them never disturbs the KV/prefix cache.
 *
 *   2. GROUND TRUTH — captures the EXACT system prompt + tool defs + messages the
 *      model is about to receive and pushes them to the renderer over the existing
 *      `ctx.ui.setStatus` seam (same channel the harness uses for prefill/plan), so
 *      the panel shows what pi actually assembled rather than a reconstruction.
 *
 * Pure helpers are exported for unit tests; the file read + registration are the
 * only impure parts.
 */
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

/**
 * setStatus key the panel reads (via pi-slice `extensionStatus`). Kept in sync
 * with the renderer literal in apps/desktop/src/state/advanced-store.ts.
 */
export const ADVANCED_GROUNDTRUTH_KEY = 'advanced-params-groundtruth';

/** Per-request sampling overrides (camelCase mirror of the desktop settings). */
export interface SamplingOverride {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repetitionPenalty?: number;
  presencePenalty?: number;
  /** 0 / absent = leave `max_tokens` unset (use the model/server default). */
  maxTokens?: number;
}

/** The captured ground-truth shape pushed to the renderer (JSON-stringified). */
export interface GroundTruthPayload {
  systemPrompt: string;
  tools: Array<{ name: string; description?: string; parameters?: unknown }>;
  messages: Array<Record<string, unknown>>;
  model: string;
}

/**
 * Stamp sampling overrides onto an OpenAI-shaped chat body IN PLACE, using the
 * llama.cpp/OpenAI field names. Undefined fields are skipped so the server/CLI
 * default stands; `maxTokens` of 0 is treated as "unset". Returns the same body.
 */
export function applySamplingOverride(
  body: Record<string, unknown>,
  o: SamplingOverride | null,
): Record<string, unknown> {
  if (o === null) return body;
  if (o.temperature !== undefined) body.temperature = o.temperature;
  if (o.topP !== undefined) body.top_p = o.topP;
  if (o.topK !== undefined) body.top_k = o.topK;
  if (o.minP !== undefined) body.min_p = o.minP;
  if (o.repetitionPenalty !== undefined) body.repeat_penalty = o.repetitionPenalty;
  if (o.presencePenalty !== undefined) body.presence_penalty = o.presencePenalty;
  if (o.maxTokens !== undefined && o.maxTokens > 0) body.max_tokens = o.maxTokens;
  return body;
}

/**
 * Pull the ground truth out of an OpenAI-shaped chat body. Returns null when the
 * payload isn't a chat body (e.g. a non-llamacpp provider) so the hook stays a
 * safe no-op there.
 */
export function extractGroundTruth(payload: unknown): GroundTruthPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;
  const first = messages[0] as Record<string, unknown> | undefined;
  const systemPrompt =
    first !== undefined && first.role === 'system' && typeof first.content === 'string'
      ? first.content
      : '';
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const tools = rawTools.map((t) => {
    const fn = (t as { function?: Record<string, unknown> }).function ?? {};
    return {
      name: typeof fn.name === 'string' ? fn.name : '(unnamed)',
      description: typeof fn.description === 'string' ? fn.description : undefined,
      parameters: fn.parameters,
    };
  });
  return {
    systemPrompt,
    tools,
    messages: messages as Array<Record<string, unknown>>,
    model: typeof body.model === 'string' ? body.model : '',
  };
}

/** An mtime-cached reader for the sampling-override file (main rewrites it). */
export function createSamplingReader(
  filePath: string | undefined,
  deps: { readFile?: typeof readFileSync; stat?: typeof statSync } = {},
): () => SamplingOverride | null {
  const readFile = deps.readFile ?? readFileSync;
  const stat = deps.stat ?? statSync;
  let cachedMtime = -1;
  let cached: SamplingOverride | null = null;
  return () => {
    if (filePath === undefined) return null;
    try {
      const mtime = stat(filePath).mtimeMs;
      if (mtime === cachedMtime) return cached;
      cached = JSON.parse(String(readFile(filePath, 'utf8'))) as SamplingOverride;
      cachedMtime = mtime;
      return cached;
    } catch {
      // Missing/corrupt file → no overrides (server CLI defaults stand).
      return null;
    }
  };
}

/**
 * Register the advanced-params `before_provider_request` hook on the child pi.
 * `samplingFilePath` (from env, set by the desktop main) points at the override
 * file; absent → sampling is left to the server defaults but ground truth is
 * still captured.
 */
export function registerAdvancedParamsHook(
  pi: ExtensionAPI,
  opts: { samplingFilePath?: string; readSampling?: () => SamplingOverride | null } = {},
): void {
  const readSampling = opts.readSampling ?? createSamplingReader(opts.samplingFilePath);
  pi.on('before_provider_request', (e, ctx) => {
    const payload = e.payload;
    if (typeof payload !== 'object' || payload === null) return payload;
    const body = payload as Record<string, unknown>;
    applySamplingOverride(body, readSampling());
    const gt = extractGroundTruth(body);
    // Diagnostic (off by default): with PI_ADV_DEBUG_TOOLS set to a file path,
    // append the ACTIVE tool names the model is actually being sent each request.
    // The ground truth for "does the model know all tools or only its preset?".
    const dbg = process.env.PI_ADV_DEBUG_TOOLS;
    if (dbg !== undefined && dbg.length > 0 && gt !== null) {
      try {
        const names = gt.tools.map((t) => t.name);
        // The exact active tool set + system-prompt size the model receives — the
        // reproducer for "does the model know only its initial tools?". Set
        // PI_ADV_DEBUG_TOOLS to a file path to capture it per request.
        appendFileSync(
          dbg,
          `tools[${names.length}] sysPromptChars=${gt.systemPrompt.length}: ${names.join(', ')}\n`,
        );
      } catch {
        // never break a turn for a diagnostic write.
      }
    }
    if (gt !== null && ctx.hasUI === true) {
      try {
        ctx.ui.setStatus(ADVANCED_GROUNDTRUTH_KEY, JSON.stringify(gt));
      } catch {
        // A status push must never break a turn.
      }
    }
    return body;
  });
}
