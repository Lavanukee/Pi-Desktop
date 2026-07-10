/**
 * Repair ladder rungs 3–5 (the harness's half of the tool-call repair ladder).
 *
 * The provider (`@pi-desktop/provider-llamacpp`) owns:
 *   RUNG 1 — syntactic recovery (fences, truncation, trailing commas).
 *   RUNG 2 — schema validation + one optional fixer-model call.
 *
 * This module owns the escalation rungs, exported as an ordered
 * `RepairRung[]` that W3 passes to the provider via
 * `repairToolCallArguments(raw, { …, extraRungs: createHarnessExtraRungs(deps) })`:
 *
 *   RUNG 3 — "show failure to model": pi already returns tool errors to the
 *            model, which re-attempts. Rung 3 is therefore pi-native; our rung
 *            here only *records/counts* that the boundary was reached (via the
 *            injected `recordFailureShownToModel`) and passes the best value
 *            forward without resolving.
 *   RUNG 4 — per-session schema relaxation: count the failure for this tool,
 *            surface it to the user (`confirmRelax` → ctx.ui.confirm), and — on
 *            approval — accept the syntactically-valid args under a relaxed
 *            schema (the extension re-registers the same-name tool with a looser
 *            schema via `relaxSchema`).
 *   RUNG 5 — terminate: once a tool has failed unrepairably `abortThreshold`
 *            times this session, call `abort` (ctx.abort()).
 *
 * Everything the rungs touch outside pure logic is injected, so escalation is
 * testable without a live session, and the observable knobs (e.g.
 * `abortThreshold`) are driven by the effort slider.
 */

import type { RepairContext, RepairResult, RepairRung, ToolSchemaLike } from './types.js';

export type {
  RepairContext,
  RepairResult,
  RepairRung,
  ToolCallFixer,
  ToolSchemaLike,
} from './types.js';

export interface HarnessRepairDeps {
  /** Called each time any harness rung is entered (telemetry / appendEntry). */
  readonly onRung?: (info: {
    readonly rung: number;
    readonly toolName: string;
    readonly raw: string;
  }) => void;

  // --- Rung 3 ---------------------------------------------------------------
  /** Rung 3: record that the failure is being shown to the model for a native retry. */
  readonly recordFailureShownToModel?: (toolName: string) => void;

  // --- Rung 4 ---------------------------------------------------------------
  /** Rung 4: increment and return this tool's session failure count. */
  readonly bumpFailureCount?: (toolName: string) => number;
  /**
   * Rung 4: user-visible failure gate (→ ctx.ui.confirm). Resolve `true` to
   * accept relaxed args, `false` to keep failing. Absent → auto-approve.
   */
  readonly confirmRelax?: (info: {
    readonly toolName: string;
    readonly error: string;
    readonly count: number;
  }) => Promise<boolean>;
  /**
   * Rung 4: perform the per-session schema relaxation side effect — re-register
   * the same-name tool with a looser schema so subsequent calls validate. The
   * accepted value is `ctx.current`; return value is ignored.
   */
  readonly relaxSchema?: (info: {
    readonly toolName: string;
    readonly schema: ToolSchemaLike | undefined;
    readonly current: Record<string, unknown>;
  }) => void;

  // --- Rung 5 ---------------------------------------------------------------
  /** Read this tool's current session failure count (without incrementing). */
  readonly getFailureCount?: (toolName: string) => number;
  /** Rung 5: abort after this many unrepairable failures. Default 3. */
  readonly abortThreshold?: number;
  /** Rung 5: terminate the operation (→ ctx.abort()). */
  readonly abort?: (info: { readonly toolName: string; readonly count: number }) => void;
}

/** Rung 3 — pi-native "show failure to model" boundary; records and passes through. */
export function createRung3(deps: HarnessRepairDeps): RepairRung {
  return (ctx: RepairContext): RepairResult => {
    deps.onRung?.({ rung: ctx.rung, toolName: ctx.toolName, raw: ctx.raw });
    deps.recordFailureShownToModel?.(ctx.toolName);
    // Do not resolve: the real retry is pi re-prompting the model with the error.
    return { ok: false, value: ctx.current, error: 'shown to model for retry' };
  };
}

