/**
 * @pi-desktop/harness — the Pi Desktop agent-harness pi extension (workstream W5).
 *
 * Loaded into a pi session via `-e /abs/path/to/packages/harness/src/index.ts`
 * (the default export is the extension factory). It wires:
 *
 *  - a tier-1 task classifier + toolset presets (setActiveTools per task),
 *  - an always-available `tool_search` tool,
 *  - permission modes (bypass / reviewer / review-all) on the tool_call gate,
 *  - the `/harness` command protocol + a published status JSON,
 *  - small-model warnings + a running-task timer.
 *
 * Repair ladder rungs 3–5 are exported (not auto-wired) — W3 plugs
 * {@link createHarnessExtraRungs} into the llama-server provider's `extraRungs`.
 *
 * Everything reusable is re-exported from this module so other workstreams and
 * CLI pi users can consume the pieces directly.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import {
  type AsyncClassifier,
  type ClassifyInput,
  type ClassifyMessage,
  classify,
  classifyWithEscalation,
  TASK_CLASSES,
  type TaskClass,
} from './classify/classify.js';
import { createClassifierEscalation } from './classify/escalation.js';
import { modelTierForClass } from './classify/tier.js';
import { corpToolEnabled, registerCreateHierarchyTool } from './corp/promote-tool.js';
import { CREATE_PRODUCTION_HIERARCHY } from './corp/promotion.js';
import { effortKnobs, isEffortLevel } from './effort/effort.js';
import { createLoopDetector, type LoopDetector, loopDetectorConfig } from './loop/loop-detector.js';
import { parseModelParams, smallModelWarning } from './model/model-size.js';
import { type CallModel, callModelFromEnv } from './model-call/call-model.js';
import { createBashFlagger } from './permissions/flag-bash.js';
import {
  isPermissionMode,
  type PermissionController,
  registerPermissions,
} from './permissions/modes.js';
import { resolvePresetTools } from './presets/presets.js';
import { augmentSystemPrompt } from './prompt/capability-prompt.js';
import { connectRepairBridge, type LiveRepairDeps } from './repair/bridge.js';
import { createToolCallFixer, withRepairAttempts } from './repair/fixer.js';
import {
  createHarnessExtraRungs,
  type HarnessRepairDeps,
  relaxToolSchema,
  type ToolSchemaLike,
} from './repair/rungs.js';
import { adversarialCheck, reviewOutput } from './review/review.js';
import { registerSkillInstructions } from './skills/skill-instructions.js';
import {
  DEFAULT_CONFIG,
  HARNESS_CLASSIFY_ENTRY,
  HARNESS_CONFIG_ENTRY,
  HARNESS_LOOP_ENTRY,
  HARNESS_REPAIR_ENTRY,
  HARNESS_REVIEW_ENTRY,
  HARNESS_TITLE_ENTRY,
  HARNESS_VERIFY_ENTRY,
  type HarnessConfig,
  type HarnessStage,
  type HarnessStatus,
  type PlanItem,
  restoreConfig,
  type StoredEntryLike,
  updateConfig,
} from './state.js';
import { detectBudget } from './subagent/budget.js';
import { type SchedulerSnapshot, SubagentScheduler } from './subagent/scheduler.js';
import { registerSubagentTool } from './subagent/subagent-tool.js';
import {
  HARNESS_SUBAGENTS_STATUS_KEY,
  type HarnessSubagentsStatus,
  MAX_SUBAGENT_DEPTH,
  readSubagentDepth,
} from './subagent/types.js';
import { registerAskUser } from './tools/ask-user.js';
import { registerPlanTool } from './tools/plan-tool.js';
import { registerSandboxFileTools } from './tools/sandbox-fs.js';
import { truncateToolOutput } from './tools/tool-output-truncate.js';
import { registerToolSearch } from './tools/tool-search.js';
import {
  detectProjectCheck,
  makeExecBashRunner,
  makeFsProbe,
  type ProjectCheck,
  runVerifyPass,
  type VerifyBashRunner,
} from './verify/verify.js';

export const packageName = '@pi-desktop/harness';

interface HarnessRuntime {
  config: HarnessConfig;
  activeClass: TaskClass | null;
  /** Conversation title from the classify+title piggyback (computed once). */
  title: string | null;
  activeTools: string[];
  taskStart: number | null;
  turnIndex: number;
  model: { id: string; name?: string } | null;
  permission: PermissionController;
  statusTimer: ReturnType<typeof setInterval> | null;
  /** Latest event ctx, captured so repair rungs (fired inside the provider's
   * stream) can reach ctx.abort / ctx.ui.confirm for the active turn. */
  currentCtx: ExtensionContext | null;
  /** The prompt of the in-flight turn, for the reviewer pass. */
  lastPrompt: string;
  /** Skip the reviewer for the next turn (it's a revision we ourselves triggered). */
  suppressNextReview: boolean;
  /** The live task checklist from the `update_plan` tool (null before first use). */
  plan: PlanItem[] | null;
  /** Optional heading for the plan panel. */
  planTitle: string | null;
  /** Latest subagent scheduler snapshot (null until the first spawn_subagent). */
  subagentSnapshot: SchedulerSnapshot | null;
  /** Coarse lifecycle stage of the current turn (published in HarnessStatus). */
  stage: HarnessStage;
  /** Per-turn loop / no-progress detector (rebuilt each turn from effort knobs). */
  loopDetector: LoopDetector | null;
  /** Files the current agent loop wrote/edited (for the verify syntax fallback). */
  touchedFiles: string[];
  /** Remaining REAL-verify fix steers allowed in the active verify sequence. */
  verifyFixesRemaining: number;
  /** True while inside a self-triggered verify fix sequence (so the budget isn't reset). */
  verifyActive: boolean;
}

/** Options for {@link wireHarness}. All optional; the app passes none (`-e` load). */
export interface WireHarnessOptions {
  /**
   * The utility-model call powering the fixer, reviewer, and classifier
   * escalation. Omitted → built from env (`PI_DESKTOP_UTILITY_*`); still absent →
   * every model-dependent feature degrades to heuristic/skip.
   */
  readonly callModel?: CallModel;
  /**
   * Seams for the effort-gated REAL verify (fix #4). Omitted → built from
   * `pi.exec` + a node:fs probe over `ctx.cwd`. Tests inject a fake bash runner
   * and a stubbed check detector so the bounded-fix loop is exercised offline.
   */
  readonly verify?: {
    /** Run a shell command in the working dir. Default: `pi.exec` via `sh -c`. */
    readonly runBash?: VerifyBashRunner;
    /** Detect the project check for a cwd. Default: {@link detectProjectCheck}. */
    readonly detectCheck?: (cwd: string) => ProjectCheck | null;
  };
}

