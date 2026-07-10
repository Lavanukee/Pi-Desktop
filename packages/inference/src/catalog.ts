/**
 * Typed GGUF model catalog.
 *
 * HF-VERIFIED 2026-07-08: every entry below was verified live against
 * Hugging Face by HEAD-ing its `resolve/main/<file>` URL and reading
 * `x-linked-size` (byte count) and `x-linked-etag` (LFS sha256). All entries
 * are `verified: true` with real `bytes` and `sha256`. Corrections applied vs
 * the pre-verification guesses:
 *   - Qwen3.6-27B repo is `unsloth/Qwen3.6-27B-MTP-GGUF` (was `…-27B-GGUF`). The
 *     MTP head is EMBEDDED in the main GGUF: the MTP-repo Q4_K_M is 17,106,773,120
 *     bytes vs 16,817,244,384 in the non-MTP repo (~289 MB larger), and there is
 *     no separate `mtp-*.gguf` sibling. Hence `mtpEmbedded: true`.
 *   - Qwen3.6-35B-A3B repo is `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` (was
 *     `…-A3B-GGUF`, which 404s). It ships ONLY UD-quants — plain `Q4_K_M`/`Q6_K`
 *     files do not exist — so we list `UD-Q4_K_M` (Q4-class) and `UD-Q6_K`
 *     (Q6-class). MTP is embedded (no separate `mtp-*.gguf`).
 *   - Gemma4 mmproj siblings are named `mmproj-F16.gguf` (was guessed
 *     `mmproj-gemma-4-…-F16.gguf`).
 * Downloads enforce sha256 when present and size only when > 0, so the shape
 * still tolerates a future unverified (bytes:0, no sha) entry safely.
 *
 * ROUND-11 Wave C (HF-VERIFIED 2026-07-10, tree `lfs.oid` == sha256): added
 * verified speculative-decoding SPEED variants spanning the 8GB→128GB tiers.
 *   - Gemma4 ships its MTP head as a SEPARATE Q8_0 sibling in the SAME repo
 *     (`mtp-gemma-4-*.gguf`); the E2B/E4B/12B entries now carry it (spec 'mtp'),
 *     and 26B-A4B + 31B are added. The sibling is fetched only for a fast-text
 *     launch and passed via `--model-draft`; the mmproj still drives multimodal.
 *   - Qwen3.5 MTP repos (`unsloth/Qwen3.5-{4B,9B}-MTP-GGUF`) EMBED the head like
 *     Qwen3.6 (no `mtp-*.gguf` sibling), so `mtpEmbedded: true`.
 *   - One EAGLE-3 pairing is encoded to exercise draft-model wiring:
 *     `unsloth/Qwen3.6-27B-GGUF` (plain base) + the community draft
 *     `gelim/Qwen3.6-27B-PRISM-EAGLE3-GGUF` (a DIFFERENT repo → `draftRepo`),
 *     launched with `--spec-type draft-eagle3 --model-draft <draft>`.
 *   - DFlash (block-diffusion) is intentionally NOT listed as a runnable option:
 *     GGUF DFlash drafts exist (e.g. `spiritbuun/Qwen3.6-27B-DFlash-GGUF`) but
 *     need a llama.cpp FORK; it is vLLM/SGLang-first (future / remote-GPU only).
 */

/** Per-launch server mode. MTP (fast-text) is mutually exclusive with mmproj. */
export type LaunchMode = 'fast-text' | 'multimodal';

export interface CatalogFile {
  /** GGUF file name within the HF repo (`resolve/main/<name>`). */
  readonly name: string;
  /** File size in bytes; 0 = unknown/unverified. */
  readonly bytes: number;
  /** Quantization label, e.g. "Q4_K_M", "Q6_K". */
  readonly quant: string;
  /** Lowercase hex sha256, when verified. */
  readonly sha256?: string;
}

/** Speculative-decoding speed method a catalog entry ships (see catalog note). */
export type SpecMethod = 'mtp' | 'eagle3';

