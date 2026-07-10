/**
 * Repair-ladder seam types.
 *
 * These mirror the contract exported by
 * `@pi-desktop/provider-llamacpp/src/repair.ts` (which owns rungs 1–2 and the
 * `extraRungs` hook on `repairToolCallArguments`). They are re-declared here —
 * structurally identical — so the harness stays decoupled from the provider's
 * build while producing rungs the provider can consume directly. The
 * integration test feeds these rungs through the provider's *real*
 * `repairToolCallArguments` to prove the structural match.
 */

/** JSON-Schema-shaped view of a TypeBox tool parameter schema. */
export interface ToolSchemaLike {
  readonly type?: string;
  readonly properties?: Record<string, { type?: string } | undefined>;
  readonly required?: readonly string[];
}

export interface RepairContext {
  /** Accumulated (possibly malformed) tool-call arguments string. */
  readonly raw: string;
  readonly toolName: string;
  readonly schema: ToolSchemaLike | undefined;
  /** 1-based rung index this rung represents. */
  readonly rung: number;
  /** Best repaired value produced by an earlier rung, if any. */
  readonly current: Record<string, unknown> | undefined;
}

export interface RepairResult {
  readonly ok: boolean;
  readonly value?: Record<string, unknown>;
  /** Which rung produced the successful value. */
  readonly rung?: number;
  readonly error?: string;
}

export type RepairRung = (ctx: RepairContext) => RepairResult | Promise<RepairResult>;