/** A handle returned by {@link wireHarness} for tests + programmatic wiring. */
export interface HarnessHandle {
  readonly controller: PermissionController;
  getConfig(): HarnessConfig;
  getStatus(ctx: ExtensionContext): HarnessStatus;
  applyPreset(cls: TaskClass, ctx: ExtensionContext): void;
  /** The live repair deps currently pushed to the provider (for tests/telemetry). */
  buildRepairDeps(): LiveRepairDeps;
  /** Run the reviewer/adversarial passes for a finished turn (effort-gated). */
  reviewTurn(output: string, ctx: ExtensionContext): Promise<boolean>;
  /**
   * Run the effort-gated REAL verify for a finished coding/file-ops turn. Returns
   * true when it steered a fix back to the model (bounded per turn).
   */
  verifyTurn(ctx: ExtensionContext): Promise<boolean>;
}

function getEntries(ctx: ExtensionContext): StoredEntryLike[] {
  const sm = ctx.sessionManager as unknown as { getEntries?: () => StoredEntryLike[] };
  return sm.getEntries?.() ?? [];
}

/** Restore a persisted conversation title (last write wins), or null. */
function restoreTitle(entries: readonly StoredEntryLike[]): string | null {
  let title: string | null = null;
  for (const e of entries) {
    if (e.type !== 'custom' || e.customType !== HARNESS_TITLE_ENTRY) continue;
    const data = e.data as { title?: unknown } | undefined;
    if (typeof data?.title === 'string' && data.title.length > 0) title = data.title;
  }
  return title;
}

/** Flatten a message's content (string | content blocks) to plain text. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    const block = b as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Assemble the live conversation as [system, …user/assistant turns, current
 * prompt] so the tier-2 classify+title piggyback SHARES the exact prefix the
 * real turn will process — reusing the single-slot llama-server's KV cache
 * (round-10 #8). Tool-result / thinking blocks are dropped (they aren't
 * user/assistant text): a minor prefix-fidelity limit on tool-heavy turns; plain
 * text turns share fully. The heuristic tier-1 ignores this field.
 */
function buildConversationPrefix(
  entries: readonly StoredEntryLike[],
  systemPrompt: string,
  currentPrompt: string,
): ClassifyMessage[] {
  const messages: ClassifyMessage[] = [];
  if (systemPrompt.trim().length > 0) messages.push({ role: 'system', content: systemPrompt });
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const msg = (e as { message?: { role?: unknown; content?: unknown } }).message;
    const role = msg?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = messageText(msg?.content).trim();
    if (text.length === 0) continue;
    messages.push({ role, content: text });
  }
  // Ensure the current user prompt is the LAST message — pi may not have
  // persisted it as an entry yet when before_agent_start fires.
  const last = messages.at(-1);
  if (!(last?.role === 'user' && last.content === currentPrompt)) {
    messages.push({ role: 'user', content: currentPrompt });
  }
  return messages;
}

function countRepairFailures(entries: readonly StoredEntryLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    if (e.type !== 'custom' || e.customType !== HARNESS_REPAIR_ENTRY) continue;
    const data = e.data as { toolName?: unknown; ok?: unknown } | undefined;
    const toolName = typeof data?.toolName === 'string' ? data.toolName : undefined;
    if (toolName === undefined) continue;
    // Only the authoritative per-call outcome (onRepair) carries `ok`; count the
    // failures. Rung-trace and relaxed/success entries (no `ok:false`) are skipped
    // so a single failed tool call is counted exactly once.
    if (data?.ok !== false) continue;
    counts[toolName] = (counts[toolName] ?? 0) + 1;
  }
  return counts;
}

/** Join the assistant text across a turn's messages (for the reviewer pass). */
function extractAssistantText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        const block = b as { type?: unknown; text?: unknown };
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('\n').trim();
}

const HELP = [
  'Usage: /harness <command>',
  '  status                     show + republish the harness status',
  '  set-mode <bypass|reviewer|review-all>',
  '  effort <low|medium|high|max>',
  `  preset <auto|${TASK_CLASSES.join('|')}>`,
  '  classify <text>            debug: classify a prompt',
].join('\n');

/**
 * Wire the full harness onto a pi session. Returns a handle used by tests and
 * (in the app) by the code that also needs the permission controller.
 */