export interface CatalogModel {
  readonly id: string;
  readonly displayName: string;
  /** HuggingFace repo, e.g. "unsloth/gemma-4-E2B-it-GGUF". */
  readonly hfRepo: string;
  /** Main GGUF file(s). Multiple entries = user picks a quant. */
  readonly files: readonly CatalogFile[];
  /** Vision projector sibling (multimodal launch). */
  readonly mmproj?: CatalogFile;
  /** Separate MTP head sibling (Gemma4 style). Undefined when embedded. */
  readonly mtpFile?: CatalogFile;
  /** True when the MTP head is embedded in the main GGUF (Qwen3.6 style). */
  readonly mtpEmbedded?: boolean;
  /**
   * Speed method this entry ships for fast-text launches:
   *   - 'mtp'    → `--spec-type draft-mtp` (embedded head, or the `mtpFile` sibling).
   *   - 'eagle3' → `--spec-type draft-eagle3 --model-draft <draftModel>`, where the
   *                EAGLE-3 draft usually lives in a SEPARATE repo ({@link draftRepo}).
   * Both run on stock upstream llama.cpp. (DFlash is deliberately absent — it is
   * vLLM/SGLang-first and needs a llama.cpp FORK, so it is not a shippable option.)
   */
  readonly spec?: SpecMethod;
  /** HF repo the EAGLE-3 draft lives in, when different from {@link hfRepo}. */
  readonly draftRepo?: string;
  /** EAGLE-3 draft GGUF (paired via `--model-draft`); undefined for MTP. */
  readonly draftModel?: CatalogFile;
  readonly license: string;
  /** Minimum system RAM (GB) to run this comfortably. */
  readonly minRamGB: number;
  readonly contextWindow: number;
  readonly input: readonly ('text' | 'image')[];
  /** True when the HF repo is gated (needs an accepted licence / token). */
  readonly gated?: boolean;
  /** True only for HEAD-verified repo/file/sha/size. */
  readonly verified: boolean;
}

/** Verified utility/integration model — small, fast, fits 24GB easily. */
export const GEMMA4_E2B: CatalogModel = {
  id: 'gemma-4-e2b-it',
  displayName: 'Gemma 4 E2B Instruct',
  hfRepo: 'unsloth/gemma-4-E2B-it-GGUF',
  files: [
    {
      name: 'gemma-4-E2B-it-Q4_K_M.gguf',
      bytes: 3_106_736_256,
      quant: 'Q4_K_M',
      sha256: '9378bc471710229ef165709b62e34bfb62231420ddaf6d729e727305b5b8672d',
    },
  ],
  // Gemma4 MTP head ships as a separate Q8_0 sibling in the same repo.
  mtpFile: {
    name: 'mtp-gemma-4-E2B-it.gguf',
    bytes: 97_817_664,
    quant: 'Q8_0',
    sha256: '9eba819938efccfd6044f8af84e3bbfddc639a2bcf32ebc36420e6a649191919',
  },
  spec: 'mtp',
  license: 'Gemma',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text'],
  verified: true,
};

