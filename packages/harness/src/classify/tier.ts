/**
 * Coarse task-complexity tiers + the user-facing model-capability tiers, and the
 * pure task→tier maps the app uses to route Auto model selection (round-12).
 *
 * The harness only PUBLISHES the active model tier (via `HarnessStatus.activeTier`);
 * resolving a tier to a concrete model + performing the llama-server switch is the
 * APP's job (it alone can restart the server + pi). This module stays pure +
 * dependency-free so both the harness and the renderer import it cheaply.
 */
import type { TaskClass } from './classify.js';

/** Coarse task complexity the classifier emits (jedd's quick/balanced/complex). */
export type CoarseTier = 'quick' | 'balanced' | 'complex';

/** The model-capability tier a coarse task maps to (the user-facing labels). */
export type ModelTier = 'fast' | 'balanced' | 'intelligent';

export const COARSE_TIERS: readonly CoarseTier[] = ['quick', 'balanced', 'complex'];
export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'balanced', 'intelligent'];

/** User-facing labels (the grey model name renders separately, below these). */
export const TIER_LABEL: Record<ModelTier, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  intelligent: 'Intelligent',
};

/** 1:1 coarse→model tier (kept as two vocabularies because jedd uses both). */
export const COARSE_TO_MODEL: Record<CoarseTier, ModelTier> = {
  quick: 'fast',
  balanced: 'balanced',
  complex: 'intelligent',
};

export function isCoarseTier(v: unknown): v is CoarseTier {
  return typeof v === 'string' && (COARSE_TIERS as readonly string[]).includes(v);
}

export function isModelTier(v: unknown): v is ModelTier {
  return typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v);
}

/**
 * Map a concrete {@link TaskClass} → coarse tier. Pure, deterministic, tunable —
 * this switch is the SINGLE knob for the app's Auto router:
 *   simple-QA                                → quick
 *   basic-tools | other | file-ops | 2d-art  → balanced
 *   coding | browser-use | 3d | motion-graphics | advanced-video → complex
 *
 * (2d-art / file-ops are LLM-orchestrated, not heavy reasoning → balanced;
 *  gen/agentic categories that plan multi-step work → complex.)
 */
export function coarseTier(cls: TaskClass): CoarseTier {
  switch (cls) {
    case 'simple-QA':
      return 'quick';
    case 'basic-tools':
    case 'other':
    case 'file-ops':
    case '2d-art':
      return 'balanced';
    case 'coding':
    case 'browser-use':
    case '3d':
    case 'motion-graphics':
    case 'advanced-video':
      return 'complex';
  }
}

/** The user-facing model tier a task class routes to. */
export function modelTierForClass(cls: TaskClass): ModelTier {
  return COARSE_TO_MODEL[coarseTier(cls)];
}
