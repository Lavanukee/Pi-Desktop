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
 *  - vision / worker / ceo → `thinking-general` (judgment: form the vision, promote-or-not, final review)
 *  - review              → `thinking-general`  (the advisory specialists' evidence-grounded findings)
 *  - manager / architect → `instruct-general`  (structured JSON, thinking OFF)
 *  - rescope             → `instruct-general`  (manager-authored, like the manager)
 *  - revise              → `thinking-general`  (a CEO judgment turn)
 */
export function samplingModeForPurpose(purpose: CorpTurnPurpose): SamplingMode {
  switch (purpose) {
    case 'engineer':
      return 'thinking-coding';
    case 'vision':
    case 'worker':
    case 'ceo':
    case 'revise':
    case 'review':
      return 'thinking-general';
    case 'manager':
    case 'architect':
    case 'rescope':
      return 'instruct-general';
    default:
      return 'thinking-general';
  }
}

/**
 * A LIVE activity record streamed DURING a role-agent run (spec §11 live
 * situation room). Neutral + provider-agnostic: the app impl forwards the pi
 * AgentSession's tool/turn events as these the MOMENT they happen — so the file
 * map lights up WHILE an engineer writes, not only when the contract terminates.
 * The CorpEngine maps them onto its neutral {@link CoordinationEvent} stream (a
 * mid-work file-touch, a per-turn node pulse). Absent {@link
 * RoleAgentRunInput.onActivity} → nothing streams and the run returns its terminal
 * {@link RoleAgentRunOutput} exactly as before (the driver / unit tests).
 */
export interface RoleAgentActivity {
  /**
   * What happened.
   *  - `file-write` = a `write`/`edit` tool finished and its target now exists
   *    (the moment to light the file map);
   *  - `tool` = any other tool ran (the app forwards it the moment it STARTS,
   *    with {@link detail} carrying a short human arg summary from the call);
   *  - `turn-start`/`turn-end` = one model turn's boundaries (the node pulse);
   *  - `assistant-text` = the model's LIVE streaming assistant text (a partial
   *    that grows token by token — the app forwards `start`/`delta`/`end`);
   *  - `thinking` = the model is inside a reasoning block (same
   *    `start`/`delta`/`end` phases; `delta` carries streamed reasoning when the
   *    provider exposes it).
   */
  readonly kind: 'file-write' | 'tool' | 'turn-start' | 'turn-end' | 'assistant-text' | 'thinking';
  /** The tool that ran (`tool` / `file-write`). */
  readonly toolName?: string;
  /** The file a `file-write` touched — as the model addressed it (relative to the
   * run cwd when relative), so it maps 1:1 onto the product-tree slot. Also set on
   * a `tool` read so the app can name the file. */
  readonly path?: string;
  /** UTF-8 byte length of the produced file, when known (`file-write`). */
  readonly bytes?: number;
  /** Lines the write added, when known (the live +N readout). */
  readonly linesAdded?: number;
  /** The model turn index (`turn-start`/`turn-end`). */
  readonly turnIndex?: number;
  /** Streaming phase for `assistant-text` / `thinking`: `start` opens the block,
   * `delta` appends {@link delta}, `end` closes it (and may carry the final {@link text}). */
  readonly phase?: 'start' | 'delta' | 'end';
  /** The incremental text appended in this `delta` (`assistant-text` / `thinking`). */
  readonly delta?: string;
  /** The full accumulated block text, when the app has it (typically on `end`). */
  readonly text?: string;
  /** A short human arg summary for a `tool` step — the search query, the command,
   * a grep pattern — extracted from the tool call's arguments at the boundary. The
   * app leaves the human VERB ("Searched the web") to the coordination layer. */
  readonly detail?: string;
  /** Captured RESULT text for a `tool` step whose output is worth mirroring live —
   * a bash command's stdout/stderr. Emitted as a SECOND `tool` record paired with
   * the command's own step (same {@link toolName} + {@link detail}); the app CAPS
   * it to a recent tail so a noisy build can't bloat the event. Absent on a tool
   * START and on tools whose result is not mirrored. */
  readonly output?: string;
  /** Context fullness of the run's session (0..100) at a turn boundary, when the
   * app impl can read it (`session.getContextUsage().percent`). Carried on
   * `turn-start`/`turn-end` records so the engine can surface a live context
   * reading per node without a second polling channel. */
  readonly contextPercent?: number;
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
  /**
   * TERMINAL MARKER — calling this tool is a TERMINAL decision (the CEO vision
   * turn's `submit_vision`). It has no `submitReview` gate and no `slot`, so the
   * §backstop bump can't detect a file; this flag tells the app impl that a call to
   * this tool means the role finished, so the completeness bump STOPS re-prompting
   * (the run's terminal signal is the tool CALL, parsed from `toolCalls`). Left
   * unset (the promotion tool) the call is a plain no-op ack with no bump effect.
   */
  readonly terminal?: boolean;
  /**
   * THE CONSULT MARKER (spec §7 peer/specialist consults, §12-Q11 advice-only).
   * When set, the app impl wires an `execute` that spawns a CLEAN-CONTEXT advisor
   * role-agent (a peer of the engineer's own division, or an advisory specialist)
   * with {@link ConsultSpec.context} + the model's question, and returns the
   * advisor's prose as the tool result. ADVICE-ONLY: the advisor gets read-only
   * tools and NO consult tools of its own (a depth cap of 1 — a consult can never
   * spawn another consult), so it can never edit the requester's files or recurse.
   * Each consult charges the global RunBudget via {@link RoleAgentRunInput.onConsult}.
   */
  readonly consult?: ConsultSpec;
}

/**
 * A CONSULT tool spec (spec §7). `kind` picks the advisor family; the app impl
 * spawns a fresh advisor role-agent from the resolved system prompt (advice-only,
 * read-only, depth-capped) and returns its prose.
 */
export interface ConsultSpec {
  /** `peer` = a clean-context instance of the engineer's own division/role;
   * `specialist` = an advisory reviewer chosen by the model's `lens` argument. */
  readonly kind: 'peer' | 'specialist';
  /** Minimal relevant context prepended to the advisor's user turn (the stuck
   * contract's slot / output / rubric) — the requester's question is appended. */
  readonly context: string;
  /** For `peer`: the single advisor system prompt (the engineer's own division
   * base + domain). Ignored for `specialist` (see {@link lensPrompts}). */
  readonly systemPrompt?: string;
  /** For `specialist`: lens id → advisor system prompt (from PROMPT_LIBRARY, e.g.
   * correctness / security / performance). The tool's `lens` argument selects one;
   * an unknown/absent lens falls back to the first entry. */
  readonly lensPrompts?: Readonly<Record<string, string>>;
  /** Sampling profile for the spawned advisor (judgment prose → thinking-general). */
  readonly samplingMode: SamplingMode;
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
  /**
   * Whether to HARVEST the agent's writes back into `cwd` after the run (default
   * TRUE — the engineer's produced files ARE the product). Set FALSE for a pure
   * SCRATCH workspace whose files must NOT enter the product tree — the CEO
   * vision turn drafts a throwaway mockup here and the vision brief (text) is what
   * carries forward, so nothing lands where the assemble/verify pass would scan it
   * (verify.ts lists the whole tree). The scratch dir is still disposed after.
   */
  readonly harvest?: boolean;
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
  /**
   * BUMP-TO-CONTINUE — the completeness backstop (spec "Run safety & budgets",
   * like the §204 retry-on-empty, bounded). Set ONLY on an engineer run. After the
   * agent's loop ends, if the engineer did NOT finalize via `submit_contract` AND
   * its slot file does not exist AND it did not declare "unfulfillable, because …",
   * the SAME session is RE-PROMPTED with {@link continuePrompt} to reach a terminal
   * decision (write + submit, or declare unfulfillable), up to {@link maxBumps}
   * times. This is NOT a per-agent work cap — it only prevents a PREMATURE stop (an
   * engineer that read its deps then quit without producing its deliverable). After
   * the bumps are spent with still no file and no unfulfillable declaration, the run
   * ends and the missing slot is a finite failure the escalation path recovers.
   */
  readonly bump?: {
    /** Max times the same session is re-prompted to continue (spec bound: 2). */
    readonly maxBumps: number;
    /** The user turn appended on each bump (engineer.ts `buildBumpContinuePrompt`). */
    readonly continuePrompt: string;
  };
  /**
   * CONSULT budget hook (spec §7). Charge one turn against the global RunBudget
   * BEFORE spawning a peer/specialist advisor. Returns `false` when the budget is
   * spent — the consult tool then declines with a note instead of spawning. Absent
   * → consults run uncharged (tests). Supplied by the harness, which owns the budget.
   */
  readonly onConsult?: () => boolean;
  /**
   * LIVE ACTIVITY sink (spec §11). When set, the app impl forwards each of this
   * run's tool/turn events as a {@link RoleAgentActivity} the MOMENT it happens,
   * so the situation room lights up MID-work (a file-touch the instant an engineer
   * writes, a pulse per model turn) rather than only at contract termination.
   * Supplied by the CorpEngine, which maps the records onto its neutral
   * CoordinationEvent stream; absent (tests / driver) → the run streams nothing and
   * returns its terminal output unchanged. Best-effort: a throwing sink must never
   * break the run.
   */
  readonly onActivity?: (record: RoleAgentActivity) => void;
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
  /** BUMP-TO-CONTINUE: how many times the SAME session was re-prompted to continue
   * after ending without its deliverable (0 / absent when none or not an engineer
   * run). The completeness-backstop evidence. */
  readonly bumps?: number;
  /** True when the engineer explicitly declared the contract unfulfillable
   * ("unfulfillable, because …") — a TERMINAL decision routed to escalation, NOT a
   * premature stop. */
  readonly declaredUnfulfillable?: boolean;
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
