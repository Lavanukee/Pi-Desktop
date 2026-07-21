/**
 * The corp ROLE-AGENT RUNTIME — runs ONE corp role as a scoped, headless pi
 * {@link AgentSession} (a real harness with file tools + a bash tool), rather
 * than the bare single-`/chat/completions` seam ({@link createLlamaCorpChat}).
 *
 * WHY: the bare completion path lets qwen "overthink" — a judgment/coding turn
 * runs away, emitting thousands of reasoning tokens with no file to show for it.
 * Wrapping the role in an agentic loop with tools + owner-tuned sampling + a
 * thinking-strip context hook + a hard step-cap + a timeout backstop eliminates
 * the runaway (validated in scratchpad/harness-modtest-spike.mjs: max turn
 * ~1.3k tok, no runaway, files written via tools).
 *
 * ELECTRON-MAIN ONLY (Node). This value-imports the pi SDK, which is fine here
 * (the RENDERER-BARREL rule forbids the renderer value-importing the harness/pi
 * runtime, not main). It is ELECTRON-FREE: it never imports `electron`, so the
 * pure bits (sampling-mode merge, result shaping, step-cap counter) are
 * unit-testable, and the AgentSession run is covered by the real-server smoke.
 *
 * This module is ADDITIVE: it does NOT touch the app's llamacpp-stream provider (it
 * registers its OWN in-process `corp-local` provider under a distinct api, running
 * provider-llamacpp's custom streamSimple so it gets the SAME tool-call repair ladder
 * as the normal chat while its `before_provider_request`/`after_provider_response`
 * hooks still carry the owner's sampling + the per-call hang watchdog — see
 * {@link createCorpModelProvider}).
 *
 * Kept as a SINGLE FILE (types + impl) with no relative value-imports so the
 * real-server smoke can load it directly under Node's TS type-stripping.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// TYPE-ONLY import of the pi SDK — erased at build, so it emits NO runtime code.
// `AuthStorage`/`ModelRegistry` double as VALUE constructors; they are pulled from
// the dynamic loader below at runtime, and named here only for the type positions
// (the `CorpModelHandle` shape + the `CorpModel` alias). The other value symbols
// (`createAgentSession`, `DefaultResourceLoader`, `SessionManager`, `SettingsManager`)
// are used as values ONLY, so they live solely on the dynamic loader.
import type {
  AuthStorage,
  BeforeProviderRequestEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionFactory,
  ModelRegistry,
  SessionStats,
  ToolCallEvent,
  ToolDefinition,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
} from '@mariozechner/pi-coding-agent';
// Type-only: the corp turn taxonomy + the neutral live-activity record (both
// stripped at runtime, so no cross-package value import — keeps this file loadable
// under Node TS type-stripping).
import type { CorpTurnPurpose, RoleAgentActivity } from '@pi-desktop/harness/corp';
// The rule-based scary-bash DENYLIST — the SAME deterministic checker the SOLO
// agent registers (harness permissions/rules.ts). Value-imported from the
// STANDALONE `./permissions` subpath, which resolves to the zero-dependency
// rules module: it stays loadable under the smoke's Node TS type-stripping AND
// can never drag in the LLM flagger (flag-bash.ts) or the mode wiring. Spec §9:
// the permissions default is a static denylist flagged BY RULE — no LLM reviewer
// in the loop.
import { checkScaryBash } from '@pi-desktop/harness/permissions';

// ---------------------------------------------------------------------------
// LAZY pi-SDK loader — the boot-crash fix.
// ---------------------------------------------------------------------------

/**
 * Load the pi SDK via a cached dynamic `import()`. `@mariozechner/pi-coding-agent`
 * is ESM-only (`"type":"module"`, and its `exports` define ONLY the `import`
 * condition — NO `require`). The packaged electron-main bundle is CJS, so a STATIC
 * value import would compile to `require('@mariozechner/pi-coding-agent')`, which at
 * boot throws `ERR_PACKAGE_PATH_NOT_EXPORTED` → "App threw an error during load" →
 * NO WINDOW. A dynamic `import()` loads the ESM package from CJS at runtime instead
 * (Node supports `import()` from CJS), and the SDK stays EXTERNAL (never bundled).
 * The promise is cached so the module resolves once and is shared across every run.
 */
type PiModule = typeof import('@mariozechner/pi-coding-agent');
let _pi: Promise<PiModule> | undefined;
const loadPi = (): Promise<PiModule> => (_pi ??= import('@mariozechner/pi-coding-agent'));

// ---------------------------------------------------------------------------
// Sampling modes — the owner's qwen params, keyed by role behaviour.
// ---------------------------------------------------------------------------

/** The four owner-tuned qwen sampling profiles a role can run under. */
export type SamplingMode =
  | 'thinking-coding'
  | 'thinking-general'
  | 'instruct-general'
  | 'instruct-reasoning';

/** The exact generation params one sampling mode sends to the server. */
export interface SamplingParams {
  readonly temperature: number;
  readonly top_p: number;
  readonly top_k: number;
  readonly min_p: number;
  readonly presence_penalty: number;
  readonly repetition_penalty: number;
  /** DRY sequence-repetition penalty (jedd anti-loop set). 0 multiplier = off. */
  readonly dry_multiplier: number;
  readonly dry_base: number;
  readonly dry_allowed_length: number;
  readonly dry_penalty_last_n: number;
}

/**
 * The DRY sampler settings shared by every role (jedd, 2026-07-20): the targeted
 * anti-repetition/anti-loop tool. multiplier 1 (on), base 1.75 (>1.6), allowed
 * length 70 (short/structural repeats like `}`/`];` untouched), penalty last-n
 * 4096 (covers the last several reasoning + tool-use activities). Applied on top
 * of each role's temp/top-p/top-k so a role can loop-break without cranking temp.
 */
