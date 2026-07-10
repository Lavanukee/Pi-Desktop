/**
 * Small-model detection + advanced-task warning.
 *
 * pi's `Model` carries no parameter-count field, so size is inferred from the
 * model id/name (e.g. "qwen3.6-27b", "gemma4-e2b", "llama-3.1-8b-instruct").
 * When a small model (≤ threshold B) is selected for an advanced task class, the
 * harness warns the user that quality may suffer.
 */

import type { TaskClass } from '../classify/classify.js';

/** Models at or below this parameter count (billions) are "small". */
export const SMALL_MODEL_THRESHOLD_B = 12;

/** Task classes that meaningfully stress a small local model. */
export const ADVANCED_CLASSES: ReadonlySet<TaskClass> = new Set<TaskClass>([
  'full-shebang',
  'browser-use',
  'motion-graphics',
  'advanced-video',
  '3d',
  '2d-art',
]);

/** Minimal structural view of a model (avoids depending on pi-ai's Model<any>). */
export interface ModelLike {
  readonly id: string;
  readonly name?: string;
}

/**
 * Parse an approximate parameter count (in billions) from a model id/name.
 * Handles: plain "27b" / "7B", decimal "3.8b", Gemma "E2B"/"E4B" (effective),
 * and MoE "35b-a3b" (returns the total, 35). Returns `null` when unknown.
 */
export function parseModelParams(idOrName: string): number | null {
  const s = idOrName.toLowerCase();

  // Gemma-style effective size, e.g. "e2b", "e4b".
  const eMatch = s.match(/\be(\d+(?:\.\d+)?)b\b/);
  if (eMatch?.[1] !== undefined) return Number.parseFloat(eMatch[1]);

  // First "<number>b" token, e.g. "27b" in "qwen3.6-27b" or "35b" in "35b-a3b".
  const bMatch = s.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (bMatch?.[1] !== undefined) return Number.parseFloat(bMatch[1]);

  return null;
}

export interface ModelSizeInfo {
  /** Inferred parameter count in billions, or null if unknown. */
  readonly params: number | null;
  /** True when params is known and ≤ threshold. Unknown size → not treated as small. */
  readonly isSmall: boolean;
}

export function inspectModelSize(
  model: ModelLike,
  thresholdB: number = SMALL_MODEL_THRESHOLD_B,
): ModelSizeInfo {
  const params = parseModelParams(model.name ?? model.id) ?? parseModelParams(model.id);
  return { params, isSmall: params !== null && params <= thresholdB };
}

/** True when a model is known-small (≤ threshold B). Unknown size → false. */
export function isSmallModel(
  model: ModelLike,
  thresholdB: number = SMALL_MODEL_THRESHOLD_B,
): boolean {
  return inspectModelSize(model, thresholdB).isSmall;
}

/** True when the class is one that stresses a small model. */
export function isAdvancedClass(cls: TaskClass): boolean {
  return ADVANCED_CLASSES.has(cls);
}

/**
 * Decide whether to warn: a small model paired with an advanced task class.
 * Returns a ready-to-show message, or null when no warning is warranted.
 */
export function smallModelWarning(
  model: ModelLike,
  cls: TaskClass,
  thresholdB: number = SMALL_MODEL_THRESHOLD_B,
): string | null {
  const { params, isSmall } = inspectModelSize(model, thresholdB);
  if (!isSmall || !isAdvancedClass(cls)) return null;
  const size = params !== null ? `${params}B` : 'small';
  return `${model.name ?? model.id} (~${size}) is small for a "${cls}" task — results may be unreliable. Consider a larger model.`;
}
