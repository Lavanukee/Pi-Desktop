/**
 * Machine → recommended (speed-optimized) model, quant, and launch mode.
 *
 * Round-11 Wave C: every tier's PRIMARY pick is a real speculative-decoding
 * variant (MTP embedded/sibling, or an EAGLE-3 draft pair) so consumers get the
 * fast path by default. Tiers span 8GB→128GB:
 *
 *   -   8GB → Qwen3.5-4B  Q4_K_M   (MTP, embedded)
 *   -  16GB → Gemma4-12B  Q4_K_M   (MTP sibling; vision-capable)
 *   -  24GB → Qwen3.6-27B Q4_K_M   (MTP, embedded)
 *   -  32GB → Qwen3.6-35B-A3B UD-Q4_K_M (MTP MoE — 3B active, very fast)
 *   -  48GB → Qwen3.6-35B-A3B UD-Q6_K   (MTP MoE, higher quality)
 *   -  64/96/128GB → Qwen3.6-35B-A3B UD-Q6_K (the fastest strong local pick;
 *                    extra RAM buys context/headroom — a single-file GGUF bigger
 *                    than ~32GB needs sharded downloads, a follow-up).
 *
 * Beside the primary, a small "Recommended for your Mac" {@link SimplePick} set
 * (1–3 clear picks) is produced for NON-POWER-USERS: the speed pick, a
 * vision-capable pick when it fits, and the lightweight helper.
 *
 * Every tier also gets a small utility-model slot (Gemma4 E2B Q4_K_M) for cheap
 * side-tasks (title generation, the rung-2 tool-call fixer, etc.). Pure function
 * — no I/O — so it unit-tests trivially across the tier boundaries.
 */
import {
  type CatalogFile,
  type CatalogModel,
  GEMMA4_E2B,
  getCatalogModel,
  type LaunchMode,
  type ModelTier,
  type SpecMethod,
} from './catalog.js';

export type BudgetTier =
  | '<8GB'
  | '8GB'
  | '16GB'
  | '24GB'
  | '32GB'
  | '48GB'
  | '64GB'
  | '96GB'
  | '128GB';

/** One non-power-user pick in the "Recommended for your Mac" simple set. */
export interface SimplePick {
  readonly role: 'speed' | 'vision' | 'utility';
  readonly model: CatalogModel;
  readonly file: CatalogFile;
  readonly launchMode: LaunchMode;
  /** Speed method this pick runs with (undefined = plain decode). */
  readonly spec?: SpecMethod;
  /** True when this pick can take image input (in multimodal launch). */
  readonly vision: boolean;
}