const DRY = {
  dry_multiplier: 1.0,
  dry_base: 1.75,
  dry_allowed_length: 70,
  dry_penalty_last_n: 4096,
} as const;

/**
 * The owner's qwen sampling params, verbatim. These are llama.cpp OpenAI-compat
 * extras (`top_k`/`min_p`/`repetition_penalty`/`dry_*` are non-standard) merged
 * onto the outgoing request body by the `before_provider_request` hook. top_k
 * widened to 50 (>40) and top_p tightened to 0.9 (<0.92) across the board — the
 * anti-repetition pool jedd specified — with DRY layered on every profile.
 */
export const SAMPLING_MODES: Record<SamplingMode, SamplingParams> = {
  'thinking-general': {
    temperature: 1.0,
    top_p: 0.9,
    top_k: 50,
    min_p: 0.0,
    presence_penalty: 1.5,
    repetition_penalty: 1.0,
    ...DRY,
  },
  'thinking-coding': {
    // Coding keeps its deliberately-low temp for determinism; DRY (not temp) is
    // what breaks its repetition, so correctness isn't traded away.
    temperature: 0.6,
    top_p: 0.9,
    top_k: 50,
    min_p: 0.0,
    presence_penalty: 0.0,
    repetition_penalty: 1.0,
    ...DRY,
  },
  'instruct-general': {
    temperature: 0.7,
    top_p: 0.8,
    top_k: 50,
    min_p: 0.0,
    presence_penalty: 1.5,
    repetition_penalty: 1.0,
    ...DRY,
  },
  'instruct-reasoning': {
    temperature: 1.0,
    top_p: 0.9,
    top_k: 50,
    min_p: 0.0,
    presence_penalty: 1.5,
    repetition_penalty: 1.0,
    ...DRY,
  },
};

/**
 * Merge one sampling mode's params onto a provider request payload IN PLACE and
 * return it (the `before_provider_request` handler returns the payload to
 * replace it). Non-object payloads pass through untouched. Pure + unit-tested.
 */
export function applySamplingMode(payload: unknown, mode: SamplingMode): unknown {
  if (payload === null || typeof payload !== 'object') return payload;
  const p = payload as Record<string, unknown>;
  const params = SAMPLING_MODES[mode];
  p.temperature = params.temperature;
  p.top_p = params.top_p;
  p.top_k = params.top_k;
  p.min_p = params.min_p;
  p.presence_penalty = params.presence_penalty;
  p.repetition_penalty = params.repetition_penalty;
  // DRY sequence-repetition penalty (llama.cpp OpenAI-compat extras) — the
  // anti-loop set jedd specified, carried on every corp role request.
  p.dry_multiplier = params.dry_multiplier;
  p.dry_base = params.dry_base;
  p.dry_allowed_length = params.dry_allowed_length;
  p.dry_penalty_last_n = params.dry_penalty_last_n;
  return p;
}

// ---------------------------------------------------------------------------
// Pure helpers for the context / step-cap / result-shaping hooks.
// ---------------------------------------------------------------------------

/** A minimal structural message shape the thinking-strip hook operates on. */
export interface StripMessage {
  readonly role?: string;
  readonly content?: unknown;
}

function isThinkingBlock(block: unknown): boolean {
  return (
    typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'thinking'
  );
}

/**
 * Strip prior `type:'thinking'` blocks from assistant messages (preserve-thinking
 * OFF): the model never re-reads its own scratchpad, which is a large part of why
 * the loop stops running away. Only strips when some non-thinking content remains
 * (never empties a message). Returns the rewritten list + how many blocks fell.
 * Pure + unit-tested.
 */
export function stripPriorThinking(messages: readonly StripMessage[]): {
  messages: StripMessage[];
  strippedBlocks: number;
} {
  let strippedBlocks = 0;
  const out = messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const kept = m.content.filter((b) => !isThinkingBlock(b));
    const removed = m.content.length - kept.length;
    if (removed > 0 && kept.length > 0) {
      strippedBlocks += removed;
      return { ...m, content: kept };
    }
    return m;
  });
  return { messages: out, strippedBlocks };
}

/** A blocking decision from the step-cap, or `undefined` to allow the call. */
export interface StepCapBlock {
  readonly block: true;
  readonly reason: string;
}

/** The step-cap counter's live state (read after the run for `terminatedReason`). */
export interface StepCapCounter {
  /** Charge one tool call; returns a block decision once past `maxSteps`. */
  charge(): StepCapBlock | undefined;
  /** How many calls have been charged. */
  readonly count: number;
  /** Whether the cap was ever hit. */
  readonly hit: boolean;
}

/**
 * Count tool calls and refuse them past `maxSteps` (a hard stop on a model that
 * keeps calling tools forever). Pure closure — unit-tested. Default cap 20.
 */
export function createStepCapCounter(maxSteps = 20): StepCapCounter {
  let count = 0;
  let hit = false;
  return {
    charge(): StepCapBlock | undefined {
      count += 1;
      if (count > maxSteps) {
        hit = true;
        return { block: true, reason: `step cap (${maxSteps}) reached` };
      }
      return undefined;
    },
    get count(): number {
      return count;
    },
    get hit(): boolean {
      return hit;
    },
  };
}

/**
 * The rule-based bash DENYLIST gate (spec §9). Returns a {@link StepCapBlock}
 * REFUSAL when a `bash` tool call's command matches the shared scary-bash
 * denylist ({@link checkScaryBash} — the SAME deterministic regex/substring rules
 * the solo agent uses, with NO LLM reviewer anywhere in the path), or `undefined`
 * to allow the call through untouched. Non-`bash` tools always pass. The `command`
 * is read from the bash tool's args (`input.command`); a missing/non-string
 * command degrades to the empty string (which the denylist treats as safe).
 *
 * Pure + synchronous (there is no model call — a returned decision is proof the
 * gate is rule-based) and unit-tested. Wired into `corpExt`'s `tool_call` handler
 * so EVERY corp role-agent that has `bash` (engineers, reviewers, CEO, consults)
 * is gated the same way, and the flagged command NEVER executes.
 */
