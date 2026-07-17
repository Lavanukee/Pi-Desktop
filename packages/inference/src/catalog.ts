/**
 * Typed GGUF model catalog.
 *
 * HF-VERIFIED 2026-07-08/-10: the "verified: true" entries below were verified
 * live against Hugging Face (repo + file + `x-linked-size` bytes +
 * `x-linked-etag` LFS sha256, or the tree `lfs.oid`/`lfs.size`). Downloads
 * enforce sha256 when present and size only when > 0, so an entry may carry
 * `bytes: 0` + no sha to mean "known repo/quant, integrity not yet HEAD-verified"
 * (marked `verified: false`) without ever failing a real download's size assert.
 *
 * ROUND-12 expansion (data from round12-models.md, HF-verified 2026-07-10):
 *   - Vision was UNDERSTATED: gemma-4-E2B and EVERY Qwen `-MTP` repo actually
 *     ship an `mmproj` sibling (`image-text-to-text`). Their `input` now includes
 *     `'image'` — the fast-text launch is still text-only, but the on-demand
 *     multimodal restart flow can target them. (mmproj ⊥ MTP per launch.)
 *   - DFlash is REAL upstream now: `--spec-type draft-dflash` merged to llama.cpp
 *     master (PR #22105, 2026-06-28, release b9831+) — no fork. It is exposed as a
 *     third {@link SpecMethod} (`'dflash'`) and, per model, as a {@link SpecVariant}
 *     paired to a late-June (or newer) community draft repo. It does NOT exist for
 *     the <4B tier (smallest DFlash target is Qwen3.5-4B).
 *   - New reserved entries: Qwen3.5-0.8B/2B (genuine <4B fast picks, MTP), the
 *     sharded Qwen3.5-122B-A10B, and NVIDIA Nemotron-3-Nano-30B-A3B (NVIDIA Open
 *     Model License, NOT Apache). These carry accurate repo + quant labels but
 *     `bytes: 0` (size/sha not hand-verified here) → `verified: false`.
 *   - Every entry now carries an `engine` (llamacpp default; MLX foundation is a
 *     later wave), a `publisher` (HF handle + reliable-allowlist flag), a coarse
 *     `tier` hint, and the available speed `variants`.
 *
 * SUB-12B QUANT POLICY (round-17): every llama.cpp entry UNDER 12B params curates
 * a two-rung ladder — `Q8_0` (the default) + a dynamic `UD-Q6_K_XL` (the hard
 * floor) — and NO `Q4_K_M`. A small model at Q4 adds too much quality uncertainty
 * (a 4B loses more, proportionally, than a 27B), so Q8 is the default and the
 * Unsloth-Dynamic Q6 is the lowest we drop to when RAM is snug. Models >=12B keep
 * their existing Q4/Q6/UD ladder. The recommender (`sub12bQuant`) does the RAM-
 * tier pick. Q8_0 4B ≈ 4.3GB vs the old Q4_K_M ≈ 2.6GB; UD-Q6_K_XL 4B ≈ 4.0GB.
 * File bytes below are HF-verified live 2026-07-16 (`tree/main` `lfs.oid`/`size`).
 */

/** Inference engine backing a catalog entry. MLX is Apple-Silicon-only and is
 * reserved for a later wave; every current entry is `'llamacpp'` (GGUF). */
export type Engine = 'llamacpp' | 'mlx';

/** Per-launch server mode. MTP (fast-text) is mutually exclusive with mmproj. */
export type LaunchMode = 'fast-text' | 'multimodal';

/**
 * Coarse model-capability tier hint. Mirrors `ModelTier` in `@pi-desktop/harness`
 * (kept local so this low-level package does not depend on the harness). The
 * recommender's {@link resolveTierModels} is the authority for per-RAM resolution;
 * this per-model hint is a display/grouping aid for the model manager.
 */
export type ModelTier = 'fast' | 'balanced' | 'intelligent';

export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'balanced', 'intelligent'];

export interface CatalogFile {
  /** GGUF file name within the HF repo (`resolve/main/<name>`). */
  readonly name: string;
  /** File size in bytes; 0 = unknown/unverified (no size assertion on download). */
  readonly bytes: number;
  /** Quantization label, e.g. "Q4_K_M", "Q6_K", "UD-Q4_K_M". */
  readonly quant: string;
  /** Lowercase hex sha256, when verified. */
  readonly sha256?: string;
}

/**
 * Speculative-decoding speed method a catalog entry ships (see catalog note).
 * All three run on stock upstream llama.cpp (`draft-mtp` / `draft-eagle3` /
 * `draft-dflash`); DFlash landed upstream 2026-06-28 (b9831+), no fork.
 */
