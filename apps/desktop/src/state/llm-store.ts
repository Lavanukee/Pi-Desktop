/**
 * Renderer state for the inference supervisor: mirrors the utilityProcess's
 * status/TPS stream (llm:status) and download progress, and exposes the invoke
 * wrappers the composer footer + the full Model Manager (W10) call — download
 * with pause/resume/cancel/verify, delete, and start/stop.
 */
import { create } from 'zustand';
import type {
  LlmCatalogEntry,
  LlmHardware,
  LlmRecommendation,
  LlmStatus,
} from '../../electron/ipc-contract';
import { useSettingsStore } from './settings-store';

export interface LlmDownloadState {
  modelId: string;
  quant?: string;
  file: string;
  received: number;
  total: number | null;
  fraction: number | null;
  /** Rolling transfer rate in bytes/sec, or null before a second sample. */
  bytesPerSec: number | null;
  paused: boolean;
}

export interface LlmVerifyResult {
  ok: boolean;
  files: Array<{ file: string; ok: boolean; checked: boolean }>;
  error?: string;
}

interface LlmStoreState {
  status: LlmStatus;
  catalog: LlmCatalogEntry[];
  hardware: LlmHardware | null;
  recommendedModelId: string | null;
  recommendation: LlmRecommendation | null;
  download: LlmDownloadState | null;

  applyStatus: (status: LlmStatus) => void;
  applyDownloadProgress: (p: {
    modelId: string;
    file: string;
    received: number;
    total: number | null;
    fraction: number | null;
  }) => void;
  refreshCatalog: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  /** Start OR resume a download; resolves when it finishes, pauses, or fails. */
  downloadModel: (modelId: string, quant?: string) => Promise<void>;
  pauseDownload: () => Promise<void>;
  resumeDownload: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  verifyModel: (modelId: string, quant?: string) => Promise<LlmVerifyResult>;
  /** Start the server for a model. `launchMode:'multimodal'` requests an
   * on-demand vision launch (fetches the mmproj sibling, drops MTP). */
  startServer: (
    modelId: string,
    quant?: string,
    launchMode?: 'fast-text' | 'multimodal',
  ) => Promise<{ success: boolean; error?: string }>;
  stopServer: () => Promise<void>;
}

const initialStatus: LlmStatus = {
  phase: 'idle',
  serverRunning: false,
  baseUrl: null,
  model: null,
  metrics: null,
  downloadedModelIds: [],
};

/** Speed sampling across progress events (module-level: not render state). */
let lastSample: { modelId: string; received: number; at: number } | null = null;

function sampleSpeed(modelId: string, received: number): number | null {
  const now = Date.now();
  const prev = lastSample;
  lastSample = { modelId, received, at: now };
  if (prev === null || prev.modelId !== modelId) return null;
  const dt = (now - prev.at) / 1000;
  const db = received - prev.received;
  if (dt <= 0 || db < 0) return null;
  return db / dt;
}

export const useLlmStore = create<LlmStoreState>((set, get) => ({
  status: initialStatus,
  catalog: [],
  hardware: null,
  recommendedModelId: null,
  recommendation: null,
  download: null,

  // The download lifecycle is owned by the actions (which resolve on
  // finish/pause/cancel), so status transitions must NOT clear the bar — a
  // paused download settles the supervisor to idle while the bar stays up.
  applyStatus: (status) => set({ status }),

  applyDownloadProgress: (p) =>
    set((s) => ({
      download: {
        modelId: p.modelId,
        quant: s.download?.modelId === p.modelId ? s.download.quant : undefined,
        file: p.file,
        received: p.received,
        total: p.total,
        fraction: p.fraction,
        bytesPerSec: sampleSpeed(p.modelId, p.received),
        paused: false,
      },
    })),

  refreshCatalog: async () => {
    const res = await window.piDesktop.invoke('llm:list-catalog', undefined);
    set({
      catalog: res.models,
      hardware: res.hardware,
      recommendedModelId: res.recommendedModelId,
      recommendation: res.recommendation,
    });
  },

  refreshStatus: async () => {
    const status = await window.piDesktop.invoke('llm:get-status', undefined);
    set({ status });
  },

  downloadModel: async (modelId, quant) => {
    lastSample = null;
    set({
      download: {
        modelId,
        quant,
        file: '',
        received: 0,
        total: null,
        fraction: 0,
        bytesPerSec: null,
        paused: false,
      },
    });
    // Gated HF repos need the saved token; public repos ignore it.
    const hfToken = useSettingsStore.getState().settings.hfToken || undefined;
    const res = await window.piDesktop.invoke('llm:download-model', { modelId, quant, hfToken });
    if (res.paused === true) {
      // Keep the bar; flip to the paused affordance (Resume).
      set((s) => (s.download ? { download: { ...s.download, paused: true } } : {}));
    } else {
      set({ download: null });
    }
    await get().refreshCatalog();
  },

  pauseDownload: async () => {
    set((s) => (s.download ? { download: { ...s.download, paused: true } } : {}));
    await window.piDesktop.invoke('llm:pause-download', undefined);
  },

  resumeDownload: async () => {
    const d = get().download;
    if (d === null) return;
    await get().downloadModel(d.modelId, d.quant);
  },

  cancelDownload: async () => {
    await window.piDesktop.invoke('llm:cancel-download', undefined);
    set({ download: null });
    await get().refreshCatalog();
  },

  deleteModel: async (modelId) => {
    await window.piDesktop.invoke('llm:delete-model', { modelId });
    await get().refreshStatus();
    await get().refreshCatalog();
  },

  verifyModel: async (modelId, quant) =>
    window.piDesktop.invoke('llm:verify-model', { modelId, quant }),

  startServer: async (modelId, quant, launchMode) => {
    const res = await window.piDesktop.invoke('llm:start-server', {
      modelId,
      quant,
      ...(launchMode !== undefined ? { launchMode } : {}),
    });
    return { success: res.success, error: res.error };
  },

  stopServer: async () => {
    await window.piDesktop.invoke('llm:stop-server', undefined);
  },
}));

let connected = false;

/** Attach the llm event stream to the store (call once at renderer boot). */
export function connectLlm(): void {
  if (connected) return;
  connected = true;
  window.piDesktop.onEvent('llm:status', (status) => useLlmStore.getState().applyStatus(status));
  window.piDesktop.onEvent('llm:download-progress', (p) =>
    useLlmStore.getState().applyDownloadProgress({
      modelId: p.modelId,
      file: p.file,
      received: p.received,
      total: p.total,
      fraction: p.fraction,
    }),
  );

  // E2E hook (same opt-in as __pi_store): lets the model-manager probe drive
  // download-progress + status deterministically, without a real download.
  if (new URLSearchParams(window.location.search).has('piE2E')) {
    window.__llm_store = () => useLlmStore;
  }
}