export function bashDenylistGate(toolName: string, input: unknown): StepCapBlock | undefined {
  if (toolName !== 'bash') return undefined;
  const command =
    input !== null &&
    typeof input === 'object' &&
    typeof (input as { command?: unknown }).command === 'string'
      ? (input as { command: string }).command
      : '';
  const reason = checkScaryBash(command);
  return reason !== null ? { block: true, reason: `blocked by denylist: ${reason}` } : undefined;
}

/** One captured tool call the model made (esp. custom-tool / promotion calls). */
export interface RoleAgentToolCall {
  readonly name: string;
  /** The tool arguments (an object, or a raw JSON string for legacy shapes). */
  readonly arguments: Record<string, unknown> | string;
}

/** One file the role wrote (a `write`/`edit` tool call whose target now exists). */
export interface RoleAgentFile {
  readonly path: string;
  readonly bytes: number;
}

function argsRecord(args: RoleAgentToolCall['arguments']): Record<string, unknown> | undefined {
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return args;
}

function toolCallPath(args: RoleAgentToolCall['arguments']): string | undefined {
  const rec = argsRecord(args);
  if (rec === undefined) return undefined;
  const raw = rec.path ?? rec.file_path;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Collapse a shell command to a compact one-line summary for a live readout:
 * first non-blank line, whitespace squeezed, clipped to `max` chars. Pure. */
export function summarizeCommand(command: string, max = 60): string {
  const line =
    command
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const squeezed = line.replace(/\s+/g, ' ');
  return squeezed.length > max ? `${squeezed.slice(0, max - 1)}…` : squeezed;
}

/** Recent-tail cap for a captured bash result (~8KB) — a noisy build streams a lot,
 * but the live terminal mirror only needs its tail, and the event must stay small. */
export const BASH_OUTPUT_CAP = 8 * 1024;

/** Join a tool result's content blocks into plain text (drops image blocks), then
 * clip to the last {@link BASH_OUTPUT_CAP} chars with a note. Pure; never throws. */
export function toolResultText(content: ToolResultEvent['content']): string {
  const joined = content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  if (joined.length <= BASH_OUTPUT_CAP) return joined;
  const hidden = joined.length - BASH_OUTPUT_CAP;
  return `…(${hidden} earlier chars hidden)\n${joined.slice(-BASH_OUTPUT_CAP)}`;
}

/**
 * Extract the SHORT human arg summary + file path from a tool call's arguments at
 * the `tool_call` boundary, so the live transcript can name the ACTUAL work: a
 * web_search's query, a bash command summary, a grep pattern, a read's file. Pure
 * + best-effort — an unrecognized tool falls back to its most meaningful primary
 * arg (query / path / url / name), or nothing. The human VERB ("Searched the
 * web") is left to the coordination layer; this only surfaces the raw detail the
 * args carry. Never throws.
 */
export function toolCallDetail(
  toolName: string,
  input: unknown,
): { detail?: string; path?: string } {
  const rec = argsRecord(input as RoleAgentToolCall['arguments']) ?? {};
  const s = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  const path = toolCallPath(input as RoleAgentToolCall['arguments']);
  switch (toolName) {
    case 'read':
    case 'cat':
    case 'view':
      return path !== undefined ? { path, detail: path } : {};
    case 'web_search':
    case 'search':
    case 'search_web': {
      const q = s(rec.query) ?? s(rec.q);
      return q !== undefined ? { detail: q } : {};
    }
    case 'web_fetch':
    case 'fetch': {
      const u = s(rec.url) ?? s(rec.href) ?? s(rec.link);
      return u !== undefined ? { detail: u } : {};
    }
    case 'bash':
    case 'shell':
    case 'run':
    case 'exec': {
      const cmd = s(rec.command) ?? s(rec.cmd) ?? s(rec.script);
      return cmd !== undefined ? { detail: summarizeCommand(cmd) } : {};
    }
    case 'grep':
    case 'find':
    case 'glob':
    case 'rg': {
      const pat = s(rec.pattern) ?? s(rec.query) ?? s(rec.q);
      return pat !== undefined ? { detail: pat } : {};
    }
    default: {
      const prim = s(rec.query) ?? s(rec.q) ?? path ?? s(rec.url) ?? s(rec.name) ?? s(rec.title);
      return prim !== undefined ? { detail: prim } : {};
    }
  }
}

/**
 * Shape the files-written result from captured `write`/`edit` tool calls, using
 * an injected `statBytes` (so it is pure + unit-testable from mock events). The
 * path is resolved against `cwd`; a call whose target cannot be stat'd is
 * dropped; the last write to a path wins. Reported paths stay as the model
 * addressed them (relative to `cwd` when relative).
 */
export function collectFilesWritten(
  calls: readonly RoleAgentToolCall[],
  statBytes: (absPath: string) => number | undefined,
  cwd: string,
): RoleAgentFile[] {
  const byPath = new Map<string, number>();
  for (const call of calls) {
    if (call.name !== 'write' && call.name !== 'edit') continue;
    const rel = toolCallPath(call.arguments);
    if (rel === undefined) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    const bytes = statBytes(abs);
    if (bytes === undefined) continue;
    byPath.set(rel, bytes);
  }
  return [...byPath.entries()].map(([p, bytes]) => ({ path: p, bytes }));
}

/**
 * Build a LIVE {@link RoleAgentActivity} `file-write` record from a finished
 * `write`/`edit` tool execution — the moment the file exists, so the situation
 * room can light the map MID-work. Returns `undefined` for a non-file tool or a
 * call with no target path. Pure aside from the injected `statBytes` (so it is
 * unit-testable from mock events): the path is reported AS the model addressed it
 * (relative to `cwd` when relative — that IS the product-tree slot), the byte
 * size is stat'd off `cwd`, and `linesAdded` is counted from the write content
 * when present. Never throws.
 */
export function fileWriteActivity(
  toolName: string,
  args: unknown,
  cwd: string,
  statBytes: (absPath: string) => number | undefined,
): RoleAgentActivity | undefined {
  if (toolName !== 'write' && toolName !== 'edit') return undefined;
  const rec = argsRecord(args as RoleAgentToolCall['arguments']);
  const rel = toolCallPath(args as RoleAgentToolCall['arguments']);
  if (rel === undefined) return undefined;
  const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
  const bytes = statBytes(abs);
  // The new file body, when the write tool carried it (write: `content`; edit:
  // the replacement text) — used only for the live +N line readout.
  const body =
    rec !== undefined
      ? typeof rec.content === 'string'
        ? rec.content
        : typeof rec.new_text === 'string'
          ? rec.new_text
          : typeof rec.text === 'string'
            ? rec.text
            : undefined
      : undefined;
  const linesAdded = body !== undefined ? body.split('\n').length : undefined;
  return {
    kind: 'file-write',
    toolName,
    path: rel,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(linesAdded !== undefined ? { linesAdded } : {}),
    // Carry the WHOLE written body on the record's generic `text` field (the
    // structured-write completion has the full file) so coordination can thread it
    // to the live file canvas — the tab renders the ACTUAL content, not a blank
    // peek. Reuses the existing field; no new activity shape.
    ...(body !== undefined ? { text: body } : {}),
  };
}

/** Why the role-agent run ended. */
export type RoleTerminatedReason = 'stop' | 'step-cap' | 'timeout' | 'error';

/**
 * Collapse the backstop flags into one terminal reason. Timeout wins (an abort
 * usually also surfaces a prompt error), then the step-cap, then a genuine
 * error, else a clean stop. Pure + unit-tested.
 */
export function deriveTerminatedReason(flags: {
  timedOut: boolean;
  stepCapHit: boolean;
  promptError: boolean;
}): RoleTerminatedReason {
  if (flags.timedOut) return 'timeout';
  if (flags.stepCapHit) return 'step-cap';
  if (flags.promptError) return 'error';
  return 'stop';
}

/**
 * The LIVE-activity records to emit when a run ends ABNORMALLY — a per-call
 * network abort / watchdog timeout ({@link timedOut}) or a thrown/aborted prompt
 * ({@link promptError}). A hung/aborted/errored call CUTS the model stream, so the
 * provider's `thinking_end` / `text_end` / `turn_end` never fire and the pane's
 * live line (a "Thinking…" block or a streaming message) would stay frozen
 * `streaming:true` until the whole task ends. Emitting a synthetic `turn-end`
 * settles any OPEN streaming line for the node — exactly the record a clean
 * `turn_end` emits, which the coordination layer maps to `closeStream` (its live
 * flag off). Fabricates NO content. Returns [] on a clean stop (the real end
 * events already settled the line). Pure + unit-tested. */
export function settleActivitiesOnEnd(flags: {
  readonly promptError: boolean;
  readonly timedOut: boolean;
}): RoleAgentActivity[] {
  return flags.promptError || flags.timedOut ? [{ kind: 'turn-end' }] : [];
}

/** A minimal structural message shape for turn/token roll-ups. */
interface UsageMessage {
  readonly role?: string;
  readonly usage?: { readonly output?: number };
}

/** Count assistant turns in the final message list. Pure. */
export function countAssistantTurns(messages: readonly UsageMessage[]): number {
  return messages.filter((m) => m.role === 'assistant').length;
}

/**
 * The largest single-turn output-token count across assistant turns — the
 * runaway detector (the smoke asserts this stays well under the context). Pure.
 */
export function maxTurnOutputTokens(messages: readonly UsageMessage[]): number {
  let max = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const out = m.usage?.output ?? 0;
    if (out > max) max = out;
  }
  return max;
}

