/**
 * The "call a model" seam.
 *
 * Several reliability features need a utility model: the rung-2 tool-call fixer,
 * the reviewer/adversarial passes, and the tier-2 classifier escalation. pi's
 * ExtensionAPI exposes no one-shot completion call, so this module defines a
 * small injectable {@link CallModel} async seam plus a default implementation
 * that hits any OpenAI-compatible `/chat/completions` endpoint.
 *
 * ## What the app injects (zero code, env only)
 * The desktop app loads the harness via `-e src/index.ts` (no way to pass a
 * function), and already configures other extensions through env vars. So the
 * utility endpoint is configured the same way — {@link callModelFromEnv} reads:
 *
 *   - `PI_DESKTOP_UTILITY_BASE_URL`  openai-compat base, e.g. the local
 *                                    llama-server (`http://127.0.0.1:PORT/v1`)
 *                                    or a separate small model. NO default —
 *                                    absent ⇒ every model-dependent feature
 *                                    degrades gracefully (fixer skipped, review
 *                                    skipped, classify stays heuristic-only).
 *   - `PI_DESKTOP_UTILITY_MODEL`     model id (default `"utility"`).
 *   - `PI_DESKTOP_UTILITY_API_KEY`   optional bearer token.
 *
 * A programmatic caller (or a future app-bridge) can instead pass a custom
 * `callModel` to `wireHarness(pi, { callModel })`.
 */

/** A single utility-model request. Supply `prompt`, or `messages`, or both. */
export interface CallModelRequest {
  /** Optional system instruction prepended to the message list. */
  readonly system?: string;
  /** A single user prompt (appended after `messages`). */
  readonly prompt?: string;
  /** Explicit multi-turn messages. */
  readonly messages?: readonly {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
  }[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/** Call a model and get its text back. Throws on transport/HTTP failure. */
export type CallModel = (req: CallModelRequest) => Promise<string>;

export interface OpenAiCompatConfig {
  /** Base URL, e.g. `http://127.0.0.1:8080/v1`. Trailing slash tolerated. */
  readonly baseUrl: string;
  /** Model id sent in the request body. */
  readonly model: string;
  /** Optional bearer token. */
  readonly apiKey?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Build a {@link CallModel} that POSTs to an OpenAI-compatible chat endpoint. */
export function createOpenAiCompatCallModel(config: OpenAiCompatConfig): CallModel {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  return async (req) => {
    const messages: { role: string; content: string }[] = [];
    if (req.system !== undefined) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages ?? []) messages.push({ role: m.role, content: m.content });
    if (req.prompt !== undefined) messages.push({ role: 'user', content: req.prompt });

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiKey !== undefined && config.apiKey.length > 0) {
      headers.authorization = `Bearer ${config.apiKey}`;
    }
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        temperature: req.temperature ?? 0,
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`utility model HTTP ${res.status}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return json.choices?.[0]?.message?.content ?? '';
  };
}

/** Env var the app sets to point at the utility/fixer model endpoint. */
export const UTILITY_BASE_URL_ENV = 'PI_DESKTOP_UTILITY_BASE_URL';
/** Env var for the utility model id. */
export const UTILITY_MODEL_ENV = 'PI_DESKTOP_UTILITY_MODEL';
/** Env var for an optional bearer token. */
export const UTILITY_API_KEY_ENV = 'PI_DESKTOP_UTILITY_API_KEY';

/**
 * Build the default {@link CallModel} from env config, or `undefined` when no
 * base URL is set (so callers degrade to heuristic-only behavior). Never
 * hardcodes a URL.
 */
export function callModelFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): CallModel | undefined {
  const baseUrl = env[UTILITY_BASE_URL_ENV];
  if (baseUrl === undefined || baseUrl.length === 0) return undefined;
  const model = env[UTILITY_MODEL_ENV] ?? 'utility';
  const apiKey = env[UTILITY_API_KEY_ENV];
  return createOpenAiCompatCallModel({ baseUrl, model, apiKey, fetchImpl });
}
