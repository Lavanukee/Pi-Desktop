/**
 * Message protocol between the main-process host (llm-main.ts) and the
 * "inference-supervisor" utilityProcess (supervisor-entry.ts). Kept in its own
 * electron-free module so both bundles share exactly one set of types.
 */
import type {
  HfGgufFileDTO,
  HfModelHitDTO,
  HfSortOption,
  LlmCatalogEntry,
  LlmHardware,
  LlmRecommendation,
  LlmStatus,
} from '../ipc-contract';

export type LlmRequestBody =
  | { type: 'get-status' }
  | { type: 'list-catalog' }
  | { type: 'download-model'; modelId: string; quant?: string; hfToken?: string }
  | { type: 'pause-download' }
  | { type: 'cancel-download' }
  | { type: 'delete-model'; modelId: string }
  | { type: 'verify-model'; modelId: string; quant?: string }
  | {
      type: 'start-server';
      modelId: string;
      quant?: string;
      launchMode?: 'fast-text' | 'multimodal';
    }
  | { type: 'stop-server' }
  | {
      type: 'hf-search';
      query: string;
      family?: string;
      task?: string;
      gated?: boolean;
      minLikes?: number;
      sort?: HfSortOption;
      limit?: number;
      hfToken?: string;
    }
  | { type: 'hf-list-files'; repoId: string; contextWindow?: number; hfToken?: string }
  | {
      type: 'register-hf-model';
      hit: HfModelHitDTO;
      file: HfGgufFileDTO;
      mmproj?: HfGgufFileDTO;
      mtpFile?: HfGgufFileDTO;
      contextWindow?: number;
    };

export type LlmRequest = LlmRequestBody & { id: number };

/** Per-file result of re-hashing a downloaded model against its catalog sha256. */
export interface LlmVerifyFileResult {
  file: string;
  ok: boolean;
  /** Absent when the catalog entry carries no sha256 (nothing to check). */
  checked: boolean;
}

export interface LlmVerifyReply {
  ok: boolean;
  files: LlmVerifyFileResult[];
  error?: string;
}

export interface LlmCatalogReply {
  models: LlmCatalogEntry[];
  hardware: LlmHardware;
  recommendedModelId: string | null;
  recommendation: LlmRecommendation | null;
}

export interface HfSearchReply {
  hits: HfModelHitDTO[];
  error?: string;
  rateLimited?: boolean;
}

export interface HfListFilesReply {
  files: HfGgufFileDTO[];
  gated?: boolean;
  error?: string;
}

export interface HfRegisterReply {
  modelId: string;
  entry: LlmCatalogEntry;
}

export interface LlmDownloadProgress {
  modelId: string;
  file: string;
  received: number;
  total: number | null;
  fraction: number | null;
}

export type LlmOutbound =
  | { id: number; kind: 'reply'; result: unknown }
  | { id: number; kind: 'error'; error: string }
  | { kind: 'status'; status: LlmStatus }
  | { kind: 'download-progress'; progress: LlmDownloadProgress };

/** Minimal structural view of Electron's `process.parentPort` in the child. */
export interface UtilityParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