// ---------------------------------------------------------------------------
// createCorpModelProvider — the in-process keyless local provider + model.
// ---------------------------------------------------------------------------

/** A resolved corp model + the registry/auth it lives in, passed to runs. */
export interface CorpModelHandle {
  readonly registry: ModelRegistry;
  readonly auth: AuthStorage;
  readonly model: CorpModel;
}

/** The concrete resolved-model type, derived without importing pi-ai directly. */
type CorpModel = NonNullable<ReturnType<ModelRegistry['find']>>;

/** Config for {@link createCorpModelProvider}. */
export interface CorpModelProviderConfig {
  /** OpenAI-compat base URL ending in `/v1` (the local llama-server). */
  readonly baseUrl: string;
  /** The served model id. */
  readonly model: string;
  /** Context window to advertise (default 16384, matching the corp server). */
  readonly contextWindow?: number;
  /** Max output tokens to advertise (default 8192). */
  readonly maxTokens?: number;
  /**
   * INJECTABLE fetch (tests only). Threaded into `createLlamaCppStream`'s
   * `deps.fetchImpl` so a unit test can feed a mock SSE `ReadableStream` (and
   * capture the outgoing request body) without a live llama-server. Absent → the
   * provider's default global `fetch` (production).
   */
  readonly fetchImpl?: typeof fetch;
}

/** The registered provider name — corp-local, distinct from the app provider. */
export const CORP_LOCAL_PROVIDER = 'corp-local';