export type SpecMethod = 'mtp' | 'eagle3' | 'dflash';

/** One speed variant a model can launch with (surfaced in the manager's
 * [MTP / EAGLE3 / DFlash] variant dropdown). */
export interface SpecVariant {
  readonly method: SpecMethod;
  /** True when the head is embedded in the main GGUF (no separate draft file). */
  readonly embedded?: boolean;
  /** HF repo the draft GGUF lives in (EAGLE3/DFlash), when separate from `hfRepo`. */
  readonly draftRepo?: string;
  /** The draft GGUF, when its sha/size are HEAD-verified; undefined for reserved. */
  readonly draftModel?: CatalogFile;
}

/** The HF publisher hosting the GGUF + whether it is in the round-12 reliable
 * allowlist (Unsloth / Bartowski / ggml-org / NVIDIA / Qwen / Google / DeepMind /
 * mlx-community / lmstudio-community). Community re-quanters (mradermacher, etc.)
 * are NOT reliable. */
export interface ModelPublisher {
  readonly handle: string;
  readonly reliable: boolean;
}

/** Reliable-publisher allowlist (exact HF handles, verified 2026-07-10). */
export const RELIABLE_PUBLISHERS: readonly string[] = [
  'unsloth',
  'bartowski',
  'ggml-org',
  'nvidia',
  'Qwen',
  'google',
  'deepmind',
  'mlx-community',
  'lmstudio-community',
];

export function isReliablePublisher(handle: string): boolean {
  return RELIABLE_PUBLISHERS.includes(handle);
}

/** Convenience: an `unsloth`-hosted (reliable) publisher. */
const UNSLOTH: ModelPublisher = { handle: 'unsloth', reliable: true };

/** Convenience: an `mlx-community`-hosted (reliable) publisher — the MLX org. */
const MLX_COMMUNITY: ModelPublisher = { handle: 'mlx-community', reliable: true };

export interface CatalogModel {
  readonly id: string;
  readonly displayName: string;
  /** HuggingFace repo, e.g. "unsloth/gemma-4-E2B-it-GGUF". */
  readonly hfRepo: string;
  /**
   * Canonical BASE (non-GGUF) repo that carries the authoritative
   * `chat_template.jinja`, e.g. "google/gemma-4-E2B-it". When set, the launcher
   * fetches + caches that template and passes `--jinja --chat-template-file`
   * (see `chat-template.ts`) so llama.cpp routes to the model's real chat/tool
   * parser instead of the GGUF's embedded (often stale) template. Usually gated
   * — the fetch uses the plumbed HF token. General-purpose: any model may set it.
   */
  readonly baseRepo?: string;
  /** Main GGUF file(s). Multiple entries = user picks a quant. */
  readonly files: readonly CatalogFile[];
  /** Vision projector sibling (multimodal launch). */
  readonly mmproj?: CatalogFile;
  /** Separate MTP head sibling (Gemma4 style). Undefined when embedded. */
  readonly mtpFile?: CatalogFile;
  /** True when the MTP head is embedded in the main GGUF (Qwen3.6 style). */
  readonly mtpEmbedded?: boolean;
  /**
   * The DEFAULT speed method used by the current launch path for a fast-text
   * launch (`--spec-type draft-<spec>`). See {@link variants} for the full set of
   * speed options a model supports (what the manager's variant dropdown offers).
   */
  readonly spec?: SpecMethod;
  /** HF repo the (EAGLE-3) draft lives in, when different from {@link hfRepo}. */
  readonly draftRepo?: string;
  /** EAGLE-3/DFlash draft GGUF (paired via `--model-draft`); undefined for MTP. */
  readonly draftModel?: CatalogFile;
  /** All speed variants this model can launch with (MTP / EAGLE3 / DFlash). */
  readonly variants?: readonly SpecVariant[];
  readonly license: string;
  /** Minimum system RAM (GB) to run this comfortably. */
  readonly minRamGB: number;
  readonly contextWindow: number;
  readonly input: readonly ('text' | 'image')[];
  /** True when the HF repo is gated (needs an accepted licence / token). */
  readonly gated?: boolean;
  /** True only for HEAD-verified repo/file/sha/size. */
  readonly verified: boolean;
  /** Inference engine (default 'llamacpp' when omitted). */
  readonly engine?: Engine;
  /** HF publisher + reliable-allowlist flag. */
  readonly publisher?: ModelPublisher;
  /** Coarse tier hint for grouping/sorting in the model manager. */
  readonly tier?: ModelTier;
  /** True when the quants are split into multiple shards (needs shard-join on
   * download/launch — a follow-up; reserved entries only for now). */
  readonly sharded?: boolean;
  /** Human-readable available-quant range (e.g. "Q3–Q8 + UD + IQ"). */
  readonly quantRange?: string;
}