export interface Recommendation {
  readonly tier: BudgetTier;
  readonly model: CatalogModel;
  readonly file: CatalogFile;
  readonly launchMode: LaunchMode;
  /** Always-present small utility model slot. */
  readonly utilityModel: CatalogModel;
  readonly utilityFile: CatalogFile;
  /** 1–3 clearly-labelled picks for non-power-users (speed / vision / helper). */
  readonly simpleSet: readonly SimplePick[];
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

/** Speed-optimized primary pick per tier. */
function primaryFor(tier: BudgetTier): Pick {
  switch (tier) {
    case '<8GB':
      return { modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M', launchMode: 'fast-text' };
    case '8GB':
      return { modelId: 'qwen3.5-4b-mtp', quant: 'Q4_K_M', launchMode: 'fast-text' };
    case '16GB':
      return { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M', launchMode: 'fast-text' };
    case '24GB':
      return { modelId: 'qwen3.6-27b-mtp', quant: 'Q4_K_M', launchMode: 'fast-text' };
    case '32GB':
      return { modelId: 'qwen3.6-35b-a3b-mtp', quant: 'UD-Q4_K_M', launchMode: 'fast-text' };
    default:
      // 48/64/96/128 — the fastest strong local pick (MoE, 3B active + MTP).
      return { modelId: 'qwen3.6-35b-a3b-mtp', quant: 'UD-Q6_K', launchMode: 'fast-text' };
  }
}

/** Best vision-capable pick that fits the tier (undefined for the tiniest). */
function visionFor(tier: BudgetTier): Pick | undefined {
  switch (tier) {
    case '<8GB':
    case '8GB':
      return undefined; // vision picks want >=16GB comfortably
    case '16GB':
    case '24GB':
      return { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M', launchMode: 'multimodal' };
    case '32GB':
      return { modelId: 'gemma-4-31b-it', quant: 'Q4_K_M', launchMode: 'multimodal' };
    default:
      return { modelId: 'gemma-4-31b-it', quant: 'Q6_K', launchMode: 'multimodal' };
  }
}

function toSimplePick(role: SimplePick['role'], pick: Pick): SimplePick {
  const { model, file } = resolve(pick);
  return {
    role,
    model,
    file,
    launchMode: pick.launchMode,
    // Vision launch ignores the speed head; a fast-text launch uses it.
    spec: pick.launchMode === 'fast-text' ? model.spec : undefined,
    vision: model.input.includes('image'),
  };
}

/** Build the 1–3 pick simple set, de-duplicated by model id, capped at 3. */
function buildSimpleSet(tier: BudgetTier, primary: Pick): SimplePick[] {
  const picks: Array<{ role: SimplePick['role']; pick: Pick }> = [{ role: 'speed', pick: primary }];
  const vision = visionFor(tier);
  if (vision !== undefined) picks.push({ role: 'vision', pick: vision });
  picks.push({ role: 'utility', pick: UTILITY });

  const out: SimplePick[] = [];
  const seen = new Set<string>();
  for (const { role, pick } of picks) {
    if (seen.has(pick.modelId)) continue;
    seen.add(pick.modelId);
    out.push(toSimplePick(role, pick));
    if (out.length >= 3) break;
  }
  return out;
}

function tierFor(ram: number): BudgetTier {
  if (ram >= 128) return '128GB';
  if (ram >= 96) return '96GB';
  if (ram >= 64) return '64GB';
  if (ram >= 48) return '48GB';
  if (ram >= 32) return '32GB';
  if (ram >= 24) return '24GB';
  if (ram >= 16) return '16GB';
  if (ram >= 8) return '8GB';
  return '<8GB';
}

/** Recommend a (speed-optimized) model configuration for the given RAM budget. */
export function recommend(hw: { totalRamGB: number }): Recommendation {
  const ram = hw.totalRamGB;
  const tier = tierFor(ram);
  const primary = primaryFor(tier);

  const { model, file } = resolve(primary);
  const utility = resolve(UTILITY);
  const simpleSet = buildSimpleSet(tier, primary);

  const specNote =
    model.spec === 'mtp'
      ? ' with MTP speculative decoding'
      : model.spec === 'eagle3'
        ? ' with EAGLE-3 speculative decoding'
        : '';
  const rationale =
    tier === '<8GB'
      ? `${ram}GB RAM is below the 8GB floor for a large model; running the ` +
        `${model.displayName} (${file.quant})${specNote} as the fast primary.`
      : `${ram}GB RAM → ${tier} tier → ${model.displayName} ${file.quant} in ` +
        `${primary.launchMode} mode${specNote} (needs ~${model.minRamGB}GB), plus the ` +
        `${utility.model.displayName} utility slot.`;

  return {
    tier,
    model,
    file,
    launchMode: primary.launchMode,
    utilityModel: utility.model,
    utilityFile: utility.file,
    simpleSet,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Per-hardware 3-tier resolution (round-12 model-selection UX).
//
// resolveTierModels(hw) → { fast, balanced, intelligent }, each a concrete
// catalog model + quant for THIS Mac's RAM. The three are always present; on a
// tiny machine two tiers may resolve to the SAME model id (dedup at switch
// time by comparing model ids, not tier names). The app resolves the harness's
// published `activeTier` through this map and drives the llama-server switch.
// ---------------------------------------------------------------------------

/** One resolved tier pick: the model + quant to launch for a tier on this Mac. */
export interface TierPick {
  readonly tier: ModelTier;
  readonly model: CatalogModel;
  readonly file: CatalogFile;
  /** 'fast-text' default; the app flips to 'multimodal' on-demand for vision. */
  readonly launchMode: LaunchMode;
  /** Speed method for a fast-text launch (mtp | eagle3 | dflash), if any. */
  readonly spec?: SpecMethod;
  /** True when the model can take image input (in a multimodal launch). */
  readonly vision: boolean;
  /** Grey display name for the dropdown, e.g. "gemma4 e2b". */
  readonly displayName: string;
  /** Download size of {@link file} in bytes (0 = unverified), for the "N GB" copy. */
  readonly bytes: number;
}

/**
 * Friendly grey name: `displayName` lowercased/condensed
 * ("Gemma 4 E2B Instruct" → "gemma4 e2b", "Qwen3.6 27B (MTP)" → "qwen3.6 27b").
 */
export function tierDisplayName(model: CatalogModel): string {
  return model.displayName
    .toLowerCase()
    .replace(/\binstruct\b/g, '')
    .replace(/\s*\([^)]*\)/g, '') // drop "(MTP)" / "(EAGLE-3)"
    .replace(/\bnvidia\b/g, '') // drop the vendor prefix on Nemotron
    .replace(/gemma\s+4/g, 'gemma4')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Per-tier {modelId, quant} for a RAM budget (the round-12 resolution table). */
function tierTable(tier: BudgetTier): Record<ModelTier, { modelId: string; quant: string }> {
  switch (tier) {
    case '<8GB':
      return {
        fast: { modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M' },
        balanced: { modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M' },
        intelligent: { modelId: 'gemma-4-e4b-it', quant: 'Q4_K_M' },
      };
    case '8GB':
      return {
        fast: { modelId: 'qwen3.5-4b-mtp', quant: 'Q4_K_M' },
        balanced: { modelId: 'gemma-4-e4b-it', quant: 'Q4_K_M' },
        intelligent: { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M' },
      };
    case '16GB':
      return {
        fast: { modelId: 'qwen3.5-4b-mtp', quant: 'Q4_K_M' },
        balanced: { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M' },
        intelligent: { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M' },
      };
    case '24GB':
      return {
        fast: { modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M' },
        balanced: { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M' },
        intelligent: { modelId: 'qwen3.6-27b-mtp', quant: 'Q4_K_M' },
      };
    case '32GB':
      return {
        fast: { modelId: 'qwen3.5-4b-mtp', quant: 'Q4_K_M' },
        balanced: { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M' },
        intelligent: { modelId: 'qwen3.6-35b-a3b-mtp', quant: 'UD-Q4_K_M' },
      };
    default:
      // 48 / 64 / 96 / 128GB
      return {
        fast: { modelId: 'qwen3.5-9b-mtp', quant: 'Q4_K_M' },
        balanced: { modelId: 'gemma-4-26b-a4b-it', quant: 'UD-Q4_K_M' },
        intelligent: { modelId: 'qwen3.6-35b-a3b-mtp', quant: 'UD-Q4_K_M' },
      };
  }
}

function toTierPick(tier: ModelTier, spec: { modelId: string; quant: string }): TierPick {
  const { model, file } = resolve({ ...spec, launchMode: 'fast-text' });
  return {
    tier,
    model,
    file,
    launchMode: 'fast-text',
    // A fast-text launch uses the model's speed head; vision (multimodal) drops it.
    spec: model.spec,
    vision: model.input.includes('image'),
    displayName: tierDisplayName(model),
    bytes: file.bytes,
  };
}

/**
 * The 3 tiers resolved for THIS machine's RAM. All three always present; a tiny
 * machine may resolve two tiers to the SAME model id (dedup at switch time).
 * Deterministic + pure.
 */
export function resolveTierModels(hw: { totalRamGB: number }): Record<ModelTier, TierPick> {
  const table = tierTable(tierFor(hw.totalRamGB));
  return {
    fast: toTierPick('fast', table.fast),
    balanced: toTierPick('balanced', table.balanced),
    intelligent: toTierPick('intelligent', table.intelligent),
  };
}
