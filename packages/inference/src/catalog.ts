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
  license: 'Gemma',
  minRamGB: 16,
  contextWindow: 128_000,
  input: ['text', 'image'],
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
  license: 'Apache-2.0',
  minRamGB: 28,
  contextWindow: 65_536,
  input: ['text'],
  verified: true,
};

export const CATALOG: readonly CatalogModel[] = [
  GEMMA4_E2B,
  GEMMA4_E4B,
  GEMMA4_12B,
  QWEN36_27B_MTP,
  QWEN36_35B_A3B_MTP,
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
