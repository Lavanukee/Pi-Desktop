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
import { classify, TASK_CLASSES, type TaskClass } from './classify/classify.js';
import { effortKnobs, isEffortLevel } from './effort/effort.js';
import { parseModelParams, smallModelWarning } from './model/model-size.js';
import {
  isPermissionMode,
  type PermissionController,
  registerPermissions,
} from './permissions/modes.js';
import { resolvePresetTools } from './presets/presets.js';
import {
  DEFAULT_CONFIG,
  HARNESS_CLASSIFY_ENTRY,
  HARNESS_CONFIG_ENTRY,
  HARNESS_REPAIR_ENTRY,
  type HarnessConfig,
  type HarnessStatus,
  restoreConfig,
  type StoredEntryLike,
  updateConfig,
} from './state.js';
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
}

/** A handle returned by {@link wireHarness} for tests + programmatic wiring. */
export interface HarnessHandle {
  readonly controller: PermissionController;
  getConfig(): HarnessConfig;
  getStatus(ctx: ExtensionContext): HarnessStatus;
  applyPreset(cls: TaskClass, ctx: ExtensionContext): void;
}

function getEntries(ctx: ExtensionContext): StoredEntryLike[] {
  const sm = ctx.sessionManager as unknown as { getEntries?: () => StoredEntryLike[] };
  return sm.getEntries?.() ?? [];
}

function countRepairFailures(entries: readonly StoredEntryLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    if (e.type !== 'custom' || e.customType !== HARNESS_REPAIR_ENTRY) continue;
    const data = e.data as { toolName?: unknown } | undefined;
    const toolName = typeof data?.toolName === 'string' ? data.toolName : undefined;
    if (toolName === undefined) continue;
    counts[toolName] = (counts[toolName] ?? 0) + 1;
  }
  return counts;
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
export function wireHarness(pi: ExtensionAPI): HarnessHandle {
  const runtime: HarnessRuntime = {
    config: DEFAULT_CONFIG,
    activeClass: null,
    activeTools: [],
    taskStart: null,
    turnIndex: 0,
    model: null,
    permission: { getMode: () => DEFAULT_CONFIG.mode, setMode: () => {} },
    statusTimer: null,
  };

  // Tool search — always available so the model can pull in missing tools.
  registerToolSearch(pi, {
    onActivate: (added) => {
      runtime.activeTools = Array.from(new Set([...runtime.activeTools, ...added]));
    },
  });

  // Permission gate.
  runtime.permission = registerPermissions(pi, { initialMode: runtime.config.mode });

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
    runtime.config = restoreConfig(getEntries(ctx));
    runtime.permission.setMode(runtime.config.mode);
    if (runtime.statusTimer !== null) clearInterval(runtime.statusTimer);
    runtime.statusTimer = setInterval(() => publishStatus(ctx), 1000);
    publishStatus(ctx);
  });

  pi.on('session_shutdown', () => {
    if (runtime.statusTimer !== null) {
      clearInterval(runtime.statusTimer);
      runtime.statusTimer = null;
    }
  });

  // Classify each task and load its preset before the agent loop runs.
  pi.on('before_agent_start', (event, ctx) => {
    runtime.turnIndex += 1;
    const cls: TaskClass =
      runtime.config.preset === 'auto'
        ? classify({
            prompt: event.prompt,
            hasImages: (event.images?.length ?? 0) > 0,
            priorClass: runtime.activeClass ?? undefined,
            turnIndex: runtime.turnIndex,
          }).class
        : runtime.config.preset;
    applyPreset(cls, ctx);
    pi.appendEntry(HARNESS_CLASSIFY_ENTRY, { class: cls, turnIndex: runtime.turnIndex });
  });

  // Running-task timer.
  pi.on('agent_start', (_event, ctx) => {
    runtime.taskStart = Date.now();
    publishStatus(ctx);
  });
  pi.on('agent_end', (_event, ctx) => {
    runtime.taskStart = null;
    publishStatus(ctx);
  });

  // Model changes → small-model warning + status refresh.
  pi.on('model_select', (event, ctx) => {
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
          publishStatus(ctx);
          const k = effortKnobs(rest);
          ctx.ui.notify(
            `effort → ${rest} (repairAttempts ${k.repairAttempts}, abortThreshold ${k.abortThreshold}, reviewPasses ${k.reviewPasses})`,
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
  isToolSearchOnly,
  PRESET_TOOLS,
  type ResolvePresetOptions,
  resolvePresetTools,
  TOOL_SEARCH_TOOL_NAME,
} from './presets/presets.js';
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
  type ToolSchemaLike,
} from './repair/rungs.js';
export {
  DEFAULT_CONFIG,
  HARNESS_CLASSIFY_ENTRY,
  HARNESS_CONFIG_ENTRY,
  HARNESS_REPAIR_ENTRY,
  type HarnessConfig,
  type HarnessStatus,
  type PresetSelection,
  restoreConfig,
  type StoredEntryLike,
  updateConfig,
} from './state.js';
export {
  registerToolSearch,
  type SearchToolsOptions,
  searchTools,
  type ToolLike,
  type ToolMatch,
  type ToolSearchOptions,
} from './tools/tool-search.js';
