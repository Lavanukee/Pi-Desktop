/**
 * Renderer state for the Browse-Hugging-Face view of the Model Manager: runs
 * `hf:search` / `hf:list-files` (both proxied to the inference supervisor, which
 * owns @pi-desktop/inference's hf-search), holds the current results + the
 * selected repo's GGUF files, and adapts a chosen file into the local catalog
 * via `hf:register` before handing the actual download to the existing llm-store
 * downloader. The HF token comes from settings (gated repos / higher rate limit).
 */
import { create } from 'zustand';
import type { HfGgufFileDTO, HfModelHitDTO, HfSortOption } from '../../electron/ipc-contract';
import { useLlmStore } from './llm-store';
import { useSettingsStore } from './settings-store';

export interface HfSearchParams {
  query: string;
  family?: string;
  task?: string;
  gated?: boolean;
  minLikes?: number;
  sort?: HfSortOption;
  limit?: number;
}

type SearchStatus = 'idle' | 'searching' | 'done' | 'error';
type FilesStatus = 'idle' | 'loading' | 'done' | 'error';

interface HfStoreState {
  searchStatus: SearchStatus;
  results: HfModelHitDTO[];
  searchError: string | null;
  rateLimited: boolean;
  /** True when `results` is the default "trending on HF" set shown on open
   * (empty query, trending sort) rather than a user-typed search. Drives the
   * "Trending on Hugging Face" header instead of a plain results list. */
  defaultTrending: boolean;
  /** The repo whose files are shown (its GGUF quant picker is open). */
  selected: HfModelHitDTO | null;
  filesStatus: FilesStatus;
  files: HfGgufFileDTO[];
  filesError: string | null;
  /** The selected repo needs a token/licence (401/403 on the tree). */
  gatedRepo: boolean;

  /** Run an HF search. Pass `{ trending: true }` for the on-open default load so
   * the view flags it as the trending set (see {@link HfStoreState.defaultTrending}). */
  search: (params: HfSearchParams, meta?: { trending?: boolean }) => Promise<void>;
  selectRepo: (hit: HfModelHitDTO, contextWindow?: number) => Promise<void>;
  clearSelection: () => void;
  /**
   * Adapt the hit + chosen file into a catalog entry (hf:register), refresh the
   * local catalog so the entry appears, then start its download through the
   * existing downloader. Returns the registered model id.
   */
  addAndDownload: (
    hit: HfModelHitDTO,
    file: HfGgufFileDTO,
    opts?: { mmproj?: HfGgufFileDTO; mtpFile?: HfGgufFileDTO; contextWindow?: number },
  ) => Promise<string | null>;
}

function hfToken(): string | undefined {
  return useSettingsStore.getState().settings.hfToken || undefined;
}

export const useHfStore = create<HfStoreState>((set) => ({
  searchStatus: 'idle',
  results: [],
  searchError: null,
  rateLimited: false,
  defaultTrending: false,
  selected: null,
  filesStatus: 'idle',
  files: [],
  filesError: null,
  gatedRepo: false,

  search: async (params, meta) => {
    set({
      searchStatus: 'searching',
      searchError: null,
      rateLimited: false,
      defaultTrending: meta?.trending === true,
    });
    try {
      const res = await window.piDesktop.invoke('hf:search', {
        query: params.query,
        family: params.family,
        task: params.task,
        gated: params.gated,
        minLikes: params.minLikes,
        sort: params.sort,
        limit: params.limit,
        hfToken: hfToken(),
      });
      if (res.error !== undefined) {
        set({
          searchStatus: 'error',
          searchError: res.error,
          rateLimited: res.rateLimited === true,
          results: [],
        });
        return;
      }
      set({ searchStatus: 'done', results: res.hits });
    } catch (error) {
      set({
        searchStatus: 'error',
        searchError: String(error instanceof Error ? error.message : error),
        results: [],
      });
    }
  },

  selectRepo: async (hit, contextWindow) => {
    set({
      selected: hit,
      filesStatus: 'loading',
      files: [],
      filesError: null,
      gatedRepo: false,
    });
    try {
      const res = await window.piDesktop.invoke('hf:list-files', {
        repoId: hit.id,
        contextWindow,
        hfToken: hfToken(),
      });
      if (res.error !== undefined) {
        set({
          filesStatus: 'error',
          filesError: res.error,
          gatedRepo: res.gated === true || hit.gated,
        });
        return;
      }
      set({ filesStatus: 'done', files: res.files });
    } catch (error) {
      set({
        filesStatus: 'error',
        filesError: String(error instanceof Error ? error.message : error),
        gatedRepo: hit.gated,
      });
    }
  },

  clearSelection: () =>
    set({ selected: null, files: [], filesStatus: 'idle', filesError: null, gatedRepo: false }),

  addAndDownload: async (hit, file, opts) => {
    const res = await window.piDesktop.invoke('hf:register', {
      hit,
      file,
      mmproj: opts?.mmproj,
      mtpFile: opts?.mtpFile,
      contextWindow: opts?.contextWindow,
    });
    // Surface the freshly-registered entry in the local catalog, then download.
    await useLlmStore.getState().refreshCatalog();
    await useLlmStore.getState().downloadModel(res.modelId, file.quant);
    return res.modelId;
  },
}));

let connected = false;

/** E2E hook: expose the HF browse store under the same ?piE2E opt-in as the
 * other stores, so the model-manager probe can inject search results / files
 * without hitting the live HF API. Call once at renderer boot. */
export function connectHf(): void {
  if (connected) return;
  connected = true;
  if (new URLSearchParams(window.location.search).has('piE2E')) {
    window.__hf_store = () => useHfStore;
  }
}