// ---------------------------------------------------------------------------
// Gemma4 family — publisher `unsloth` (base `google`). All vision-capable.
// ---------------------------------------------------------------------------

/** Verified utility/fast model — small, fast, fits every tier. Now vision-capable
 * (mmproj sibling) so the on-demand multimodal flow can target it. */
export const GEMMA4_E2B: CatalogModel = {
  id: 'gemma-4-e2b-it',
  displayName: 'Gemma 4 E2B Instruct',
  hfRepo: 'unsloth/gemma-4-E2B-it-GGUF',
  baseRepo: 'google/gemma-4-E2B-it',
  // SUB-12B QUANT POLICY: a model under 12B params never ships a Q4 default — a
  // small model at Q4 adds too much quality uncertainty. Q8_0 is the default; the
  // dynamic Q6 floor (Unsloth `UD-Q6_K_XL`) is the hard floor the recommender
  // drops to only when RAM is snug (see `sub12bQuant` in recommender.ts).
  files: [
    {
      name: 'gemma-4-E2B-it-Q8_0.gguf',
      bytes: 5_048_350_848,
      quant: 'Q8_0',
      sha256: '0a8488b149e1f700712c35d5bf0a3795f9dcc2563b4944d5ef2fb89375f9483e',
    },
    {
      name: 'gemma-4-E2B-it-UD-Q6_K_XL.gguf',
      bytes: 4_710_086_784,
      quant: 'UD-Q6_K_XL',
      sha256: '23b9129abcd9db1df6e35aafeb3e43c65448dac7f114aa02b30fdf29b9db303d',
    },
  ],
  // E2B DOES ship vision (mmproj-F16, 985,654,080 B ≈ 0.918 GiB); sha not
  // HEAD-verified here (doc gives a 16-hex prefix only) so it is omitted.
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 985_654_080,
    quant: 'F16',
  },
  // Gemma4 MTP head ships as a separate Q8_0 sibling in the same repo.
  mtpFile: {
    name: 'mtp-gemma-4-E2B-it.gguf',
    bytes: 97_817_664,
    quant: 'Q8_0',
    sha256: '9eba819938efccfd6044f8af84e3bbfddc639a2bcf32ebc36420e6a649191919',
  },
  spec: 'mtp',
  variants: [{ method: 'mtp' }],
  license: 'Gemma',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

const GEMMA4_E4B: CatalogModel = {
  id: 'gemma-4-e4b-it',
  displayName: 'Gemma 4 E4B Instruct',
  hfRepo: 'unsloth/gemma-4-E4B-it-GGUF',
  baseRepo: 'google/gemma-4-E4B-it',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 default, UD-Q6_K_XL dynamic floor.
  files: [
    {
      name: 'gemma-4-E4B-it-Q8_0.gguf',
      bytes: 8_192_951_456,
      quant: 'Q8_0',
      sha256: 'a2232a649523c36bf530f1dc3614eb8c800645c4227390381c8b05d4d6eee05a',
    },
    {
      name: 'gemma-4-E4B-it-UD-Q6_K_XL.gguf',
      bytes: 7_457_760_416,
      quant: 'UD-Q6_K_XL',
      sha256: '718b86f1d3e2928df914e7abf83a5342ef752fb7a7e900d5ff036952709ea72f',
    },
  ],
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 990_372_672,
    quant: 'F16',
    sha256: 'ddf46c21d7078e95338cfc22306b19b276a29a5ad089023449dd54d4b6170a51',
  },
  mtpFile: {
    name: 'mtp-gemma-4-E4B-it.gguf',
    bytes: 98_653_248,
    quant: 'Q8_0',
    sha256: 'b6a723115efa510d3b3215db1e26790dae84cd08c2134a764f3d194f1f0c3376',
  },
  spec: 'mtp',
  variants: [{ method: 'mtp' }],
  license: 'Gemma',
  minRamGB: 8,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