const GEMMA4_E4B: CatalogModel = {
  id: 'gemma-4-e4b-it',
  displayName: 'Gemma 4 E4B Instruct',
  hfRepo: 'unsloth/gemma-4-E4B-it-GGUF',
  files: [
    {
      name: 'gemma-4-E4B-it-Q4_K_M.gguf',
      bytes: 4_977_169_568,
      quant: 'Q4_K_M',
      sha256: '519b9793ed6ce0ff530f1b7c96e848e08e49e7af4d57bb97f76215963a54146d',
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
  license: 'Gemma',
  minRamGB: 8,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: true,
};

const GEMMA4_12B: CatalogModel = {
  id: 'gemma-4-12b-it',
  displayName: 'Gemma 4 12B Instruct',
  hfRepo: 'unsloth/gemma-4-12b-it-GGUF',
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
  license: 'Gemma',
  minRamGB: 16,
  contextWindow: 128_000,
  input: ['text', 'image'],
  verified: true,
};

/** Gemma4 26B-A4B MoE (fast active params + MTP): a strong 32–48GB vision pick. */
const GEMMA4_26B_A4B: CatalogModel = {
  id: 'gemma-4-26b-a4b-it',
  displayName: 'Gemma 4 26B-A4B Instruct',
  hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
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
  license: 'Gemma',
  minRamGB: 24,
  contextWindow: 128_000,
  input: ['text', 'image'],
  verified: true,
};

/** Gemma4 31B dense (+ MTP): the high-tier vision-capable pick. */
const GEMMA4_31B: CatalogModel = {
  id: 'gemma-4-31b-it',
  displayName: 'Gemma 4 31B Instruct',
  hfRepo: 'unsloth/gemma-4-31B-it-GGUF',
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
  license: 'Gemma',
  minRamGB: 24,
  contextWindow: 128_000,
  input: ['text', 'image'],
  verified: true,
};

/** Qwen3.5 4B (embedded MTP): the 8GB-tier speed pick. */
const QWEN35_4B_MTP: CatalogModel = {
  id: 'qwen3.5-4b-mtp',
  displayName: 'Qwen3.5 4B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-4B-MTP-GGUF',
  files: [
    {
      name: 'Qwen3.5-4B-Q4_K_M.gguf',
      bytes: 2_834_975_040,
      quant: 'Q4_K_M',
      sha256: '3874209241c9a397e2f62cd3f70f80fd2dfbf0dfccb6838416bdb48a714e8630',
    },
    {
      name: 'Qwen3.5-4B-Q6_K.gguf',
      bytes: 3_639_654_720,
      quant: 'Q6_K',
      sha256: 'd8fe325a6184ac489529bb2286e879865d02acdd710ac0a54a0afa3e66051b87',
    },
  ],
  mtpEmbedded: true,
  spec: 'mtp',
  license: 'Apache-2.0',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text'],
  verified: true,
};

/** Qwen3.5 9B (embedded MTP): the 16GB-tier speed pick. */
const QWEN35_9B_MTP: CatalogModel = {
  id: 'qwen3.5-9b-mtp',
  displayName: 'Qwen3.5 9B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-9B-MTP-GGUF',
  files: [
    {
      name: 'Qwen3.5-9B-Q4_K_M.gguf',
      bytes: 5_868_826_976,
      quant: 'Q4_K_M',
      sha256: 'e8dd94817e95d6c0939102049d068418269978377b13616c4726235e232841fe',
    },
    {
      name: 'Qwen3.5-9B-Q6_K.gguf',
      bytes: 7_684_551_008,
      quant: 'Q6_K',
      sha256: '8ae8fd04e30c5a4af3ef72654729fb0d7f33615cac1ba335dd88084a56287934',
    },
  ],
  mtpEmbedded: true,
  spec: 'mtp',
  license: 'Apache-2.0',
  minRamGB: 12,
  contextWindow: 65_536,
  input: ['text'],
  verified: true,
};

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
  mtpEmbedded: true,
  spec: 'mtp',
  license: 'Apache-2.0',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text'],
  verified: true,
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
  mtpEmbedded: true,
  spec: 'mtp',
  license: 'Apache-2.0',
  minRamGB: 28,
  contextWindow: 65_536,
  input: ['text'],
  verified: true,
};

/**
 * Qwen3.6 27B with EAGLE-3 draft-model speculative decoding. The plain base
 * (`unsloth/Qwen3.6-27B-GGUF`) is paired with a community EAGLE-3 draft from a
 * SEPARATE repo, launched as `--spec-type draft-eagle3 --model-draft <draft>`.
 * Encoded to exercise the cross-repo draft-model wiring; MTP (the embedded
 * `qwen3.6-27b-mtp` above) is the simpler default for most users.
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
  spec: 'eagle3',
  draftRepo: 'gelim/Qwen3.6-27B-PRISM-EAGLE3-GGUF',
  draftModel: {
    name: 'Qwen3.6-27B-PRISM-EAGLE3_Q4_K_M.gguf',
    bytes: 1_290_881_632,
    quant: 'Q4_K_M',
    sha256: '296550cca35276756a7f8c45787f0a21d53f769ea13cea4ff25e5346d75a512c',
  },
  license: 'Apache-2.0',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text'],
  verified: true,
};

export const CATALOG: readonly CatalogModel[] = [
  GEMMA4_E2B,
  GEMMA4_E4B,
  GEMMA4_12B,
  GEMMA4_26B_A4B,
  GEMMA4_31B,
  QWEN35_4B_MTP,
  QWEN35_9B_MTP,
  QWEN36_27B_MTP,
  QWEN36_35B_A3B_MTP,
  QWEN36_27B_EAGLE3,
];

const BY_ID = new Map(CATALOG.map((m) => [m.id, m]));

export function getCatalogModel(id: string): CatalogModel | undefined {
  return BY_ID.get(id);
}

/** Find a specific quant within a model, by exact quant label. */
export function getCatalogFile(model: CatalogModel, quant: string): CatalogFile | undefined {
  return model.files.find((f) => f.quant === quant);
}

/** HF `resolve/main` download URL for a catalog file. */
export function hfResolveUrl(repo: string, fileName: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${fileName}`;
}
