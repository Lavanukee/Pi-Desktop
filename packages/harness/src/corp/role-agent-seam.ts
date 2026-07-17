/**
 * The ROLE-AGENT SEAM — the harness's pi-AGNOSTIC contract for running one corp
 * role as a real agentic loop (a headless AgentSession with file + bash tools),
 * instead of a bare single `/chat/completions` turn.
 *
 * The harness never imports the pi SDK: it declares the shape it needs here and
 * the APP injects the concrete impl (apps/desktop/electron/corp/role-agent.ts,
 * adapted in corp-main). When no impl is injected (the driver / unit tests), the
 * orchestrator falls back to the chat-based engineer seam — so every existing
 * flow keeps working with zero server.
 *
 * Phase-2 wires the ENGINEER role onto this seam first (an engineer writes its
 * slot file with the `write` tool and self-checks with `bash`, rather than
 * emitting the file as parseable text). The judgment / structured roles map onto
 * it in a later stage (see {@link samplingModeForPurpose}).
 */

import type { CorpTurnPurpose } from './run.js';

/**
 * The four owner-tuned qwen sampling profiles a role can run under. Kept as a
 * plain string union (NOT the app's `SamplingParams` table) so the harness stays
 * model-agnostic — the app's role-agent runtime owns the concrete params and its
 * own identically-named {@link SamplingMode}, which this maps onto 1:1.
 */
export type SamplingMode =
  | 'thinking-coding'
  | 'thinking-general'
  | 'instruct-general'
  | 'instruct-reasoning';

/**
 * The corp turn → sampling profile map (spec §3 "hands vs brain"). Only
 * `engineer` is WIRED this stage (Phase-2 engineers-first); the rest are the
 * INTENDED mappings for the next stage (judgment/structured roles as agents),
 * documented here so the table is ready when those roles move onto the seam:
 *
 *  - engineer            → `thinking-coding`   (code: low temp, no presence penalty) ← wired
 *  - worker / ceo        → `thinking-general`  (judgment: promote-or-not, final review)
 *  - manager / architect → `instruct-general`  (structured JSON, thinking OFF)
 *  - rescope             → `instruct-general`  (manager-authored, like the manager)
 *  - revise              → `thinking-general`  (a CEO judgment turn)
 */
export function samplingModeForPurpose(purpose: CorpTurnPurpose): SamplingMode {
  switch (purpose) {
    case 'engineer':
      return 'thinking-coding';
    case 'worker':
    case 'ceo':
    case 'revise':
      return 'thinking-general';
    case 'manager':
    case 'architect':
    case 'rescope':
      return 'instruct-general';
    default:
      return 'thinking-general';
  }
}

/** One file a role-agent wrote to its workspace (a `write`/`edit` whose target
 * now exists). Structurally identical to the dispatcher's `WrittenFile`. */
export interface RoleAgentWrittenFile {
  /** Path written (relative to `cwd` when the model addressed it relatively). */
  readonly path: string;
  /** UTF-8 byte length of the produced file. */
  readonly bytes: number;
}

/** One tool call the role-agent made (esp. custom / promotion calls). */
export interface RoleAgentSeamToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown> | string;
}

/**
 * The inputs to one role-agent run — provider-agnostic (no `/no_think` tag, no
 * `chat_template_kwargs`; the app's impl applies provider specifics from
 * `thinking` + `samplingMode`).
 */
export interface RoleAgentRunInput {
  /** The corp turn this role plays (recorded, not routed). */
  readonly purpose: CorpTurnPurpose;
  /** The role's composed system prompt. */
  readonly systemPrompt: string;
  /** The task/contract the role is asked to do (the first user turn). */
  readonly userPrompt: string;
  /** Built-in tool allowlist (e.g. `['read','write','edit','bash','grep','find','ls']`). */
  readonly tools: readonly string[];
  /** The per-run workspace root (produced files land beneath here). */
  readonly cwd: string;
  /** Whether the role runs with model "thinking" on. */
  readonly thinking: boolean;
  /** Which owner-tuned sampling profile to send every turn. */
  readonly samplingMode: SamplingMode;
  /** Optional per-turn output cap. */
  readonly maxTokens?: number;
  /** Hard cap on tool calls before the run's step-cap blocks further ones. */
  readonly maxSteps?: number;
  /** Wall-clock backstop before the run is aborted. */
  readonly timeoutMs?: number;
}

/** The recorded terminal state of one role-agent run (never throws — a runaway /
 * erroring turn returns a recorded result). */
export interface RoleAgentRunOutput {
  /** Files the role wrote to the workspace, via its `write`/`edit` tool calls. */
  readonly filesWritten: readonly RoleAgentWrittenFile[];
  /** The final assistant text (empty string when there is none). */
  readonly finalText: string;
  /** Every tool call the role made. */
  readonly toolCalls: readonly RoleAgentSeamToolCall[];
  /** Why the run ended (`stop` | `step-cap` | `timeout` | `error`, or a label). */
  readonly terminatedReason: string;
  /** Largest single-turn output tokens (the runaway detector), when reported. */
  readonly maxTurnOutputTokens?: number;
  /** How many assistant turns ran, when reported. */
  readonly turns?: number;
}

/**
 * The injected role-agent seam. When present on {@link RunCorpOptions}, the
 * orchestrator runs the engineer role through it (writing files via tools); when
 * absent, it falls back to the chat-based engineer seam. The APP provides the
 * impl by adapting `electron/corp/role-agent.ts`.
 */
export type RunRoleAgentFn = (input: RoleAgentRunInput) => Promise<RoleAgentRunOutput>;