const GEMMA4_12B: CatalogModel = {
  id: 'gemma-4-12b-it',
  displayName: 'Gemma 4 12B Instruct',
  hfRepo: 'unsloth/gemma-4-12b-it-GGUF',
  baseRepo: 'google/gemma-4-12b-it',
  files: [
    {
      name: 'gemma-4-12b-it-Q4_K_M.gguf',
      bytes: 7_121_860_000,
      quant: 'Q4_K_M',
      sha256: '43fec98c5102b1c446b4ddd0a9439f1db3a2e1f2e0b8cd143ce1ea619a9403d6',
    },
    {
      name: 'gemma-4-12b-it-Q6_K.gguf',
      bytes: 9_786_021_280,
      quant: 'Q6_K',
      sha256: 'e1602ddc224c159584eb4c7d6a6c8d682fc6afb2efb8f76c10bfd63ba71436a2',
    },
  ],
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 175_115_840,
    quant: 'F16',
    sha256: '91f086971e56d7a7d8d39e271873fccdb49541bd259d6e02c401a4f1cb7a219e',
  },
  mtpFile: {
    name: 'mtp-gemma-4-12b-it.gguf',
    bytes: 465_109_248,
    quant: 'Q8_0',
    sha256: '145db9094bc0f85f1701e255a2ed216dcc9800fc8bc8631ad00905b456bd451b',
  },
  spec: 'mtp',
  // MTP sibling + a late-June DFlash draft (upstream draft-dflash).
  variants: [
    { method: 'mtp' },
    { method: 'dflash', draftRepo: 'williamliao/gemma-4-12B-it-DFlash-GGUF' },
  ],
  license: 'Gemma',
  minRamGB: 16,
  contextWindow: 128_000,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'balanced',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/** Gemma4 26B-A4B MoE (fast active params + MTP): a strong 32–48GB vision pick. */
const GEMMA4_26B_A4B: CatalogModel = {
  id: 'gemma-4-26b-a4b-it',
  displayName: 'Gemma 4 26B-A4B Instruct',
  hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
  baseRepo: 'google/gemma-4-26B-A4B-it',
  // Repo ships only UD-quants at the Q4/Q6 tiers (no plain Q4_K_M/Q6_K).
  files: [
    {
      name: 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
      bytes: 16_947_539_744,
      quant: 'UD-Q4_K_M',
      sha256: '34c746b1d50ab813e29cd46c4796e3f43c741901a582f93a67b55b9fc9687b35',
    },
    {
      name: 'gemma-4-26B-A4B-it-UD-Q6_K.gguf',
      bytes: 23_172_476_704,
      quant: 'UD-Q6_K',
      sha256: 'd3d9e6a63845bdc83e9f9fc5923e77c023ccc1197c9e145e6a8754bad80b5d75',
    },
  ],
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 1_193_058_784,
    quant: 'F16',
    sha256: '418a6d8723067cd712235facbbc5cba6c8fbbd413fc1292d2aace5a027d5a42f',
  },
  mtpFile: {
    name: 'mtp-gemma-4-26B-A4B-it.gguf',
    bytes: 461_766_816,
    quant: 'Q8_0',
    sha256: '6326fb9f5e487aa8dcdd313a091e3c67724cb2a666ec3b7d2895b5b26d93ed1b',
  },
  spec: 'mtp',
  // MTP sibling + the OFFICIAL RedHatAI EAGLE3 speculator (docs-cited) + a DFlash
  // draft. DFlash on a quantized MoE target can regress on weak GPUs (#25117) —
  // MTP stays the safe default.
  variants: [
    { method: 'mtp' },
    { method: 'eagle3', draftRepo: 'RedHatAI/gemma-4-26B-A4B-it-speculator.eagle3' },
    { method: 'dflash', draftRepo: 'Anbeeld/gemma-4-26B-A4B-it-DFlash-GGUF' },
  ],
  license: 'Gemma',
  minRamGB: 24,
  contextWindow: 128_000,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'balanced',
  quantRange: 'UD-Q4_K_M / UD-Q6_K / MXFP4_MOE / Q8_0',
};

