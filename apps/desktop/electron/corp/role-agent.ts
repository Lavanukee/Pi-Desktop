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
 * This module is ADDITIVE: it does NOT touch the app's llamacpp-stream provider
 * (it registers its own in-process `corp-local` `openai-completions` provider so
 * the `before_provider_request` sampling hook actually fires) and it does NOT
 * yet rewire runCorp/dispatch — that is the next stage.
 *
 * Kept as a SINGLE FILE (types + impl) with no relative value-imports so the
 * real-server smoke can load it directly under Node's TS type-stripping.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuthStorage,
  type BeforeProviderRequestEvent,
  type ContextEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  ModelRegistry,
  SessionManager,
  type SessionStats,
  SettingsManager,
  type ToolCallEvent,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
// Type-only: the corp turn taxonomy (stripped at runtime, so no cross-package
// value import — keeps this file loadable under Node TS type-stripping).
import type { CorpTurnPurpose } from '@pi-desktop/harness/corp';

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
}

/**
 * The owner's qwen sampling params, verbatim. These are llama.cpp OpenAI-compat
 * extras (`top_k`/`min_p`/`repetition_penalty` are non-standard) merged onto the
 * outgoing request body by the `before_provider_request` hook.
 */
export const SAMPLING_MODES: Record<SamplingMode, SamplingParams> = {
  'thinking-general': {
    temperature: 1.0,
    top_p: 0.95,
    top_k: 20,
    min_p: 0.0,
    presence_penalty: 1.5,
    repetition_penalty: 1.0,
  },
  'thinking-coding': {
    temperature: 0.6,
    top_p: 0.95,
    top_k: 20,
    min_p: 0.0,
    presence_penalty: 0.0,
    repetition_penalty: 1.0,
  },
  'instruct-general': {
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0.0,
    presence_penalty: 1.5,
    repetition_penalty: 1.0,
  },
  'instruct-reasoning': {
    temperature: 1.0,
    top_p: 0.95,
    top_k: 20,
    min_p: 0.0,
    presence_penalty: 1.5,
    repetition_penalty: 1.0,
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
}

/** The registered provider name — corp-local, distinct from the app provider. */
export const CORP_LOCAL_PROVIDER = 'corp-local';

const DEFAULT_CONTEXT_WINDOW = 16384;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Build a fresh in-memory {@link AuthStorage} + {@link ModelRegistry} and register
 * a keyless `corp-local` `openai-completions` provider against `baseUrl`, then
 * resolve the model. This provider is REGISTERED IN-PROCESS and is deliberately
 * separate from the app's llamacpp-stream provider — talking OpenAI-completions
 * here is what lets the `before_provider_request` sampling hook fire.
 */
export function createCorpModelProvider(config: CorpModelProviderConfig): CorpModelHandle {
  const auth = AuthStorage.inMemory();
  const registry = ModelRegistry.create(auth);
  registry.registerProvider(CORP_LOCAL_PROVIDER, {
    baseUrl: config.baseUrl,
    apiKey: 'none',
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
  // Belt-and-suspenders for the keyless streamFn (the openai-completions path
  // still resolves a request key even when the endpoint needs none).
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

  const corpExt: ExtensionFactory = (pi: ExtensionAPI) => {
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

    // Capture calls + enforce the step-cap ONLY when one was explicitly requested.
    pi.on('tool_call', (e: ToolCallEvent) => {
      toolCalls.push({ name: e.toolName, arguments: e.input });
      return stepCap?.charge();
    });
  };

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
    extensionFactories: [corpExt],
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
  let promptError = false;
  try {
    await session.prompt(config.userPrompt);
  } catch {
    promptError = true;
  } finally {
    clearCallTimer();
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
