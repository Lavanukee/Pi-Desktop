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
 * Phase-2 wires EVERY corp role onto this seam: the engineer writes its slot file
 * with the `write` tool and self-checks with `bash`; and the judgment / structured
 * roles (worker/promotion, architect, manager, CEO) run harnessed too — the
 * agent framing + thinking-off + owner-tuned sampling curbs the runaway a bare
 * completion allows, while the EXISTING structured parsers still parse the role's
 * `finalText` (or, for the worker, its promotion tool call). See
 * {@link samplingModeForPurpose} for the per-role sampling profiles.
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
 * The corp turn → sampling profile map (spec §3 "hands vs brain"). EVERY role now
 * runs harnessed through this seam:
 *
 *  - engineer            → `thinking-coding`   (code: low temp, no presence penalty)
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
 * A neutral custom-tool spec a role-agent may be given (the worker's promotion
 * tool). Structurally the `function` half of an OpenAI function-tool schema
 * (promotion.ts's {@link OpenAiFunctionTool}), kept provider-agnostic here: the
 * app impl converts it to a pi `ToolDefinition` whose invocation is recorded, so
 * the call surfaces in {@link RoleAgentRunOutput.toolCalls} for the harness to
 * parse (e.g. `create_production_hierarchy` → the promotion decision).
 */
export interface RoleAgentCustomTool {
  /** The tool name the model calls (e.g. `create_production_hierarchy`). */
  readonly name: string;
  /** Description handed to the model. */
  readonly description: string;
  /** JSON Schema for the arguments object (serialized to the LLM tool schema). */
  readonly parameters: Record<string, unknown>;
  /**
   * THE §164 SUBMISSION INTERCEPTOR (the engineer's `submit_contract`). When set,
   * the app impl wires a STATEFUL `execute` that implements the spec's self-review
   * bounce over TWO calls within one agent run:
   *  - FIRST call → returns {@link reviewPrompt} as the tool RESULT (the bounce)
   *    and does NOT finalize; the agent keeps working and improves.
   *  - SECOND call → verifies the {@link slot} file exists in the run's cwd (errors
   *    back to the model if missing — "write it before submitting"), then finalizes.
   * Left unset (e.g. the promotion tool) the call is a plain no-op ack — the call
   * itself is the signal, surfaced in {@link RoleAgentRunOutput.toolCalls}.
   */
  readonly submitReview?: {
    /** The contract's slot path (verified to exist on the finalizing call). */
    readonly slot: string;
    /** The model-free self-review prompt returned on the first (bounce) call. */
    readonly reviewPrompt: string;
  };
}

/** One dependency file to SEED into an engineer's isolated workspace (spec §91):
 * the read-only produced output of a contract this engineer builds against, placed
 * at its exact relative path so the engineer reads real code, not a description. */
export interface RoleAgentSeedFile {
  /** The dependency's slot (relative path within the workspace). */
  readonly path: string;
  /** Its produced file content (written read-only into the isolated dir). */
  readonly content: string;
}

/**
 * ISOLATED-WORKSPACE directive (spec §91/§119/§182). When present on a role-agent
 * run, the app seam creates a FRESH temp dir, seeds it with {@link seed} (the
 * engineer's dependency files, read-only, at their exact paths), runs the agent
 * there (its `cwd`), and after the run HARVESTS the files the engineer WROTE (the
 * diff against the seed) back into the run's `cwd` (the shared product tree). Absent
 * → the agent runs directly in `cwd` (Contract.workspace==='shared').
 */
export interface RoleAgentIsolation {
  readonly seed: readonly RoleAgentSeedFile[];
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
  /** Extra custom tools to register for this run (e.g. the worker's promotion
   * tool). Their invocations surface in {@link RoleAgentRunOutput.toolCalls}. */
  readonly customTools?: readonly RoleAgentCustomTool[];
  /** The per-run workspace root. For an isolated engineer this is the SHARED
   * product tree (the harvest target); otherwise the agent runs directly here. */
  readonly cwd: string;
  /** When set, run this engineer in a fresh ISOLATED workspace seeded with its
   * dependency files, harvesting its writes back into {@link cwd} (spec §91). */
  readonly isolation?: RoleAgentIsolation;
  /** Whether the role runs with model "thinking" on. */
  readonly thinking: boolean;
  /** Which owner-tuned sampling profile to send every turn. */
  readonly samplingMode: SamplingMode;
  /** Optional per-turn output cap. */
  readonly maxTokens?: number;
  // NOTE: there is deliberately NO per-agent step cap and NO per-agent total
  // timeout on this seam. A role runs FULLY AUTONOMOUSLY — any tools, as much as it
  // wants, for as long as it wants — until IT submits (its submit tool) or the
  // GLOBAL RunBudget (budget.ts, the whole-run wall-clock) stops the run. The app
  // runtime keeps only a per-individual-CALL network abort (a hung HTTP request
  // degraded to empty), which is a network guard on ONE request, not a work limit.
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
  /** The §164 self-review signal (present only for a `submit_contract` run): did
   * the review bounce fire, did the engineer finalize, and did the slot file CHANGE
   * between the draft (at first submit) and the final (at finalize)? The quality
   * measurement the interceptor exists to produce. */
  readonly submitReview?: {
    readonly bounced: boolean;
    readonly finalized: boolean;
    readonly changed: boolean;
    readonly draftBytes: number;
    readonly finalBytes: number;
  };
}

/**
 * The injected role-agent seam. When present on {@link RunCorpOptions}, the
 * orchestrator runs the engineer role through it (writing files via tools); when
 * absent, it falls back to the chat-based engineer seam. The APP provides the
 * impl by adapting `electron/corp/role-agent.ts`.
 */
export type RunRoleAgentFn = (input: RoleAgentRunInput) => Promise<RoleAgentRunOutput>;
