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

/**
 * JSON-Schema-shaped view of a TypeBox tool parameter schema. Structurally
 * identical to the provider's `ToolSchemaLike` (kept in sync deliberately, not
 * imported) so the harness can build/relax schemas the provider then validates.
 */
export interface ToolSchemaLike {
  readonly type?: string;
  readonly properties?: Record<string, ToolSchemaLike | undefined>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: ToolSchemaLike;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly ToolSchemaLike[];
  readonly const?: unknown;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
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

/**
 * One rung-2 fixer-model call. Mirrors the provider's `ToolCallFixer` (declared
 * here too so the harness builds one without importing the provider). Returns a
 * repaired arguments object, or `undefined` to let the ladder continue.
 */
export type ToolCallFixer = (input: {
  readonly raw: string;
  readonly toolName: string;
  readonly schema: ToolSchemaLike | undefined;
  readonly error: string;
}) => Promise<Record<string, unknown> | undefined>;