/** Rung 4 — per-session schema relaxation + user-visible failure. */
export function createRung4(deps: HarnessRepairDeps): RepairRung {
  return async (ctx: RepairContext): Promise<RepairResult> => {
    deps.onRung?.({ rung: ctx.rung, toolName: ctx.toolName, raw: ctx.raw });
    const count = deps.bumpFailureCount?.(ctx.toolName) ?? 1;

    // Nothing syntactically usable to relax → let rung 5 decide.
    if (ctx.current === undefined) {
      return { ok: false, error: 'no syntactically-valid args to relax' };
    }

    const error = `${ctx.toolName} args failed schema validation (attempt ${count})`;
    const approved =
      deps.confirmRelax === undefined
        ? true
        : await deps.confirmRelax({ toolName: ctx.toolName, error, count });
    if (!approved) {
      return { ok: false, value: ctx.current, error: 'user declined schema relaxation' };
    }

    deps.relaxSchema?.({ toolName: ctx.toolName, schema: ctx.schema, current: ctx.current });
    return { ok: true, value: ctx.current, rung: 4 };
  };
}

/** Rung 5 — terminate on repeated unrepairable failures. */
export function createRung5(deps: HarnessRepairDeps): RepairRung {
  const threshold = deps.abortThreshold ?? 3;
  return (ctx: RepairContext): RepairResult => {
    deps.onRung?.({ rung: ctx.rung, toolName: ctx.toolName, raw: ctx.raw });
    const count = deps.getFailureCount?.(ctx.toolName) ?? 0;
    if (count >= threshold) {
      deps.abort?.({ toolName: ctx.toolName, count });
      return { ok: false, error: `aborted ${ctx.toolName} after ${count} unrepairable failures` };
    }
    return { ok: false, error: `unrepairable this round (${count}/${threshold})` };
  };
}

/**
 * Build the ordered rung-3→4→5 array that plugs into the provider's
 * `extraRungs`. This is the exact export W3 wires:
 *
 * ```ts
 * import { createHarnessExtraRungs } from '@pi-desktop/harness';
 * const result = await repairToolCallArguments(raw, {
 *   toolName, schema, fixer,
 *   extraRungs: createHarnessExtraRungs(deps),
 * });
 * ```
 */
export function createHarnessExtraRungs(deps: HarnessRepairDeps = {}): RepairRung[] {
  return [createRung3(deps), createRung4(deps), createRung5(deps)];
}

/**
 * Build a ready-to-wire deps object backed by a shared per-tool failure counter.
 *
 * This is the convenience W3/app uses so the counter it reads for status is the
 * same one the rungs increment. Inject `confirmRelax` (→ ctx.ui.confirm),
 * `relaxSchema` (→ same-name registerTool with a looser schema), `abort`
 * (→ ctx.abort), `onRung` (→ pi.appendEntry telemetry) and `abortThreshold`
 * (→ effortKnobs(config.effort).abortThreshold):
 *
 * ```ts
 * const { deps, failureCounts } = createSessionRepairDeps({
 *   abortThreshold: effortKnobs(config.effort).abortThreshold,
 *   onRung: (info) => pi.appendEntry('harness/repair', info),
 *   confirmRelax: ({ toolName, error }) => ctx.ui.confirm(`Relax ${toolName}?`, error),
 *   relaxSchema: ({ toolName }) => reRegisterRelaxed(toolName),
 *   abort: () => ctx.abort(),
 * });
 * const result = await repairToolCallArguments(raw, {
 *   toolName, schema, extraRungs: createHarnessExtraRungs(deps),
 * });
 * ```
 */
export function createSessionRepairDeps(overrides: HarnessRepairDeps = {}): {
  deps: HarnessRepairDeps;
  failureCounts: Map<string, number>;
} {
  const failureCounts = new Map<string, number>();
  const deps: HarnessRepairDeps = {
    ...overrides,
    bumpFailureCount: (toolName: string) => {
      const n = (failureCounts.get(toolName) ?? 0) + 1;
      failureCounts.set(toolName, n);
      return n;
    },
    getFailureCount: (toolName: string) => failureCounts.get(toolName) ?? 0,
  };
  return { deps, failureCounts };
}