/**
 * The pi `api` the corp's `streamSimple` registers under. DISTINCT from the app's
 * `llamacpp-stream` (provider-llamacpp/index.ts) on purpose: pi-ai's api registry is
 * a MODULE-GLOBAL `Map` keyed by the `api` string (last-write-wins), so reusing
 * `llamacpp-stream` here could clobber the normal chat's handler if both ever share
 * a process. A unique id binds the corp's handler to ONLY the corp's model.
 */
export const CORP_LOCAL_API = 'corp-local-stream';

const DEFAULT_CONTEXT_WINDOW = 16384;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Build a fresh in-memory {@link AuthStorage} + {@link ModelRegistry} and register
 * a keyless `corp-local` provider against `baseUrl`, then resolve the model.
 *
 * The provider runs provider-llamacpp's custom `streamSimple` ({@link
 * createLlamaCppStream}) — the SAME tool-call repair ladder the normal chat uses, so
 * a call the model writes as raw `<tool_call>` XML in its content is salvaged (RUNG 0)
 * into a STRUCTURED, executed call instead of rendering as inert text. It registers
 * under a DISTINCT api ({@link CORP_LOCAL_API}) so it can never clobber the app's
 * `llamacpp-stream` handler in pi-ai's module-global api registry.
 *
 * The owner's per-purpose sampling AND the per-call hang watchdog are NOT lost: they
 * still ride `corpExt`'s `before_provider_request` / `after_provider_response` hooks
 * (see {@link runRoleAgent}), which `createLlamaCppStream` now fires via pi's
 * `onPayload` / `onResponse` seam — so sampling is merged onto the outgoing body and
 * the watchdog is armed/disarmed exactly as before, per SESSION (concurrency-safe;
 * each role's session carries its own hooks). The model keeps `apiKey:'none'` keyless
 * auth and `compat.thinkingFormat:'qwen-chat-template'`.
 */
export async function createCorpModelProvider(
  config: CorpModelProviderConfig,
): Promise<CorpModelHandle> {
  const { AuthStorage, ModelRegistry } = await loadPi();
  const auth = AuthStorage.inMemory();
  const registry = ModelRegistry.create(auth);
  registry.registerProvider(CORP_LOCAL_PROVIDER, {
    baseUrl: config.baseUrl,
    apiKey: 'none',
    // Stock `openai-completions` handler (in pi-ai, loaded via pi-coding-agent).
    // NB the RUNG-0 tool-call EXECUTION repair (provider-llamacpp/createLlamaCppStream)
    // was reverted: bundling provider-llamacpp (source-only, ESM) into the CJS main
    // dead-ended pi-ai at runtime (empty turns). Tool-call-as-text still renders as a
    // proper activity via the renderer-side reconstruction; execution-repair needs a
    // runtime-viable approach (deferred).
    api: 'openai-completions',
    models: [
      {
        id: config.model,
        name: 'Corp Local',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        compat: { thinkingFormat: 'qwen-chat-template' },
      },
    ],
  });
  // Belt-and-suspenders for the keyless streamFn (the SDK still resolves a request
  // key via getApiKeyAndHeaders before dispatching, even when the endpoint needs none).
  auth.setRuntimeApiKey(CORP_LOCAL_PROVIDER, 'none');
  const model = registry.find(CORP_LOCAL_PROVIDER, config.model);
  if (model === undefined) {
    throw new Error(
      `createCorpModelProvider: model "${config.model}" not found after registering ${CORP_LOCAL_PROVIDER}`,
    );
  }
  return { registry, auth, model };
}

// ---------------------------------------------------------------------------
// runRoleAgent — run one role as a scoped AgentSession.
// ---------------------------------------------------------------------------

/** The inputs to one role-agent run. */
export interface RoleAgentConfig {
  /** The corp turn this role plays (or a free-form label). Recorded, not routed. */
  readonly purpose: CorpTurnPurpose | string;
  /** The role's system prompt (the resource loader's base system prompt). */
  readonly systemPrompt: string;
  /** The task/contract the role is asked to do (the first user turn). */
  readonly userPrompt: string;
  /** Built-in tool allowlist (e.g. `['read','write','edit','bash','grep','find','ls']`). */
  readonly tools: string[];
  /** Extra SDK custom tools (e.g. a promotion tool) registered for this run. */
  readonly customTools?: ToolDefinition[];
  /** The per-run workspace root (produced files land here). */
  readonly cwd: string;
  /** Whether the role runs with model "thinking" on. */
  readonly thinking: boolean;
  /** Which owner-tuned sampling profile to send every turn. */
  readonly samplingMode: SamplingMode;
  /** Optional per-turn output cap (sent as `max_tokens`/`max_completion_tokens`). */
  readonly maxTokens?: number;
  /** Optional hard cap on tool calls. UNSET → NO step cap: the role runs FULLY
   * autonomously (any tools, as much as it wants) until IT submits, bounded only by
   * the global RunBudget. The spec has no per-agent step cap; the seam never sets
   * this. Kept only for deterministic unit tests. */
  readonly maxSteps?: number;
  /** Per-individual-CALL network-abort (spec §197): the max time ONE provider HTTP
   * request may take to return a response before it is treated as a hung socket and
   * aborted (degraded to empty). This is a network-hang guard on a SINGLE request —
   * NOT a limit on how long or how much the agent works; a responding request clears
   * it immediately, and the agent then streams/works freely. Default 10 minutes. */
  readonly perCallTimeoutMs?: number;
  /**
   * BUMP-TO-CONTINUE (spec "Run safety & budgets" — the completeness backstop). When
   * set, after the agent's `prompt` loop ends, {@link BumpConfig.nextPrompt} is asked
   * whether to RE-PROMPT the SAME session to continue (returning the user turn to
   * append) or to stop (returning `undefined` — a terminal decision was reached),
   * bounded to {@link BumpConfig.maxBumps} re-prompts. This prevents a PREMATURE stop
   * (an engineer that quit without producing its deliverable); it is NOT a per-agent
   * work cap. Absent → the session runs once, exactly as before. */
  readonly bump?: BumpConfig;
  /**
   * Extra pi extension factories to install alongside the built-in `corpExt`
   * (sampling + thinking-strip + tool capture). The seam uses this to register the
   * web-tools extension (web_search / web_fetch) for the CEO vision turn — the
   * tools still only fire when their names are in {@link RoleAgentConfig.tools}, so
   * a role without them in its allowlist can never call them. Absent → just corpExt.
   */
  readonly extensionFactories?: ExtensionFactory[];
  /**
   * LIVE ACTIVITY sink (spec §11). When set, `corpExt` forwards this run's pi
   * lifecycle events as neutral {@link RoleAgentActivity} records the MOMENT they
   * happen: `turn-start`/`turn-end` (the per-turn node pulse) and, on each finished
   * `write`/`edit`, a `file-write` (the mid-work file-touch). Best-effort — a
   * throwing sink is swallowed so it can never break the run. Absent → nothing
   * streams (unchanged behaviour). */
  readonly onActivity?: (record: RoleAgentActivity) => void;
}

/** The BUMP-TO-CONTINUE policy for a run (see {@link RoleAgentConfig.bump}). */
export interface BumpConfig {
  /** Max times the SAME session is re-prompted to continue (spec bound: 2). */
  readonly maxBumps: number;
  /** Given the run's current final assistant text, return the user turn to append to
   * CONTINUE the same session, or `undefined` to stop (deliverable present, or a
   * terminal "unfulfillable" decision). */
  readonly nextPrompt: (ctx: { readonly finalText: string }) => string | undefined;
}

/** The recorded terminal state of one role-agent run. */
export interface RoleAgentResult {
  /** The final assistant text (empty string when there is none). */
  readonly finalText: string;
  /** Files the role wrote, via its `write`/`edit` tool calls. */
  readonly filesWritten: readonly RoleAgentFile[];
  /** Every tool call the role made (esp. custom-tool / promotion calls). */
  readonly toolCalls: readonly RoleAgentToolCall[];
  /** Session stats (`session.getSessionStats()`), or undefined if unavailable. */
  readonly stats: SessionStats | undefined;
  /** How many assistant turns ran. */
  readonly turns: number;
  /** BUMP-TO-CONTINUE: how many times the SAME session was re-prompted to continue
   * after ending without its deliverable (0 when none / no bump policy). */
  readonly bumps: number;
  /** Largest single-turn output tokens (the runaway detector). */
  readonly maxTurnOutputTokens: number;
  /** Why the run ended. */
  readonly terminatedReason: RoleTerminatedReason;
  /** How many provider requests the sampling hook stamped (proof it fired). */
  readonly samplingCalls: number;
  /** The sampling params the hook last sent (proof of what the server saw). */
  readonly sentSampling: SamplingParams | undefined;
}

const DEFAULT_PER_CALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run ONE corp role as a headless {@link AgentSession}: a `corpExt` extension
 * installs the owner's sampling on `before_provider_request`, strips prior thinking
 * on `context`, and captures `tool_call`s. The role runs FULLY AUTONOMOUSLY — any
 * tools, as much as it wants, for as long as it wants — until IT stops (its submit
 * tool) or the GLOBAL RunBudget (owned by the harness) stops the run. There is NO
 * per-agent step cap and NO per-agent total timeout. The ONLY per-run guard is a
 * per-individual-CALL network abort: a single provider HTTP request that fails to
 * return a response within `perCallTimeoutMs` is treated as a hung socket and the
 * session is aborted (degraded to empty) — a network-hang guard on ONE request, not
 * a limit on the agent's work (a responding request clears it, and generation then
 * streams freely). Never throws for a misbehaving model — a caught turn returns a
 * recorded {@link RoleAgentResult}. Disposes the session + its temp dir in `finally`.
 */
