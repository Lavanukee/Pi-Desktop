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
  classify,
  classifyWithEscalation,
  TASK_CLASSES,
  type TaskClass,
} from './classify/classify.js';
import { createClassifierEscalation } from './classify/escalation.js';
import { effortKnobs, isEffortLevel } from './effort/effort.js';
import { parseModelParams, smallModelWarning } from './model/model-size.js';
import { type CallModel, callModelFromEnv } from './model-call/call-model.js';
import { createBashFlagger } from './permissions/flag-bash.js';
import {
  isPermissionMode,
  type PermissionController,
  registerPermissions,
} from './permissions/modes.js';
import { resolvePresetTools } from './presets/presets.js';
import { connectRepairBridge, type LiveRepairDeps } from './repair/bridge.js';
import { createToolCallFixer, withRepairAttempts } from './repair/fixer.js';
import { createHarnessExtraRungs, type HarnessRepairDeps } from './repair/rungs.js';
import { adversarialCheck, reviewOutput } from './review/review.js';
import {
  DEFAULT_CONFIG,
  HARNESS_CLASSIFY_ENTRY,
  HARNESS_CONFIG_ENTRY,
  HARNESS_REPAIR_ENTRY,
  HARNESS_REVIEW_ENTRY,
  type HarnessConfig,
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
import { registerToolSearch } from './tools/tool-search.js';

export const packageName = '@pi-desktop/harness';

interface HarnessRuntime {
  config: HarnessConfig;
  activeClass: TaskClass | null;
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
}

/** Options for {@link wireHarness}. All optional; the app passes none (`-e` load). */
export interface WireHarnessOptions {
  /**
   * The utility-model call powering the fixer, reviewer, and classifier
   * escalation. Omitted → built from env (`PI_DESKTOP_UTILITY_*`); still absent →
   * every model-dependent feature degrades to heuristic/skip.
   */
  readonly callModel?: CallModel;
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
}

function getEntries(ctx: ExtensionContext): StoredEntryLike[] {
  const sm = ctx.sessionManager as unknown as { getEntries?: () => StoredEntryLike[] };
  return sm.getEntries?.() ?? [];
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
  };

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
      // Rung trace (no `ok` → not counted as a failure).
      onRung: (info) =>
        pi.appendEntry(HARNESS_REPAIR_ENTRY, { rung: info.rung, toolName: info.toolName }),
      bumpFailureCount: (t) => {
        const n = (failureCounts.get(t) ?? 0) + 1;
        failureCounts.set(t, n);
        return n;
      },
      getFailureCount: (t) => failureCounts.get(t) ?? 0,
      confirmRelax: async ({ toolName, error, count }) => {
        const ctx = runtime.currentCtx;
        if (ctx?.hasUI !== true) return true; // headless → auto-approve relax
        return ctx.ui.confirm(
          `Relax "${toolName}" schema?`,
          `${error} (attempt ${count}). Accept the arguments as-is?`,
        );
      },
      relaxSchema: ({ toolName }) => {
        // v1 records the relaxation (no `ok` → not a failure). Genuine same-name
        // re-registration with a looser schema is tool-specific and deferred.
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
      // Authoritative per-call outcome — the only entry carrying `ok`.
      onRepair: (info) =>
        pi.appendEntry(HARNESS_REPAIR_ENTRY, {
          toolName: info.toolName,
          rung: info.rung,
          ok: info.ok,
        }),
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

    const task = runtime.lastPrompt;
    const issues: string[] = [];
    if (knobs.reviewPasses > 0) {
      const r = await reviewOutput(callModel, { task, output });
      if (!r.ok) issues.push(...r.issues);
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
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Reviewer flagged ${issues.length} issue(s); requesting a revision.`,
        'warning',
      );
    }
    pi.sendUserMessage?.(
      `A reviewer flagged issues with your last result:\n- ${issues.join('\n- ')}\nPlease revise to address these.`,
      { deliverAs: 'followUp' },
    );
    return true;
  }

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
      activeTools: runtime.activeTools,
      model: runtime.model?.id ?? null,
      modelParams: runtime.model ? parseModelParams(runtime.model.name ?? runtime.model.id) : null,
      contextPercent: usage?.percent ?? null,
      runningTaskMs: runtime.taskStart !== null ? Date.now() - runtime.taskStart : null,
      repairFailures: countRepairFailures(getEntries(ctx)),
      plan: runtime.plan,
      planTitle: runtime.planTitle,
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
    const tools = resolvePresetTools(cls, available);
    pi.setActiveTools(tools);
    runtime.activeClass = cls;
    runtime.activeTools = tools;
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

  // Restore persisted config + start the status timer on session start.
  pi.on('session_start', (_event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.config = restoreConfig(getEntries(ctx));
    runtime.permission.setMode(runtime.config.mode);
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
    let cls: TaskClass;
    if (runtime.config.preset === 'auto') {
      const input = {
        prompt: event.prompt,
        hasImages: (event.images?.length ?? 0) > 0,
        priorClass: runtime.activeClass ?? undefined,
        turnIndex: runtime.turnIndex,
      };
      cls =
        asyncClassifier !== undefined
          ? (await classifyWithEscalation(input, { asyncClassifier })).class
          : classify(input).class;
    } else {
      cls = runtime.config.preset;
    }
    applyPreset(cls, ctx);
    pi.appendEntry(HARNESS_CLASSIFY_ENTRY, { class: cls, turnIndex: runtime.turnIndex });
  });

  // Running-task timer.
  pi.on('agent_start', (_event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.taskStart = Date.now();
    publishStatus(ctx);
  });
  pi.on('agent_end', async (event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.taskStart = null;
    publishStatus(ctx);
    // Effort high/max → reviewer + adversarial critique of the produced result.
    await reviewTurn(extractAssistantText(event.messages), ctx);
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
  EFFORT_KNOBS,
  EFFORT_LEVELS,
  type EffortKnobs,
  type EffortLevel,
  effortKnobs,
  isEffortLevel,
} from './effort/effort.js';
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
  TOOL_SEARCH_TOOL_NAME,
} from './presets/presets.js';
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
  DEFAULT_CONFIG,
  HARNESS_CLASSIFY_ENTRY,
  HARNESS_CONFIG_ENTRY,
  HARNESS_REPAIR_ENTRY,
  HARNESS_REVIEW_ENTRY,
  type HarnessConfig,
  type HarnessStatus,
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