/** Gemma4 31B dense (+ MTP): the high-tier vision-capable pick. */
const GEMMA4_31B: CatalogModel = {
  id: 'gemma-4-31b-it',
  displayName: 'Gemma 4 31B Instruct',
  hfRepo: 'unsloth/gemma-4-31B-it-GGUF',
  baseRepo: 'google/gemma-4-31B-it',
  files: [
    {
      name: 'gemma-4-31B-it-Q4_K_M.gguf',
      bytes: 18_323_731_456,
      quant: 'Q4_K_M',
      sha256: '9fdf3dc8b0384830b4402d151388c140bd8eb2abf8d60588d8224231198254a1',
    },
    {
      name: 'gemma-4-31B-it-Q6_K.gguf',
      bytes: 25_201_484_800,
      quant: 'Q6_K',
      sha256: 'abd0be03a2bc3f3c9d8e018cbb4ff5b553c340c65d49b6b346c48be5a1efde28',
    },
  ],
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 1_198_957_024,
    quant: 'F16',
    sha256: '6edcca228213c28d3567a35d22f849eea52d8360875093851959adf5d2f270eb',
  },
  mtpFile: {
    name: 'mtp-gemma-4-31B-it.gguf',
    bytes: 514_687_104,
    quant: 'Q8_0',
    sha256: '5ae8b0117bed601e8924c6305bd5b0585de361d51f0e77091bcb4252cf1f27de',
  },
  spec: 'mtp',
  variants: [
    { method: 'mtp' },
    { method: 'eagle3', draftRepo: 'RedHatAI/gemma-4-31B-it-speculator.eagle3' },
    { method: 'dflash', draftRepo: 'williamliao/gemma-4-31B-it-DFlash-GGUF' },
  ],
  license: 'Gemma',
  minRamGB: 24,
  contextWindow: 128_000,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  quantRange: 'Q3–Q8 + UD + IQ',
};

// ---------------------------------------------------------------------------
// Qwen3.5 family — publisher `unsloth`, Apache-2.0. -MTP repos embed the head
// and are all vision-capable (mmproj sibling).
// ---------------------------------------------------------------------------