export async function runRoleAgent(
  handle: CorpModelHandle,
  config: RoleAgentConfig,
): Promise<RoleAgentResult> {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), 'corp-role-agent-'));

  // --- per-run capture state (closed over by corpExt) ---
  const toolCalls: RoleAgentToolCall[] = [];
  // A step cap ONLY when one is explicitly requested (tests) — the seam never sets
  // it, so a role normally runs uncapped until it submits / the global RunBudget.
  const stepCap = config.maxSteps !== undefined ? createStepCapCounter(config.maxSteps) : undefined;
  let samplingCalls = 0;
  let sentSampling: SamplingParams | undefined;

  // --- per-CALL network abort (the ONLY per-run guard) ---
  const perCallMs = config.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS;
  let callTimedOut = false;
  let callTimer: ReturnType<typeof setTimeout> | undefined;
  // Set after the session exists; the timer's abort closes over this holder.
  let sessionRef: { abort: () => void | Promise<void> } | undefined;
  const clearCallTimer = (): void => {
    if (callTimer !== undefined) {
      clearTimeout(callTimer);
      callTimer = undefined;
    }
  };

  // Live context reading for turn-boundary activity records: set once the session
  // exists (turn events only fire after that), read best-effort per emit. Percent
  // is 0..100 (or null right after compaction) — null/errors surface as undefined.
  let readContextPercent: () => number | undefined = () => undefined;

  const corpExt: ExtensionFactory = (pi: ExtensionAPI) => {
    // LIVE ACTIVITY sink (spec §11) — forward this run's tool/turn lifecycle AND the
    // model's live stream (streaming assistant text + reasoning) the MOMENT it
    // happens, so the situation room shows the model actually working, not "working…".
    // Best-effort + a no-op when no sink is wired: a throwing/absent sink can never
    // break the agent loop. Hoisted here so the `tool_call` gate (below) can name the
    // tool as it STARTS without a second handler racing the denylist return.
    const onActivity = config.onActivity;
    const emit = (record: RoleAgentActivity): void => {
      if (onActivity === undefined) return;
      try {
        onActivity(record);
      } catch {
        // a misbehaving sink can never break the agent loop
      }
    };

    // Owner-tuned sampling, merged onto every outgoing request body. This also arms
    // the per-CALL watchdog: THIS request must return a response within perCallMs or
    // it is a hung socket → abort. (A responding request clears the timer below.)
    pi.on('before_provider_request', (e: BeforeProviderRequestEvent) => {
      clearCallTimer();
      callTimer = setTimeout(() => {
        callTimedOut = true;
        void sessionRef?.abort();
      }, perCallMs);
      const payload = applySamplingMode(e.payload, config.samplingMode);
      if (payload !== null && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        if (config.maxTokens !== undefined) {
          p.max_tokens = config.maxTokens;
          p.max_completion_tokens = config.maxTokens;
        }
        samplingCalls += 1;
        sentSampling = { ...SAMPLING_MODES[config.samplingMode] };
      }
      return payload;
    });

    // The provider responded → this request is not a hung socket; disarm the guard
    // so the (legitimately long) response stream + the agent's work run unbounded.
    pi.on('after_provider_response', () => {
      clearCallTimer();
      return undefined;
    });

    // Preserve-thinking OFF: drop prior thinking blocks from outgoing context.
    pi.on('context', (e: ContextEvent) => {
      const { messages } = stripPriorThinking(e.messages as unknown as readonly StripMessage[]);
      return { messages: messages as unknown as ContextEvent['messages'] };
    });

    // Capture calls, enforce the rule-based bash DENYLIST (spec §9 — a
    // known-dangerous shell command is refused deterministically, NO LLM in the
    // loop, so the agent gets a refusal it can adapt to and the command NEVER
    // runs), then the step-cap ONLY when one was explicitly requested. This is the
    // SAME `tool_call` handler the live-activity forwarding and submit gates
    // compose around — the denylist gate slots in without clobbering the capture
    // sink or the step-cap.
    pi.on('tool_call', (e: ToolCallEvent) => {
      toolCalls.push({ name: e.toolName, arguments: e.input });
      // LIVE: name the tool the MOMENT it starts — the NAMED call + a short arg
      // summary (web_search → the query, read → the file, bash → the command) so
      // the transcript/feed show "Searching the web: …" / "Reading …" as the
      // CURRENT action, not a generic "Used a tool".
      if (e.toolName !== 'write' && e.toolName !== 'edit') {
        const { detail, path } = toolCallDetail(e.toolName, e.input);
        emit({
          kind: 'tool',
          toolName: e.toolName,
          ...(detail !== undefined ? { detail } : {}),
          ...(path !== undefined ? { path } : {}),
        });
      } else {
        // write/edit: the file is still being PRODUCED, but name it the moment the
        // call starts — a "Writing <path>" row + the canvas file tab opening
        // immediately (streaming) — instead of waiting for `tool_result`. A
        // phase:'start' file-write carries only the path (no line counts yet); the
        // paired `tool_result` adds the authoritative +N and settles the row.
        const startPath = toolCallPath(e.input as RoleAgentToolCall['arguments']);
        if (startPath !== undefined) {
          emit({ kind: 'file-write', toolName: e.toolName, path: startPath, phase: 'start' });
        }
      }
      const denied = bashDenylistGate(e.toolName, e.input);
      if (denied !== undefined) return denied;
      return stepCap?.charge();
    });

    // LIVE ACTIVITY (spec §11) — forward the run's turn/file lifecycle + the model's
    // live stream the MOMENT they happen so the situation room lights up mid-work.
    // Registered only when a sink is wired (avoids per-token overhead otherwise).
    if (onActivity !== undefined) {
      // Turn boundaries carry the session's live context fullness (when readable)
      // so the app's context ring fills from the RUN's real usage.
      pi.on('turn_start', (e: TurnStartEvent) => {
        const contextPercent = readContextPercent();
        emit({
          kind: 'turn-start',
          turnIndex: e.turnIndex,
          ...(contextPercent !== undefined ? { contextPercent } : {}),
        });
      });
      pi.on('turn_end', (e: TurnEndEvent) => {
        const contextPercent = readContextPercent();
        emit({
          kind: 'turn-end',
          turnIndex: e.turnIndex,
          ...(contextPercent !== undefined ? { contextPercent } : {}),
        });
      });
      // A finished write/edit → the file now exists → a file-touch record (the
      // moment to light the file map). Non-file tools already streamed at
      // `tool_call` (start), so they are NOT re-emitted here. `tool_result` fires
      // after execution and carries the tool args (`input`) + `isError`.
      pi.on('tool_result', (e: ToolResultEvent) => {
        // A bash command's RESULT text → mirror it into the live terminal tab. This
        // is a SECOND `tool` record paired with the command's own step (same
        // toolName + detail), so coordination folds the output onto that row instead
        // of adding a duplicate. Captured even on a NON-zero exit (a failed build's
        // output is the point) — so it runs BEFORE the isError early-out below.
        if (e.toolName === 'bash') {
          const { detail } = toolCallDetail('bash', e.input);
          emit({
            kind: 'tool',
            toolName: 'bash',
            ...(detail !== undefined ? { detail } : {}),
            output: toolResultText(e.content),
          });
        }
        if (e.isError) return undefined;
        const fileWrite = fileWriteActivity(e.toolName, e.input, config.cwd, safeStatBytes);
        if (fileWrite !== undefined) emit(fileWrite);
        return undefined;
      });
      // THE LIVE STREAM — the model producing text / reasoning token by token.
      // `message_update` carries an `assistantMessageEvent` delta; we forward the
      // streaming assistant text (`assistant-text`) and the reasoning block
      // (`thinking`) as start/delta/end so the pane grows the transcript in real
      // time and can show a genuine "thinking…" state, rather than "working…".
      // `e` is inferred as the extension `message_update` event from the `pi.on`
      // overload (the `MessageUpdateEvent` type is not re-exported from the barrel,
      // so we rely on inference rather than importing it). It carries the streaming
      // `assistantMessageEvent` delta.
      pi.on('message_update', (e) => {
        const ev = e.assistantMessageEvent;
        switch (ev.type) {
          case 'text_start':
            emit({ kind: 'assistant-text', phase: 'start' });
            break;
          case 'text_delta':
            emit({ kind: 'assistant-text', phase: 'delta', delta: ev.delta });
            break;
          case 'text_end':
            emit({ kind: 'assistant-text', phase: 'end', text: ev.content });
            break;
          case 'thinking_start':
            emit({ kind: 'thinking', phase: 'start' });
            break;
          case 'thinking_delta':
            emit({ kind: 'thinking', phase: 'delta', delta: ev.delta });
            break;
          case 'thinking_end':
            emit({ kind: 'thinking', phase: 'end', text: ev.content });
            break;
          default:
            break;
        }
        return undefined;
      });
    }
  };

  // Pull the pi-SDK value constructors from the cached dynamic loader (boot-crash
  // fix — see `loadPi`). The module is already resolved after the first run.
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
    await loadPi();

  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir,
    settingsManager: settings,
    systemPrompt: config.systemPrompt,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    // corpExt first (sampling + thinking-strip + tool capture), then any extra
    // factories the seam supplies (e.g. web-tools for the CEO vision turn). Extra
    // tools still only fire when their name is in `config.tools` (the allowlist).
    extensionFactories: [corpExt, ...(config.extensionFactories ?? [])],
  });
  await loader.reload();

  const sessionManager = SessionManager.inMemory();
  const { session } = await createAgentSession({
    cwd: config.cwd,
    agentDir,
    model: handle.model,
    modelRegistry: handle.registry,
    authStorage: handle.auth,
    thinkingLevel: config.thinking ? 'medium' : 'off',
    tools: config.tools,
    customTools: config.customTools,
    resourceLoader: loader,
    sessionManager,
    settingsManager: settings,
  });

  // --- run: fully autonomous, guarded ONLY by the per-CALL network abort ---
  sessionRef = session; // arm the watchdog's abort target
  readContextPercent = () => {
    try {
      const percent = session.getContextUsage()?.percent;
      return typeof percent === 'number' && Number.isFinite(percent) ? percent : undefined;
    } catch {
      return undefined;
    }
  };
  let promptError = false;
  let bumps = 0;
  const lastText = (): string => {
    try {
      return session.getLastAssistantText() ?? '';
    } catch {
      return '';
    }
  };
  try {
    await session.prompt(config.userPrompt);
    // BUMP-TO-CONTINUE: if the loop ended without the deliverable, re-prompt the SAME
    // session to reach a terminal decision — bounded to `bump.maxBumps`. Each bump is
    // an ordinary user turn on the live session (its context preserved), NOT a fresh
    // run and NOT a work cap.
    while (config.bump !== undefined && bumps < config.bump.maxBumps) {
      const next = config.bump.nextPrompt({ finalText: lastText() });
      if (next === undefined) break; // deliverable present or unfulfillable declared
      bumps += 1;
      await session.prompt(next);
    }
  } catch {
    promptError = true;
  } finally {
    clearCallTimer();
  }

  // A hung/aborted/errored call CUT the model stream, so its `thinking_end` /
  // `text_end` / `turn_end` never fired — leaving the pane's live line a frozen
  // "Thinking…" until the whole task ends. Settle it now with the SAME synthetic
  // turn-end a clean turn emits (coordination's closeStream flips the live flag
  // off). Fabricates NO content. Best-effort — a throwing sink can never break
  // teardown, mirroring the corpExt `emit` swallow.
  for (const record of settleActivitiesOnEnd({ promptError, timedOut: callTimedOut })) {
    try {
      config.onActivity?.(record);
    } catch {
      // a misbehaving sink can never break the run
    }
  }

  // --- gather results before disposing ---
  const messages = session.state.messages as unknown as readonly UsageMessage[];
  let stats: SessionStats | undefined;
  try {
    stats = session.getSessionStats();
  } catch {
    stats = undefined;
  }
  const finalText = (() => {
    try {
      return session.getLastAssistantText() ?? '';
    } catch {
      return '';
    }
  })();

  const filesWritten = collectFilesWritten(toolCalls, safeStatBytes, config.cwd);

  try {
    session.dispose();
  } finally {
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }

  return {
    finalText,
    filesWritten,
    toolCalls,
    stats,
    turns: countAssistantTurns(messages),
    bumps,
    maxTurnOutputTokens: maxTurnOutputTokens(messages),
    // `timeout` here means a per-CALL network abort fired (a hung request), NOT a
    // per-agent work limit — those no longer exist.
    terminatedReason: deriveTerminatedReason({
      timedOut: callTimedOut,
      stepCapHit: stepCap?.hit ?? false,
      promptError,
    }),
    samplingCalls,
    sentSampling,
  };
}

/** Stat a file's size, or undefined if it cannot be read (used for filesWritten). */
function safeStatBytes(absPath: string): number | undefined {
  try {
    return statSync(absPath).size;
  } catch {
    return undefined;
  }
}
