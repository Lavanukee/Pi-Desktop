/**
 * Machine → recommended model, quant, and launch mode.
 *
 * Budget tiers (from the plan):
 * - 16GB  → Gemma4-12B Q4_K_M (fast-text)
 * - 32GB  → Qwen3.6-27B Q4_K_M (fast-text, MTP)
 * - 48GB+ → Qwen3.6-27B Q6_K   (fast-text, MTP)
 * Every tier also gets a small utility-model slot (Gemma4 E2B Q4_K_M), used for
 * cheap side-tasks (title generation, the rung-2 tool-call fixer, etc.).
 * Below 16GB we fall back to the utility model as the primary.
 *
 * Pure function — no I/O — so it unit-tests trivially across the tier
 * boundaries.
 */
import {
  type CatalogFile,
  type CatalogModel,
  GEMMA4_E2B,
  getCatalogModel,
  type LaunchMode,
} from './catalog.js';

export type BudgetTier = '<16GB' | '16GB' | '32GB' | '48GB+';

export interface Recommendation {
  readonly tier: BudgetTier;
  readonly model: CatalogModel;
  readonly file: CatalogFile;
  readonly launchMode: LaunchMode;
  /** Always-present small utility model slot. */
  readonly utilityModel: CatalogModel;
  readonly utilityFile: CatalogFile;
  readonly rationale: string;
}

interface Pick {
  readonly modelId: string;
  readonly quant: string;
  readonly launchMode: LaunchMode;
}

function resolve(pick: Pick): { model: CatalogModel; file: CatalogFile } {
  const model = getCatalogModel(pick.modelId);
  if (model === undefined) throw new Error(`catalog model not found: ${pick.modelId}`);
  const file = model.files.find((f) => f.quant === pick.quant);
  if (file === undefined) {
    throw new Error(`quant ${pick.quant} not found in ${pick.modelId}`);
  }
  return { model, file };
}

const UTILITY: Pick = {
  modelId: GEMMA4_E2B.id,
  quant: 'Q4_K_M',
  launchMode: 'fast-text',
};

/** Recommend a model configuration for the given RAM budget. */
export function recommend(hw: { totalRamGB: number }): Recommendation {
  const ram = hw.totalRamGB;

  let tier: BudgetTier;
  let primary: Pick;
  if (ram >= 48) {
    tier = '48GB+';
    primary = { modelId: 'qwen3.6-27b-mtp', quant: 'Q6_K', launchMode: 'fast-text' };
  } else if (ram >= 32) {
    tier = '32GB';
    primary = { modelId: 'qwen3.6-27b-mtp', quant: 'Q4_K_M', launchMode: 'fast-text' };
  } else if (ram >= 16) {
    tier = '16GB';
    primary = { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M', launchMode: 'fast-text' };
  } else {
    tier = '<16GB';
    primary = UTILITY;
  }

  const { model, file } = resolve(primary);
  const utility = resolve(UTILITY);

  const rationale =
    tier === '<16GB'
      ? `${ram}GB RAM is below the 16GB floor for a large model; running the ` +
        `${utility.model.displayName} utility model (${UTILITY.quant}) as the primary.`
      : `${ram}GB RAM → ${tier} tier → ${model.displayName} ${file.quant} in ` +
        `${primary.launchMode} mode (needs ~${model.minRamGB}GB), plus the ` +
        `${utility.model.displayName} utility slot.`;

  return {
    tier,
    model,
    file,
    launchMode: primary.launchMode,
    utilityModel: utility.model,
    utilityFile: utility.file,
    rationale,
  };
}