export function wireHarness(pi: ExtensionAPI, options: WireHarnessOptions = {}): HarnessHandle {
  const runtime: HarnessRuntime = {
    config: DEFAULT_CONFIG,
    activeClass: null,
    title: null,
    activeTools: [],
    taskStart: null,
    turnIndex: 0,
    model: null,
    permission: { getMode: () => DEFAULT_CONFIG.mode, setMode: () => {} },
    statusTimer: null,
    currentCtx: null,
    lastPrompt: '',
    suppressNextReview: false,
    plan: null,
    planTitle: null,
    subagentSnapshot: null,
    stage: 'idle',
    loopDetector: null,
    touchedFiles: [],
    verifyFixesRemaining: 0,
    verifyActive: false,
  };

  // Effort-gated REAL verify seams (fix #4). Default to pi.exec + a node:fs probe;
  // tests inject a fake bash runner and a stubbed detector.
  const verifyBash: VerifyBashRunner | undefined =
    options.verify?.runBash ??
    (typeof pi.exec === 'function' ? makeExecBashRunner(pi.exec.bind(pi)) : undefined);
  const verifyDetectCheck: (cwd: string) => ProjectCheck | null =
    options.verify?.detectCheck ?? ((cwd) => detectProjectCheck(makeFsProbe(cwd)));

  // The utility model powering fixer + reviewer + classifier escalation. Absent
  // (no PI_DESKTOP_UTILITY_BASE_URL and no injected callModel) → those features
  // degrade to heuristic/skip; the rest of the harness is unaffected.
  const callModel: CallModel | undefined = options.callModel ?? callModelFromEnv();
  const asyncClassifier: AsyncClassifier | undefined =
    callModel !== undefined ? createClassifierEscalation(callModel) : undefined;

  // A session-stable per-tool failure counter shared by rungs 4 (bump) and 5
  // (read → abort at threshold). Persists across effort changes (which only
  // rebuild the rung array / threshold, not the counts).
  const failureCounts = new Map<string, number>();

  // Per-session RELAXED schemas (rung 4). When a tool's strict schema keeps
  // rejecting otherwise-usable args, rung 4 stores a looser schema here; the
  // provider reads it via `relaxedSchemaFor` so subsequent calls to that tool
  // validate at rung 2 instead of re-escalating. Cleared on session_start.
  const relaxedSchemas = new Map<string, ToolSchemaLike>();

  /**
   * Build the live repair deps the provider's stream ladder consumes: the
   * effort-bounded rung-2 fixer, rungs 3–5 (abort threshold from the effort
   * slider), and telemetry that populates HarnessStatus.repairFailures.
   */
  function buildRepairDeps(): LiveRepairDeps {
    const knobs = effortKnobs(runtime.config.effort);
    const fixer =
      callModel !== undefined
        ? withRepairAttempts(createToolCallFixer(callModel), knobs.repairAttempts)
        : undefined;

    const harnessDeps: HarnessRepairDeps = {
      abortThreshold: knobs.abortThreshold,
      // Rung trace (no `ok` → not counted as a failure). Entering a repair rung is
      // a seam for the 'repairing' stage (fix #5) — the tool-execution-end hook
      // flips it back to 'working' once the retried call resolves.
      onRung: (info) => {
        pi.appendEntry(HARNESS_REPAIR_ENTRY, { rung: info.rung, toolName: info.toolName });
        setStage('repairing', runtime.currentCtx);
      },
      bumpFailureCount: (t) => {
        const n = (failureCounts.get(t) ?? 0) + 1;
        failureCounts.set(t, n);
        return n;
      },
      getFailureCount: (t) => failureCounts.get(t) ?? 0,
      confirmRelax: async ({ toolName, error, count }) => {
        const ctx = runtime.currentCtx;
        // A spawned child pi reports ctx.hasUI === true (it speaks the same rpc
        // protocol) even though NO human is attached — blocking on ctx.ui.confirm
        // there hangs the subagent forever and rung-5's abort never fires. Treat
        // any headless OR subagent context as "no human present" and resolve the
        // relax deterministically instead of awaiting a dialog nobody can answer.
        if (readSubagentDepth(process.env) > 0 || ctx?.hasUI !== true) return true;
        return ctx.ui.confirm(
          `Relax "${toolName}" schema?`,
          `${error} (attempt ${count}). Accept the arguments as-is?`,
        );
      },
      relaxSchema: ({ toolName, schema }) => {
        // Re-register the tool under a looser per-session schema (same-name): store
        // a maximally-permissive schema keyed by tool name, which the provider
        // reads via `relaxedSchemaFor` (below) so this tool's subsequent calls
        // validate at rung 2 instead of re-escalating through rungs 3–5. The tool's
        // execution is untouched — only its per-session VALIDATION schema loosens.
        relaxedSchemas.set(toolName, relaxToolSchema(schema));
        pi.appendEntry(HARNESS_REPAIR_ENTRY, { toolName, relaxed: true });
      },
      abort: ({ toolName, count }) => {
        pi.appendEntry(HARNESS_REPAIR_ENTRY, { toolName, aborted: true, count });
        runtime.currentCtx?.abort();
      },
    };

    return {
      fixer,
      extraRungs: createHarnessExtraRungs(harnessDeps),
      // Per-session relaxed-schema lookup (rung 4). Closes over the live map, so a
      // relaxation stored after this deps object was pushed is still seen.
      relaxedSchemaFor: (toolName) => relaxedSchemas.get(toolName),
      // Authoritative per-call outcome — the only entry carrying `ok`.
      onRepair: (info) =>
        pi.appendEntry(HARNESS_REPAIR_ENTRY, {
          toolName: info.toolName,
          rung: info.rung,
          ok: info.ok,
        }),
      // Prefill %: the provider (which can't reach a per-turn ctx) forwards its
      // `prompt_progress` fraction here; publish it on the LIVE turn's status
      // channel so the desktop "N% processing" ring shows real prefill progress.
      // Reads runtime.currentCtx at call time, so the static deps object still
      // targets whatever turn is active. Capped 99 (renderer drives the final 100).
      onPromptProgress: (fraction) => {
        const ctx = runtime.currentCtx;
        if (ctx?.hasUI === true) {
          ctx.ui.setStatus('harness-prefill', String(Math.min(99, Math.round(fraction * 100))));
        }
      },
    };
  }

  // Connect the repair bridge to the provider extension over pi.events (handshake
  // is order-independent; no-op if pi.events / the provider isn't present).
  const bridge = connectRepairBridge(pi.events, buildRepairDeps);

  /**
   * Effort-gated reviewer + adversarial passes over a finished turn's output.
   * Returns true when a revision was triggered. Fail-open: no callModel → false.
   */
  async function reviewTurn(output: string, ctx: ExtensionContext): Promise<boolean> {
    if (callModel === undefined || output.trim().length === 0) return false;
    if (runtime.suppressNextReview) {
      runtime.suppressNextReview = false;
      return false;
    }
    const knobs = effortKnobs(runtime.config.effort);
    if (knobs.reviewPasses <= 0 && !knobs.adversarialChecks) return false;

    setStage('reviewing', ctx);
    const task = runtime.lastPrompt;
    const issues: string[] = [];
    // Run up to `reviewPasses` reviewer passes so a higher effort really does run
    // more passes than a lower one (the knob was inert — medium/high/max all ran
    // exactly once). Stop at the first pass that flags something (it already has
    // the issues to fix); a clean pass proceeds to the next.
    for (let i = 0; i < knobs.reviewPasses; i++) {
      const r = await reviewOutput(callModel, { task, output });
      if (!r.ok) {
        issues.push(...r.issues);
        break;
      }
    }
    if (knobs.adversarialChecks) {
      const a = await adversarialCheck(callModel, { task, output });
      if (!a.ok) issues.push(...a.issues);
    }

    pi.appendEntry(HARNESS_REVIEW_ENTRY, {
      effort: runtime.config.effort,
      reviewPasses: knobs.reviewPasses,
      adversarial: knobs.adversarialChecks,
      flagged: issues.length > 0,
      issues,
    });
    if (issues.length === 0) return false;

    // Trigger a revision turn, and don't review that revision (avoid a loop).
    runtime.suppressNextReview = true;
    setStage('revising', ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(`Refining the result (${issues.length} point(s) to tighten)…`, 'warning');
    }
    // Private steer — deliberately free of any "reviewer"/"harness" vocabulary the
    // model might parrot into its user-facing reply (blind-test item 5). The last
    // clause tells the model to keep this instruction to itself and just deliver
    // the improved result.
    pi.sendUserMessage?.(
      `Before you finish, tighten your last result — fix these points:\n- ${issues.join('\n- ')}\n\nApply the fixes and deliver the improved result directly. This note is internal: do not mention it, a "revision", or these points in your reply.`,
      { deliverAs: 'followUp' },
    );
    return true;
  }

  /**
   * Effort-gated REAL verify (fix #4): after the model finishes a coding/file-ops
   * turn at high/max effort, run the project's OWN checks (test/typecheck/lint) in
   * the working dir. On a genuine failure, steer the output back for a fix —
   * bounded to `verifyFixAttempts` per user turn so it can't loop forever. Safe:
   * timeout + bounded + skipped in review-all (where the user approves every act).
   * Returns true when it steered a fix. Needs NO utility model — it runs real
   * checks, so it works with zero model headroom.
   */
  async function verifyTurn(ctx: ExtensionContext): Promise<boolean> {
    const knobs = effortKnobs(runtime.config.effort);
    // Gate: effort (high/max), class (coding/file-ops only — never chat/trivial),
    // a usable bash seam, and permission mode (skip auto-run in review-all).
    if (
      !knobs.realVerify ||
      verifyBash === undefined ||
      (runtime.activeClass !== 'coding' && runtime.activeClass !== 'file-ops') ||
      runtime.config.mode === 'review-all'
    ) {
      runtime.verifyActive = false;
      return false;
    }
    // A fresh verify sequence (not a self-triggered fix revision) resets the budget.
    if (!runtime.verifyActive) runtime.verifyFixesRemaining = knobs.verifyFixAttempts;

    setStage('verifying', ctx);
    let pass: Awaited<ReturnType<typeof runVerifyPass>>;
    try {
      pass = await runVerifyPass({
        cwd: ctx.cwd,
        runBash: verifyBash,
        detectCheck: verifyDetectCheck,
        touchedFiles: runtime.touchedFiles,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
    } catch {
      runtime.verifyActive = false;
      return false;
    }

    // Nothing to run, or the check passed / was inconclusive → sequence over.
    if (pass.check === null || pass.outcome === null || pass.outcome.status !== 'fail') {
      if (pass.check !== null && pass.outcome !== null) {
        pi.appendEntry(HARNESS_VERIFY_ENTRY, {
          effort: runtime.config.effort,
          kind: pass.check.kind,
          status: pass.outcome.status,
          command: pass.outcome.command,
        });
      }
      runtime.verifyActive = false;
      return false;
    }

    // A genuine failure. If the fix budget remains, steer the output back.
    if (runtime.verifyFixesRemaining > 0) {
      runtime.verifyFixesRemaining -= 1;
      runtime.verifyActive = true;
      pi.appendEntry(HARNESS_VERIFY_ENTRY, {
        effort: runtime.config.effort,
        kind: pass.check.kind,
        status: 'fail',
        command: pass.outcome.command,
        fix: true,
      });
      setStage('revising', ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`Verify: ${pass.check.label} failed — requesting a fix.`, 'warning');
      }
      // Private steer (blind-test item 5): a plain check-output steer with an
      // explicit "keep this internal" clause so the fix loop never surfaces as
      // meta narration in the user-facing reply.
      pi.sendUserMessage?.(
        `A check failed after your last change:\n\n$ ${pass.outcome.command}\n${pass.outcome.output}\n\nFix the code so this check passes, then stop. This is an internal check — fix it silently and don't mention it in your reply.`,
        { deliverAs: 'followUp' },
      );
      return true;
    }

    // Budget exhausted and still failing → give up (surface it), never loop.
    runtime.verifyActive = false;
    pi.appendEntry(HARNESS_VERIFY_ENTRY, {
      effort: runtime.config.effort,
      kind: pass.check.kind,
      status: 'fail',
      command: pass.outcome.command,
      gaveUp: true,
    });
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Verify: ${pass.check.label} still failing after ${knobs.verifyFixAttempts} fix attempt(s).`,
        'warning',
      );
    }
    return false;
  }

  /**
   * Act on a {@link LoopDetector} signal (fix #3): a steer injects one corrective
   * nudge into the live stream; an abort surfaces a reason + calls ctx.abort().
   * Returns true when it aborted (so the tool_call hook can also block the call).
   */
  function handleLoopSignal(signal: ReturnType<LoopDetector['onToolCall']>): boolean {
    const ctx = runtime.currentCtx;
    if (signal.kind === 'none') return false;
    if (signal.kind === 'steer') {
      pi.appendEntry(HARNESS_LOOP_ENTRY, {
        action: 'steer',
        cause: signal.cause,
        reason: signal.reason,
      });
      if (ctx?.hasUI === true) ctx.ui.notify(`Loop guard: ${signal.reason} — nudging.`, 'warning');
      pi.sendUserMessage?.(signal.message, { deliverAs: 'steer' });
      return false;
    }
    // abort
    pi.appendEntry(HARNESS_LOOP_ENTRY, {
      action: 'abort',
      cause: signal.cause,
      reason: signal.reason,
    });
    if (ctx?.hasUI === true)
      ctx.ui.notify(`Loop guard aborted the turn: ${signal.reason}.`, 'error');
    ctx?.abort();
    return true;
  }

  // Skill-instructions framing (Wave B #3b): wrap a SKILL/tool-instructions file
  // the model READS in an explicit `<skill_instructions>` marker on the outgoing
  // context, so it reaches the model as instructions — not as a user turn (the
  // provider folds tool results into a user-role turn for Gemma-class templates).
  registerSkillInstructions(pi);

  // File-spill containment (blind-test round-2 #2): override pi's built-in
  // write/edit/read/ls so a RELATIVE path resolves against the resolved
  // sandbox/project cwd — never HOME — and mutating ops are fenced to the
  // workspace + sandbox roots. No-op unless the desktop set PI_DESKTOP_FS_FENCE=1,
  // so a plain CLI `pi` user keeps the unfenced built-ins. See tools/sandbox-fs.ts.
  registerSandboxFileTools(pi);

  // Tool search — always available so the model can pull in missing tools.
  registerToolSearch(pi, {
    onActivate: (added) => {
      runtime.activeTools = Array.from(new Set([...runtime.activeTools, ...added]));
    },
  });

  // Task-list / checklist tool: the model publishes a plan the app renders live.
  registerPlanTool(pi, {
    onUpdate: (plan, title) => {
      runtime.plan = plan.length > 0 ? plan : null;
      runtime.planTitle = title ?? null;
      if (runtime.currentCtx !== null) publishStatus(runtime.currentCtx);
    },
  });

  // Ask-user tool: rich choice / multi-select / slider / free-text questions,
  // routed to the desktop QuestionCard via the input-dialog sentinel channel.
  registerAskUser(pi);

  // Real subagents: `spawn_subagent` runs an isolated child pi and returns ONLY
  // its summary. Spawns are memory-scheduled (concurrency bounded by detected
  // RAM/cores, degrading to 1 with no utility model / low RAM / single core).
  // Only the top-level agent (depth 0) registers the tool — a spawned child
  // (depth >= 1) does not, so subagents can't recursively spawn subagents (v1).
  if (readSubagentDepth(process.env) < MAX_SUBAGENT_DEPTH) {
    const scheduler = new SubagentScheduler({
      budget: detectBudget({ hasUtilityModel: callModel !== undefined }),
      onChange: (snap) => {
        runtime.subagentSnapshot = snap;
        if (runtime.currentCtx !== null) publishSubagents(runtime.currentCtx);
      },
    });
    registerSubagentTool(pi, { scheduler });
  }

  // Corp system as an OPTION (jedd): at high/max effort the model can hand a
  // large, professional build to a manager + team via `create_production_hierarchy`
  // — "still just a tool", never a mode that hijacks the prompt. It's registered
  // globally but only ENTERS the active set at high/max (see applyPreset); calling
  // it publishes a promote intent (PROMOTE_STATUS_KEY) the desktop catches to
  // launch the existing corp run.
  registerCreateHierarchyTool(pi, { getEffort: () => runtime.config.effort });

  // Permission gate. In reviewer mode a scary-bash command is flagged first by
  // the regex rules, then — when a utility model is configured — double-checked
  // by the small model (fail-open to the regex result).
  runtime.permission = registerPermissions(pi, {
    initialMode: runtime.config.mode,
    ...(callModel !== undefined ? { flagBash: createBashFlagger(callModel) } : {}),
  });

  function buildStatus(ctx: ExtensionContext): HarnessStatus {
    const usage = ctx.getContextUsage();
    return {
      ...runtime.config,
      activeClass: runtime.activeClass,
      activeTier: runtime.activeClass !== null ? modelTierForClass(runtime.activeClass) : null,
      title: runtime.title,
      activeTools: runtime.activeTools,
      model: runtime.model?.id ?? null,
      modelParams: runtime.model ? parseModelParams(runtime.model.name ?? runtime.model.id) : null,
      contextPercent: usage?.percent ?? null,
      runningTaskMs: runtime.taskStart !== null ? Date.now() - runtime.taskStart : null,
      repairFailures: countRepairFailures(getEntries(ctx)),
      plan: runtime.plan,
      planTitle: runtime.planTitle,
      stage: runtime.stage,
    };
  }

  function publishStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus('harness', JSON.stringify(buildStatus(ctx)));
    // A short human-readable running-task status for the app's timer.
    ctx.ui.setStatus(
      'harness-task',
      runtime.taskStart !== null
        ? `⏱ ${((Date.now() - runtime.taskStart) / 1000).toFixed(1)}s`
        : undefined,
    );
  }

  /**
   * Set the coarse lifecycle {@link HarnessStage} and republish the status so the
   * app's activity indicator reflects the seam that just fired. De-duped: a no-op
   * when the stage is unchanged (the 1s timer already republishes otherwise).
   */
  function setStage(stage: HarnessStage, ctx: ExtensionContext | null): void {
    if (ctx === null || runtime.stage === stage) return;
    runtime.stage = stage;
    publishStatus(ctx);
  }

  /**
   * Stream the live subagent list over the SAME setStatus channel the plan uses,
   * under a distinct key so the desktop opens/feeds the canvas subagent tab. An
   * empty/null snapshot clears the key (the panel/tab shows nothing).
   */
  function publishSubagents(ctx: ExtensionContext): void {
    const snap = runtime.subagentSnapshot;
    if (snap === null || snap.items.length === 0) {
      ctx.ui.setStatus(HARNESS_SUBAGENTS_STATUS_KEY, undefined);
      return;
    }
    const payload: HarnessSubagentsStatus = {
      subagents: snap.items,
      budget: {
        maxConcurrency: snap.maxConcurrency,
        running: snap.running,
        queued: snap.queued,
        reason: snap.reason,
      },
    };
    ctx.ui.setStatus(HARNESS_SUBAGENTS_STATUS_KEY, JSON.stringify(payload));
  }

  function applyPreset(cls: TaskClass, ctx: ExtensionContext): void {
    const available = pi.getAllTools().map((t) => t.name);
    const preset = resolvePresetTools(cls, available);
    // The active tool list is rendered at the START of the prompt (chat templates
    // emit tools before the messages), so it is part of the KV-cached prefix. If
    // we blindly re-set it every turn, a NEW user message churns that prefix and
    // forces a FULL re-prefill — even for a trivial "hi" follow-up — while the
    // re-prefills BETWEEN tool calls (same turn, no before_agent_start) stay
    // instant because the prefix is untouched. That's exactly the asymmetry jedd
    // observed. So: keep the set STABLE across turns — union the preset onto the
    // current tools (never drop a tool_search-activated one), APPEND missing ones
    // (so any reused prefix stays a prefix), and only call setActiveTools when the
    // set actually grows. Same class + no new tools ⇒ zero prefix change ⇒ the KV
    // cache is reused and the follow-up prefill is as instant as a tool-call one.
    let target = runtime.activeTools.slice();
    for (const name of preset) if (!target.includes(name)) target.push(name);
    // The corp system is offered as a tool ONLY at high/max effort (jedd). Add it
    // at those efforts, strip it below — so lowering effort mid-session hides it
    // again. Kept at the END of the list so its presence/absence never disturbs
    // the cached prefix ahead of it.
    const wantCorp =
      corpToolEnabled(runtime.config.effort) && available.includes(CREATE_PRODUCTION_HIERARCHY);
    if (wantCorp && !target.includes(CREATE_PRODUCTION_HIERARCHY)) {
      target.push(CREATE_PRODUCTION_HIERARCHY);
    } else if (!wantCorp && target.includes(CREATE_PRODUCTION_HIERARCHY)) {
      target = target.filter((t) => t !== CREATE_PRODUCTION_HIERARCHY);
    }
    runtime.activeClass = cls;
    // Only touch the tool set (and thus the cached prefix) when it actually
    // changed — by length OR membership (the corp tool can be added or removed).
    const changed =
      target.length !== runtime.activeTools.length ||
      target.some((t, i) => t !== runtime.activeTools[i]);
    if (changed) {
      pi.setActiveTools(target);
      runtime.activeTools = target;
    }
    // Warn if the current model is too small for an advanced task.
    if (runtime.model !== null) {
      const warning = smallModelWarning(runtime.model, cls);
      if (warning !== null && ctx.hasUI) ctx.ui.notify(warning, 'warning');
    }
    publishStatus(ctx);
  }

  function persistConfig(): void {
    pi.appendEntry(HARNESS_CONFIG_ENTRY, runtime.config);
  }

  /**
   * Record + publish the conversation title from the classify+title piggyback.
   * Emits it over the SAME status channel as the plan/repair status: a `title`
   * field in the structured harness status JSON, plus a dedicated `harness-title`
   * key. Persisted so a reloaded session keeps its title. (App-side display is a
   * separate follow-up wave — this just makes the title available.)
   */
  function setTitle(title: string, ctx: ExtensionContext): void {
    const trimmed = title.trim();
    if (trimmed.length === 0 || runtime.title === trimmed) return;
    runtime.title = trimmed;
    pi.appendEntry(HARNESS_TITLE_ENTRY, { title: trimmed });
    ctx.ui.setStatus('harness-title', trimmed);
    publishStatus(ctx);
  }

  // Restore persisted config + start the status timer on session start.
  pi.on('session_start', (_event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.config = restoreConfig(getEntries(ctx));
    runtime.permission.setMode(runtime.config.mode);
    // A new / switched session must NOT inherit the previous session's live
    // checklist or subagent panel. Reset them here (session_start also fires on a
    // switch_session load) so the publish below republishes an EMPTY plan instead
    // of leaking the old chat's tasks into the new one.
    runtime.plan = null;
    runtime.planTitle = null;
    runtime.subagentSnapshot = null;
    // Fresh session → idle stage and cleared per-turn loop/verify state.
    runtime.stage = 'idle';
    runtime.loopDetector = null;
    runtime.touchedFiles = [];
    runtime.verifyActive = false;
    runtime.verifyFixesRemaining = 0;
    // A new/switched session must not inherit the previous session's relaxed
    // tool schemas (a per-session weakening of validation must not leak).
    relaxedSchemas.clear();
    // A new/switched session gets a fresh title (recomputed on its first turn).
    runtime.title = restoreTitle(getEntries(ctx));
    // Push repair deps now that the effort level is known (abortThreshold etc.).
    bridge.push();
    if (runtime.statusTimer !== null) clearInterval(runtime.statusTimer);
    runtime.statusTimer = setInterval(() => publishStatus(ctx), 1000);
    publishStatus(ctx);
    publishSubagents(ctx);
  });

  pi.on('session_shutdown', () => {
    if (runtime.statusTimer !== null) {
      clearInterval(runtime.statusTimer);
      runtime.statusTimer = null;
    }
  });

  // Classify each task and load its preset before the agent loop runs. When a
  // utility model is configured, ambiguous heuristics escalate to a tier-2
  // double-check (classifyWithEscalation); otherwise the pure heuristic stands.
  pi.on('before_agent_start', async (event, ctx) => {
    runtime.turnIndex += 1;
    runtime.currentCtx = ctx;
    runtime.lastPrompt = event.prompt;
    // Fresh agent loop: a new loop detector (effort-scaled cap/streaks) and an
    // empty touched-file set. Reset per turn (fix #3). NOTE: the verify fix budget
    // is deliberately NOT reset here — a self-triggered fix revision is also a new
    // before_agent_start, and verifyTurn manages that budget via `verifyActive`.
    runtime.loopDetector = createLoopDetector(
      loopDetectorConfig(effortKnobs(runtime.config.effort)),
    );
    runtime.touchedFiles = [];
    setStage('classifying', ctx);
    // Capability-affirming system prompt (fix: the model must KNOW it can act on
    // the machine and must not disclaim abilities it has). pi 0.68.1 applies a
    // `{ systemPrompt }` returned from this handler for the turn (agent-session's
    // emitBeforeAgentStart), chained across extensions — so we augment whatever
    // base/previously-chained prompt arrives. Built BEFORE the classify prefix so
    // the tier-2 piggyback shares the EXACT prompt the real turn will run on.
    const augmentedSystemPrompt = augmentSystemPrompt(event.systemPrompt);
    let cls: TaskClass;
    if (runtime.config.preset === 'auto') {
      const input: ClassifyInput = {
        prompt: event.prompt,
        hasImages: (event.images?.length ?? 0) > 0,
        priorClass: runtime.activeClass ?? undefined,
        turnIndex: runtime.turnIndex,
        // Live conversation prefix for the cache-reusing tier-2 piggyback (only
        // read when it escalates; tier-1 heuristics ignore it).
        priorMessages: buildConversationPrefix(
          getEntries(ctx),
          augmentedSystemPrompt,
          event.prompt,
        ),
      };
      if (asyncClassifier !== undefined) {
        // Force the {title, class} piggyback on the first turn (until we have a
        // title) so the title is produced even when the class is unambiguous.
        const forceEscalate = runtime.turnIndex === 1 && runtime.title === null;
        const result = await classifyWithEscalation(input, { asyncClassifier, forceEscalate });
        cls = result.class;
        if (result.title !== undefined) setTitle(result.title, ctx);
      } else {
        cls = classify(input).class;
      }
    } else {
      cls = runtime.config.preset;
    }
    applyPreset(cls, ctx);
    pi.appendEntry(HARNESS_CLASSIFY_ENTRY, { class: cls, turnIndex: runtime.turnIndex });
    // Replace the turn's system prompt with the capability-affirming version.
    return { systemPrompt: augmentedSystemPrompt };
  });

  // Running-task timer.
  pi.on('agent_start', (_event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.taskStart = Date.now();
    setStage('working', ctx);
    publishStatus(ctx);
  });
  pi.on('agent_end', async (event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.taskStart = null;
    publishStatus(ctx);
    const output = extractAssistantText(event.messages);
    // 1) Effort high/max → run the project's REAL checks on coding/file-ops turns.
    //    If it steers a fix, skip the LLM reviewer this cycle (don't double-steer
    //    the same revision — the reviewer runs on the fixed result next time).
    const fixRequested = await verifyTurn(ctx);
    // 2) Otherwise → reviewer + adversarial critique of the produced result.
    const revisionRequested = fixRequested || (await reviewTurn(output, ctx));
    // 3) Final stage for the turn: 'revising' if another loop follows, else done/idle.
    setStage(revisionRequested ? 'revising' : output.length > 0 ? 'done' : 'idle', ctx);
  });

  // Loop / no-progress breaking (fix #3), plus touched-file tracking for the
  // verify syntax fallback. Feeds the per-turn detector the identical-call streak
  // (before execution) and the consecutive-error streak (after execution).
  pi.on('tool_call', (event, ctx) => {
    runtime.currentCtx = ctx;
    // Remember files this turn writes/edits (for verify's syntax fallback, fix #4).
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const input = event.input as Record<string, unknown>;
      const path = input.path ?? input.file_path ?? input.filePath;
      if (typeof path === 'string' && path.length > 0 && !runtime.touchedFiles.includes(path)) {
        runtime.touchedFiles.push(path);
      }
    }
    const detector = runtime.loopDetector;
    if (detector === null) return;
    const signal = detector.onToolCall(event.toolName, event.input);
    if (handleLoopSignal(signal)) {
      // Aborted (identical-call or hard-cap) → also block this final bad call.
      return { block: true, reason: signal.kind === 'abort' ? signal.reason : undefined };
    }
    return;
  });
  pi.on('tool_execution_end', (event, ctx) => {
    runtime.currentCtx = ctx;
    // A completed tool call clears the transient 'repairing' stage (fix #5).
    if (runtime.stage === 'repairing') setStage('working', ctx);
    const detector = runtime.loopDetector;
    if (detector === null) return;
    // Consecutive-error streak → steer once, then abort (can't block post-hoc).
    handleLoopSignal(detector.onToolResult(event.isError === true));
  });

  // Tool-output truncation (jedd): cap a runaway tool result (`ls -R`, a huge
  // grep/find, a chatty build) to ~1.5k tokens BEFORE it enters the conversation,
  // so one command can't blow the whole context (the observed 24.5k-token `ls -R`
  // → HTTP 400). Applied to the shell/enumeration tools whose output is
  // disposable; `read` is left alone (its content is the point, and pi already
  // bounds it). Only the text parts are capped — image parts pass through.
  const TRUNCATE_TOOLS = new Set(['bash', 'grep', 'find', 'ls']);
  pi.on('tool_result', (event) => {
    if (!TRUNCATE_TOOLS.has(event.toolName)) return;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== 'text') return part;
      const { text, truncated } = truncateToolOutput(part.text);
      if (!truncated) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });

  // Model changes → small-model warning + status refresh.
  pi.on('model_select', (event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.model = { id: event.model.id, name: event.model.name };
    if (runtime.activeClass !== null) {
      const warning = smallModelWarning(runtime.model, runtime.activeClass);
      if (warning !== null && ctx.hasUI) ctx.ui.notify(warning, 'warning');
    }
    publishStatus(ctx);
  });

  // /harness command protocol.
  pi.registerCommand('harness', {
    description: 'Configure the harness: set-mode, effort, preset, status, classify.',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const spaceIdx = trimmed.indexOf(' ');
      const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
      const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

      switch (sub) {
        case '':
        case 'help':
          ctx.ui.notify(HELP);
          return;

        case 'status': {
          publishStatus(ctx);
          ctx.ui.notify(`harness status:\n${JSON.stringify(buildStatus(ctx), null, 2)}`);
          return;
        }

        case 'set-mode': {
          if (!isPermissionMode(rest)) {
            ctx.ui.notify(
              `Unknown mode "${rest}". Options: bypass, reviewer, review-all.`,
              'error',
            );
            return;
          }
          runtime.config = updateConfig(runtime.config, { mode: rest });
          runtime.permission.setMode(rest);
          persistConfig();
          publishStatus(ctx);
          ctx.ui.notify(`permission mode → ${rest}`);
          return;
        }

        case 'effort': {
          if (!isEffortLevel(rest)) {
            ctx.ui.notify(`Unknown effort "${rest}". Options: low, medium, high, max.`, 'error');
            return;
          }
          runtime.config = updateConfig(runtime.config, { effort: rest });
          persistConfig();
          // Re-push repair deps so the new abortThreshold / repairAttempts take
          // effect on the provider's live ladder immediately.
          bridge.push();
          publishStatus(ctx);
          const k = effortKnobs(rest);
          ctx.ui.notify(
            `effort → ${rest} (repairAttempts ${k.repairAttempts}, abortThreshold ${k.abortThreshold}, reviewPasses ${k.reviewPasses}, adversarial ${k.adversarialChecks})`,
          );
          return;
        }

        case 'preset': {
          const value = rest.toLowerCase();
          if (value !== 'auto' && !(TASK_CLASSES as readonly string[]).includes(value)) {
            ctx.ui.notify(
              `Unknown preset "${rest}". Use auto or: ${TASK_CLASSES.join(', ')}.`,
              'error',
            );
            return;
          }
          runtime.config = updateConfig(runtime.config, {
            preset: value as HarnessConfig['preset'],
          });
          persistConfig();
          if (value !== 'auto') applyPreset(value as TaskClass, ctx);
          else publishStatus(ctx);
          ctx.ui.notify(`preset → ${value}`);
          return;
        }

        case 'classify': {
          if (rest.length === 0) {
            ctx.ui.notify('Usage: /harness classify <text>');
            return;
          }
          const r = classify({ prompt: rest });
          ctx.ui.notify(
            `class: ${r.class}\nconfidence: ${r.confidence.toFixed(2)}${r.ambiguous ? ' (ambiguous)' : ''}\nsignals: ${r.signals.join(', ')}`,
          );
          return;
        }

        default:
          ctx.ui.notify(`Unknown subcommand "${sub}".\n${HELP}`, 'error');
      }
    },
  });

  return {
    controller: runtime.permission,
    getConfig: () => runtime.config,
    getStatus: (ctx) => buildStatus(ctx),
    applyPreset,
    buildRepairDeps,
    reviewTurn,
    verifyTurn,
  };
}

/** pi extension factory (default export loaded via `-e`). */
export default function activate(pi: ExtensionAPI): void {
  wireHarness(pi);
}

// --- Public API re-exports -------------------------------------------------

export {
  type AsyncClassifier,
  type Attachment,
  type ClassifyInput,
  type ClassifyMessage,
  type ClassifyOptions,
  type ClassifyResult,
  classify,
  classifyWithEscalation,
  TASK_CATEGORIES,
  TASK_CLASSES,
  TASK_TIERS,
  type TaskCategory,
  type TaskClass,
  type TaskTier,
} from './classify/classify.js';
export { createClassifierEscalation } from './classify/escalation.js';
export {
  COARSE_TIERS,
  COARSE_TO_MODEL,
  type CoarseTier,
  coarseTier,
  isCoarseTier,
  isModelTier,
  MODEL_TIERS,
  type ModelTier,
  modelTierForClass,
  TIER_LABEL,
} from './classify/tier.js';
export {
  corpToolEnabled,
  PROMOTE_STATUS_KEY,
  type PromoteSignal,
  registerCreateHierarchyTool,
} from './corp/promote-tool.js';
export {
  EFFORT_KNOBS,
  EFFORT_LEVELS,
  type EffortKnobs,
  type EffortLevel,
  effortKnobs,
  isEffortLevel,
} from './effort/effort.js';
export {
  createLoopDetector,
  DEFAULT_LOOP_ABORT_AFTER,
  DEFAULT_LOOP_STEER_AFTER,
  DEFAULT_WANDER_ABORT_AFTER,
  DEFAULT_WANDER_STEER_AFTER,
  EXPLORATION_TOOLS,
  isExplorationTool,
  type LoopCause,
  type LoopDetector,
  type LoopDetectorConfig,
  type LoopSignal,
  type LoopSnapshot,
  loopDetectorConfig,
  toolCallSignature,
} from './loop/loop-detector.js';
export {
  ADVANCED_CLASSES,
  inspectModelSize,
  isAdvancedClass,
  isSmallModel,
  type ModelLike,
  type ModelSizeInfo,
  parseModelParams,
  SMALL_MODEL_THRESHOLD_B,
  smallModelWarning,
} from './model/model-size.js';
export {
  type CallModel,
  type CallModelRequest,
  callModelFromEnv,
  createOpenAiCompatCallModel,
  type OpenAiCompatConfig,
  UTILITY_API_KEY_ENV,
  UTILITY_BASE_URL_ENV,
  UTILITY_MODEL_ENV,
} from './model-call/call-model.js';
export { createBashFlagger, interpretFlagReply } from './permissions/flag-bash.js';
export {
  type BashFlagger,
  type EvaluateInput,
  evaluateToolCall,
  isPermissionMode,
  PERMISSION_MODES,
  type PermissionController,
  type PermissionMode,
  type RegisterPermissionsOptions,
  registerPermissions,
  type ToolCallDecision,
} from './permissions/modes.js';
export {
  checkScaryBash,
  DEFAULT_SCARY_RULES,
  extendScaryRules,
  SCARY_EXACT,
  SCARY_PATTERNS,
  type ScaryBashRules,
} from './permissions/rules.js';
export {
  ALWAYS_ACTIVE_TOOLS,
  isToolSearchOnly,
  PRESET_TOOLS,
  type ResolvePresetOptions,
  resolvePresetTools,
  SUBAGENT_PRESET_CLASSES,
  TOOL_SEARCH_TOOL_NAME,
} from './presets/presets.js';
export {
  augmentSystemPrompt,
  CAPABILITY_PROMPT,
  CAPABILITY_PROMPT_MARKER,
} from './prompt/capability-prompt.js';
export {
  connectRepairBridge as connectHarnessRepairBridge,
  type LiveRepairDeps,
  REPAIR_BRIDGE_HELLO,
  REPAIR_BRIDGE_READY,
  type RepairBridgeReady,
} from './repair/bridge.js';
export {
  createToolCallFixer,
  extractJsonObject,
  withRepairAttempts,
} from './repair/fixer.js';
export {
  createHarnessExtraRungs,
  createRung3,
  createRung4,
  createRung5,
  createSessionRepairDeps,
  type HarnessRepairDeps,
  type RepairContext,
  type RepairResult,
  type RepairRung,
  relaxToolSchema,
  type ToolCallFixer,
  type ToolSchemaLike,
} from './repair/rungs.js';
export {
  adversarialCheck,
  parseReview,
  type ReviewInput,
  type ReviewResult,
  reviewOutput,
} from './review/review.js';
export {
  isSkillPath,
  registerSkillInstructions,
  SKILL_INSTRUCTIONS_TAG,
  type SkillContextMessage,
  skillNameFromPath,
  withSkillInstructions,
  wrapSkillContent,
} from './skills/skill-instructions.js';
export {
  DEFAULT_CONFIG,
  HARNESS_CLASSIFY_ENTRY,
  HARNESS_CONFIG_ENTRY,
  HARNESS_LOOP_ENTRY,
  HARNESS_REPAIR_ENTRY,
  HARNESS_REVIEW_ENTRY,
  HARNESS_STAGES,
  HARNESS_TITLE_ENTRY,
  HARNESS_VERIFY_ENTRY,
  type HarnessConfig,
  type HarnessStage,
  type HarnessStatus,
  isHarnessStage,
  isPlanItemStatus,
  PLAN_ITEM_STATUSES,
  type PlanItem,
  type PlanItemStatus,
  type PresetSelection,
  restoreConfig,
  type StoredEntryLike,
  updateConfig,
} from './state.js';
export {
  type BudgetInputs,
  buildChildSpawnPlan,
  type ChildAgentResult,
  type ConcurrencyBudget,
  computeConcurrencyBudget,
  deriveSubagentName,
  detectBudget,
  HARNESS_SUBAGENTS_STATUS_KEY,
  type HarnessSubagentsStatus,
  MAX_SUBAGENT_DEPTH,
  type RunChildAgentOptions,
  readSubagentDepth,
  registerSubagentTool,
  runChildAgent,
  type SchedulerSnapshot,
  SPAWN_SUBAGENT_TOOL_NAME,
  SUBAGENT_DEPTH_ENV,
  SubagentScheduler,
  type SubagentStatus,
  type SubagentStatusItem,
} from './subagent/index.js';
export {
  ASK_USER_SENTINEL,
  type AskUserAnswer,
  type AskUserMode,
  type AskUserSpec,
  describeAnswer,
  encodeAskUser,
  registerAskUser,
  specFromParams,
} from './tools/ask-user.js';
export {
  normalizePlan,
  PLAN_TOOL_NAME,
  type PlanToolOptions,
  planSummary,
  registerPlanTool,
} from './tools/plan-tool.js';
export {
  registerToolSearch,
  type SearchToolsOptions,
  searchTools,
  type ToolLike,
  type ToolMatch,
  type ToolSearchOptions,
} from './tools/tool-search.js';
export {
  type CheckOutcome,
  detectPackageManager,
  detectProjectCheck,
  type ExecLike,
  makeExecBashRunner,
  makeFsProbe,
  type ProjectCheck,
  type ProjectProbe,
  runCheck,
  runVerifyPass,
  syntaxCheckCommand,
  VERIFY_TIMEOUT_MS,
  type VerifyBashRunner,
  type VerifyPassDeps,
  type VerifyPassResult,
} from './verify/verify.js';