/** Qwen3.5 0.8B (embedded MTP): ultra-light <4B floor for the weakest machines. */
const QWEN35_0_8B_MTP: CatalogModel = {
  id: 'qwen3.5-0.8b-mtp',
  displayName: 'Qwen3.5 0.8B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-0.8B-MTP-GGUF',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 default, UD-Q6_K_XL dynamic floor.
  // Reserved entry — bytes:0 / verified:false (repo ships both; not HEAD-verified).
  files: [
    { name: 'Qwen3.5-0.8B-Q8_0.gguf', bytes: 0, quant: 'Q8_0' },
    { name: 'Qwen3.5-0.8B-UD-Q6_K_XL.gguf', bytes: 0, quant: 'UD-Q6_K_XL' },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  // No EAGLE3/DFlash drafts exist for <4B models — MTP only.
  variants: [{ method: 'mtp', embedded: true }],
  license: 'Apache-2.0',
  minRamGB: 4,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: false,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/** Qwen3.5 2B (embedded MTP): a genuine <4B fast pick. */
const QWEN35_2B_MTP: CatalogModel = {
  id: 'qwen3.5-2b-mtp',
  displayName: 'Qwen3.5 2B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-2B-MTP-GGUF',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 default, UD-Q6_K_XL dynamic floor.
  // Reserved entry — bytes:0 / verified:false (repo ships both; not HEAD-verified).
  files: [
    { name: 'Qwen3.5-2B-Q8_0.gguf', bytes: 0, quant: 'Q8_0' },
    { name: 'Qwen3.5-2B-UD-Q6_K_XL.gguf', bytes: 0, quant: 'UD-Q6_K_XL' },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  variants: [{ method: 'mtp', embedded: true }],
  license: 'Apache-2.0',
  minRamGB: 4,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: false,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/**
 * Qwen3.5 4B (embedded MTP): the DEFAULT small / worker model — the fast-tier
 * speed pick AND the harness utility/classifier model (title generation, the
 * rung-2 tool-call fixer, classifier escalation). Its Qwen3.5 hybrid attention
 * (~75% Gated DeltaNet linear layers + ~25% full GQA) gives ~4× smaller KV
 * cache and ~4× faster prefill than a dense model of similar size — a big win
 * for `-np` parallel utility workers and prompt prefill. `baseRepo` points at
 * Qwen's canonical (non-gated) `chat_template.jinja` so the launcher routes to
 * the real Qwen tool-call parser via `--jinja --chat-template-file` (see
 * chat-template.ts), the same reason the Gemma-4 family declares one.
 */
const QWEN35_4B_MTP: CatalogModel = {
  id: 'qwen3.5-4b-mtp',
  displayName: 'Qwen3.5 4B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-4B-MTP-GGUF',
  baseRepo: 'Qwen/Qwen3.5-4B',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 (~4.3GB) is the DEFAULT worker
  // quant — no Q4 for the 4B (too much quality uncertainty for the utility/
  // classifier roles). UD-Q6_K_XL (~4.0GB) is the dynamic floor when RAM is snug.
  files: [
    {
      name: 'Qwen3.5-4B-Q8_0.gguf',
      bytes: 4_610_580_800,
      quant: 'Q8_0',
      sha256: '4f40ff26e3b6e23888e520e9c33d9a309d919b940cd1375b421710c6cb6cc8dd',
    },
    {
      name: 'Qwen3.5-4B-UD-Q6_K_XL.gguf',
      bytes: 4_261_908_800,
      quant: 'UD-Q6_K_XL',
      sha256: '28bedf3269ebb40444dab71cf884d85ad639fd57cfc30757a62b7929d4e316de',
    },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  // Smallest DFlash target in-family is 4B (late-June draft).
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'dflash', draftRepo: 'Anbeeld/Qwen3.5-4B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/** Qwen3.5 9B (embedded MTP): the 16GB-tier speed pick. */
const QWEN35_9B_MTP: CatalogModel = {
  id: 'qwen3.5-9b-mtp',
  displayName: 'Qwen3.5 9B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-9B-MTP-GGUF',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 default, UD-Q6_K_XL dynamic floor.
  files: [
    {
      name: 'Qwen3.5-9B-Q8_0.gguf',
      bytes: 9_786_061_152,
      quant: 'Q8_0',
      sha256: '107125cda29dc42d62f5ba8ffac8817d21a9d7bd06c1b35860491a00a170ad4e',
    },
    {
      name: 'Qwen3.5-9B-UD-Q6_K_XL.gguf',
      bytes: 8_987_439_456,
      quant: 'UD-Q6_K_XL',
      sha256: 'a6d6c0ace780ea91d59a3ef5050a96b6ebbf416d94e6b23c191d1f492a6276f0',
    },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'dflash', draftRepo: 'Anbeeld/Qwen3.5-9B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 12,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'balanced',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/** Qwen3.5 122B-A10B MoE (embedded MTP): the top-tier local pick. Heavily
 * SHARDED — every quant ≥ UD-IQ3_S splits into 3–5 files (shard-join is a
 * follow-up), so this is a reserved entry (bytes 0, verified false) for now. */
const QWEN35_122B_A10B_MTP: CatalogModel = {
  id: 'qwen3.5-122b-a10b-mtp',
  displayName: 'Qwen3.5 122B-A10B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-122B-A10B-MTP-GGUF',
  files: [
    { name: 'Qwen3.5-122B-A10B-UD-Q4_K_M-00001-of-00003.gguf', bytes: 0, quant: 'UD-Q4_K_M' },
    { name: 'Qwen3.5-122B-A10B-UD-Q6_K-00001-of-00004.gguf', bytes: 0, quant: 'UD-Q6_K' },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  variants: [{ method: 'mtp', embedded: true }],
  license: 'Apache-2.0',
  minRamGB: 80,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: false,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  sharded: true,
  quantRange: 'UD ladder + MXFP4_MOE + Q8_0 (multi-shard ≥ UD-IQ3_S)',
};

// ---------------------------------------------------------------------------
// Qwen3.6 family — publisher `unsloth`, Apache-2.0, vision via mmproj.
// ---------------------------------------------------------------------------

const QWEN36_27B_MTP: CatalogModel = {
  id: 'qwen3.6-27b-mtp',
  displayName: 'Qwen3.6 27B (MTP)',
  hfRepo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
  files: [
    {
      name: 'Qwen3.6-27B-Q4_K_M.gguf',
      bytes: 17_106_773_120,
      quant: 'Q4_K_M',
      sha256: 'a7cbd3ecc0e3f9b333edee61ae66bc87ed713c5d49587a8355814722ed329e0f',
    },
    {
      name: 'Qwen3.6-27B-Q6_K.gguf',
      bytes: 22_884_406_400,
      quant: 'Q6_K',
      sha256: '773f1bf0be0589d056ce05476a8a135b50494a3f2ecc3f8f0c4f2c3594bba02e',
    },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  // The best-tested DFlash target (PR benchmarks it); EAGLE3 is community-only.
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'eagle3', draftRepo: 'gelim/Qwen3.6-27B-PRISM-EAGLE3-GGUF' },
    { method: 'dflash', draftRepo: 'williamliao/qwen3.6-27B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  quantRange: 'Q3–Q8 + UD + IQ',
};

const QWEN36_35B_A3B_MTP: CatalogModel = {
  id: 'qwen3.6-35b-a3b-mtp',
  displayName: 'Qwen3.6 35B-A3B (MTP)',
  hfRepo: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
  // Repo ships only UD-quants; plain Q4_K_M/Q6_K do not exist. UD-Q4_K_M is the
  // Q4-class pick, UD-Q6_K the Q6-class pick.
  files: [
    {
      name: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
      bytes: 22_663_387_424,
      quant: 'UD-Q4_K_M',
      sha256: '0b21525e972670ed59e1812e170b27c26355381f0656ecc4e25617ece7dac58b',
    },
    {
      name: 'Qwen3.6-35B-A3B-UD-Q6_K.gguf',
      bytes: 30_011_242_784,
      quant: 'UD-Q6_K',
      sha256: '49935b04ad883c2f3d4da61f65b609d447dad67d0b08453b90abb09a1bb35464',
    },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  // DFlash on a quantized MoE target can regress on weak GPUs (#25117) — MTP safe.
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'dflash', draftRepo: 'Anbeeld/Qwen3.6-35B-A3B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 28,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  quantRange: 'UD-Q4_K_M / UD-Q6_K / MXFP4_MOE / Q8_0',
};

/**
 * Qwen3.6 27B plain base with EAGLE-3 (and DFlash) draft-model speculative
 * decoding. The plain base (`unsloth/Qwen3.6-27B-GGUF`) is paired with a
 * community EAGLE-3 draft from a SEPARATE repo, launched as
 * `--spec-type draft-eagle3 --model-draft <draft>`. Encoded to exercise the
 * cross-repo draft-model wiring; MTP (the embedded `qwen3.6-27b-mtp` above) is
 * the simpler default for most users.
 */
const QWEN36_27B_EAGLE3: CatalogModel = {
  id: 'qwen3.6-27b-eagle3',
  displayName: 'Qwen3.6 27B (EAGLE-3)',
  hfRepo: 'unsloth/Qwen3.6-27B-GGUF',
  files: [
    {
      name: 'Qwen3.6-27B-Q4_K_M.gguf',
      bytes: 16_817_244_384,
      quant: 'Q4_K_M',
      sha256: '5ed60d0af4650a854b1755bd392f9aef4872643dc25a254bc68043fa638392a0',
    },
    {
      name: 'Qwen3.6-27B-Q6_K.gguf',
      bytes: 22_523_238_624,
      quant: 'Q6_K',
      sha256: 'ec1805fe87e6519c461c1ed2d179865464a875ed241032ead65a354f979cfe14',
    },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  spec: 'eagle3',
  draftRepo: 'gelim/Qwen3.6-27B-PRISM-EAGLE3-GGUF',
  draftModel: {
    name: 'Qwen3.6-27B-PRISM-EAGLE3_Q4_K_M.gguf',
    bytes: 1_290_881_632,
    quant: 'Q4_K_M',
    sha256: '296550cca35276756a7f8c45787f0a21d53f769ea13cea4ff25e5346d75a512c',
  },
  variants: [
    {
      method: 'eagle3',
      draftRepo: 'gelim/Qwen3.6-27B-PRISM-EAGLE3-GGUF',
      draftModel: {
        name: 'Qwen3.6-27B-PRISM-EAGLE3_Q4_K_M.gguf',
        bytes: 1_290_881_632,
        quant: 'Q4_K_M',
        sha256: '296550cca35276756a7f8c45787f0a21d53f769ea13cea4ff25e5346d75a512c',
      },
    },
    { method: 'dflash', draftRepo: 'williamliao/qwen3.6-27B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  quantRange: 'Q3–Q8 + UD + IQ',
};

// ---------------------------------------------------------------------------
// NVIDIA Nemotron — current gen Nemotron-3. NVIDIA Open Model License (NOT
// Apache). Reserved entry (bytes 0, verified false) — the full quant ladder is
// on `unsloth/`, hosted (reliable) even though NVIDIA authored the weights.
// ---------------------------------------------------------------------------

/** Nemotron-3-Nano-30B-A3B MoE (A3B active → fast for its size). Text-only. */
const NEMOTRON3_NANO_30B_A3B: CatalogModel = {
  id: 'nemotron-3-nano-30b-a3b',
  displayName: 'NVIDIA Nemotron-3 Nano 30B-A3B',
  hfRepo: 'unsloth/Nemotron-3-Nano-30B-A3B-GGUF',
  files: [
    { name: 'Nemotron-3-Nano-30B-A3B-Q4_K_M.gguf', bytes: 0, quant: 'Q4_K_M' },
    { name: 'Nemotron-3-Nano-30B-A3B-Q4_K_S.gguf', bytes: 0, quant: 'Q4_K_S' },
  ],
  // Text-only; no speculative-decoding variant ships for this model.
  license: 'NVIDIA Open Model License',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text'],
  verified: false,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'balanced',
  quantRange: 'Q4_K_M / Q4_K_S / IQ4_XS + more',
};

// ---------------------------------------------------------------------------
// MLX (Apple-Silicon) foundation — round-12. `engine:'mlx'` entries are served
// by `mlx_lm.server` (via uv), NOT llama.cpp; the artifact is an
// `mlx-community/*` safetensors repo, not a GGUF. These are gated `darwin+arm64`
// (see `isMlxSupported`) and opt-in behind the "Prefer MLX" engine preference.
// Reserved (bytes 0, verified false): `mlx_lm.server` auto-downloads the repo on
// first launch, so there is no single-file sha/size to HEAD-verify here. MLX has
// no MTP/EAGLE parity and (in the text engine) no vision → text-only, no variants.
// ---------------------------------------------------------------------------

/** Qwen3.5 4B (MLX 4-bit): the MLX fast-tier proof model. */
const MLX_QWEN35_4B: CatalogModel = {
  id: 'mlx-qwen3.5-4b-4bit',
  displayName: 'Qwen3.5 4B (MLX 4-bit)',
  hfRepo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
  files: [{ name: 'Qwen3.5-4B-MLX-4bit', bytes: 0, quant: 'MLX-4bit' }],
  license: 'Apache-2.0',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text'],
  verified: false,
  engine: 'mlx',
  publisher: MLX_COMMUNITY,
  tier: 'fast',
  quantRange: 'MLX-4bit / MLX-8bit',
};

/** Qwen3.5 9B (MLX 4-bit): the MLX balanced-tier pick. */
const MLX_QWEN35_9B: CatalogModel = {
  id: 'mlx-qwen3.5-9b-4bit',
  displayName: 'Qwen3.5 9B (MLX 4-bit)',
  hfRepo: 'mlx-community/Qwen3.5-9B-MLX-4bit',
  files: [{ name: 'Qwen3.5-9B-MLX-4bit', bytes: 0, quant: 'MLX-4bit' }],
  license: 'Apache-2.0',
  minRamGB: 12,
  contextWindow: 65_536,
  input: ['text'],
  verified: false,
  engine: 'mlx',
  publisher: MLX_COMMUNITY,
  tier: 'balanced',
  quantRange: 'MLX-4bit / MLX-8bit',
};

/** Qwen3.6 27B (MLX mixed-precision OptiQ 4-bit): the MLX intelligent-tier pick. */
const MLX_QWEN36_27B: CatalogModel = {
  id: 'mlx-qwen3.6-27b-optiq',
  displayName: 'Qwen3.6 27B (MLX OptiQ 4-bit)',
  hfRepo: 'mlx-community/Qwen3.6-27B-OptiQ-4bit',
  files: [{ name: 'Qwen3.6-27B-OptiQ-4bit', bytes: 0, quant: 'OptiQ-4bit' }],
  license: 'Apache-2.0',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text'],
  verified: false,
  engine: 'mlx',
  publisher: MLX_COMMUNITY,
  tier: 'intelligent',
  quantRange: 'OptiQ-4bit (KL-sensitivity mixed precision)',
};

export const CATALOG: readonly CatalogModel[] = [
  GEMMA4_E2B,
  GEMMA4_E4B,
  GEMMA4_12B,
  GEMMA4_26B_A4B,
  GEMMA4_31B,
  QWEN35_0_8B_MTP,
  QWEN35_2B_MTP,
  QWEN35_4B_MTP,
  QWEN35_9B_MTP,
  QWEN35_122B_A10B_MTP,
  QWEN36_27B_MTP,
  QWEN36_35B_A3B_MTP,
  QWEN36_27B_EAGLE3,
  NEMOTRON3_NANO_30B_A3B,
  MLX_QWEN35_4B,
  MLX_QWEN35_9B,
  MLX_QWEN36_27B,
];

/** All MLX (Apple-Silicon) catalog entries — the opt-in `engine:'mlx'` set. */
export const MLX_MODELS: readonly CatalogModel[] = CATALOG.filter(
  (m) => (m.engine ?? 'llamacpp') === 'mlx',
);

const BY_ID = new Map(CATALOG.map((m) => [m.id, m]));

export function getCatalogModel(id: string): CatalogModel | undefined {
  return BY_ID.get(id);
}

/** Find a specific quant within a model, by exact quant label. */
export function getCatalogFile(model: CatalogModel, quant: string): CatalogFile | undefined {
  return model.files.find((f) => f.quant === quant);
}

/** The inference engine for a model (defaults to 'llamacpp' when unset). */
export function modelEngine(model: CatalogModel): Engine {
  return model.engine ?? 'llamacpp';
}

/** HF `resolve/main` download URL for a catalog file. */
export function hfResolveUrl(repo: string, fileName: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${fileName}`;
}
