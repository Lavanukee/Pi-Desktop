/**
 * Renderer-side gen3d engine client — one zustand store mirroring the engine
 * catalog (models + real download sizes + installed state), live download
 * progress, and the active generation job's staged progress. All UI reads
 * come from here; all engine actions go through the typed IPC contract.
 *
 * Graceful degradation is the contract: with the engine stub (or a failed
 * sidecar) `engineReady` stays false and the UI shows the download/setup
 * prompt instead of dead buttons.
 */
import { create } from 'zustand';
import type {
  Gen3dDownloadUpdate,
  Gen3dJobUpdate,
  Gen3dModelId,
  Gen3dModelInfo,
  Gen3dResolution,
} from '../../electron/gen3d/gen3d-contract';

interface Gen3dState {
  loaded: boolean;
  engineReady: boolean;
  models: readonly Gen3dModelInfo[];
  resolutions: Readonly<Record<Gen3dResolution, number>>;
  /** Live download progress by model id. */
  downloads: Readonly<Record<string, Gen3dDownloadUpdate>>;
  /** The active generation/stage job (one at a time in the UI). */
  job: Gen3dJobUpdate | null;
  /** Show the engine-download dialog. */
  downloadPromptOpen: boolean;

  refresh: () => Promise<void>;
  setDownloadPromptOpen: (open: boolean) => void;
  download: (ids: readonly Gen3dModelId[]) => Promise<string | null>;
  generate: (req: {
    kind: 'text' | 'image';
    prompt?: string;
    imagePath?: string;
    resolution: Gen3dResolution;
    texture: boolean;
  }) => Promise<string | null>;
  runStage: (op: 'segment' | 'retopo' | 'texture', modelPath: string) => Promise<string | null>;
  cancelJob: () => Promise<void>;
  clearJob: () => void;
}

export const useGen3dStore = create<Gen3dState>((set, get) => ({
  loaded: false,
  engineReady: false,
  models: [],
  resolutions: { low: 512, medium: 1024, high: 1536 },
  downloads: {},
  job: null,
  downloadPromptOpen: false,

  refresh: async () => {
    const res = await window.piDesktop.invoke('gen3d:catalog', undefined).catch(() => null);
    if (res === null) {
      set({ loaded: true, engineReady: false, models: [] });
      return;
    }
    set({
      loaded: true,
      engineReady: res.engineReady,
      models: res.models,
      resolutions: res.resolutions,
    });
  },
  setDownloadPromptOpen: (open) => set({ downloadPromptOpen: open }),
  download: async (ids) => {
    const res = await window.piDesktop.invoke('gen3d:download', { ids }).catch(() => null);
    if (res === null || !res.ok) return res?.error ?? 'download failed to start';
    return null;
  },
  generate: async (req) => {
    const res = await window.piDesktop.invoke('gen3d:generate', req).catch(() => null);
    if (res === null || !res.ok) return res?.error ?? 'generation failed to start';
    return null;
  },
  runStage: async (op, modelPath) => {
    const res = await window.piDesktop.invoke('gen3d:stage', { op, modelPath }).catch(() => null);
    if (res === null || !res.ok) return res?.error ?? `${op} failed to start`;
    return null;
  },
  cancelJob: async () => {
    const job = get().job;
    if (job === null) return;
    await window.piDesktop.invoke('gen3d:cancel', { jobId: job.jobId }).catch(() => null);
    set({ job: null });
  },
  clearJob: () => set({ job: null }),
}));

/** Human size: 16.2 GB / 640 MB. */
export function formatGb(bytes: number): string {
  if (bytes <= 0) return '—';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** pd-file:// URL for an absolute path (the scheme's `f` host + encoded path). */
function pdFileUrl(absPath: string): string {
  return `pd-file://f${absPath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Artifact paths already imported into the viewer (dedup across job updates). */
const importedArtifacts = new Set<string>();

/** Pull a freshly-produced GLB artifact into the viewport + assets — this is
 * how generated geometry appears THE MOMENT it exists (before texturing ends). */
async function ingestModelArtifact(path: string, label: string): Promise<void> {
  if (importedArtifacts.has(path)) return;
  importedArtifacts.add(path);
  try {
    const res = await fetch(pdFileUrl(path));
    if (!res.ok) return;
    const buffer = await res.arrayBuffer();
    const name = path.split('/').pop() ?? 'generated.glb';
    const { importModelBuffer } = await import('./viewer-io');
    importModelBuffer(name, 'glb', buffer, {
      source: 'generated',
      created: label,
      diskPath: path,
    });
  } catch {
    importedArtifacts.delete(path); // retry on the next update
  }
}

let wired = false;
/** Subscribe once to engine events + do the initial catalog load. */
export function ensureGen3dWired(): void {
  if (wired) return;
  wired = true;
  void useGen3dStore.getState().refresh();
  window.piDesktop.onEvent('gen3d:job', (update) => {
    useGen3dStore.setState({ job: update });
    if (update.artifact?.kind === 'model-glb') {
      void ingestModelArtifact(update.artifact.path, update.artifact.label);
    }
  });
  window.piDesktop.onEvent('gen3d:download', (update) => {
    useGen3dStore.setState((s) => ({ downloads: { ...s.downloads, [update.id]: update } }));
    if (update.done) void useGen3dStore.getState().refresh();
  });
  window.piDesktop.onEvent('gen3d:catalog-changed', () => {
    void useGen3dStore.getState().refresh();
  });
}
