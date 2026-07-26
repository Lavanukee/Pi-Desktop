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
  Gen3dRole,
} from '../../electron/gen3d/gen3d-contract';
import { type TripoOp, useTripoStore } from './store';

interface Gen3dState {
  loaded: boolean;
  engineReady: boolean;
  models: readonly Gen3dModelInfo[];
  resolutions: Readonly<Record<Gen3dResolution, number>>;
  /** Live download progress by model id. */
  downloads: Readonly<Record<string, Gen3dDownloadUpdate>>;
  /** The active generation/stage job (one at a time in the UI). */
  job: Gen3dJobUpdate | null;
  /** The job whose model is now ON SCREEN. Sticky for the life of the job: the
   * artifact only rides ONE update, but the generating UI has to stay in its
   * "model is visible, keep refining" phase for every update after it. */
  modelReadyJobId: string | null;
  /**
   * The stages THIS job will actually run, recorded at dispatch.
   *
   * The progress bar draws one chunk per stage, so it has to know the real
   * plan: a run from a user-supplied image never touches `image`, and a run
   * with auto-texture off ends at `geometry`. Inferring the chain from the
   * current stage (what the old chips did) shows stages that will never
   * happen and can never tick green.
   */
  jobPlan: { readonly jobId: string; readonly stages: readonly Gen3dRole[] } | null;
  /** Show the engine-download panel (fills the left column). */
  downloadPromptOpen: boolean;
  /** A model to scroll to + highlight when the panel opens (from a stage CTA). */
  downloadFocus: Gen3dModelId | null;
  /**
   * Why the last generate/stage request was REFUSED before any job existed.
   *
   * The engine can reject a request outright — a model not installed, no input
   * image — and until now every caller did `void generate(...)` and dropped the
   * reason on the floor. Pressing Generate then did visibly nothing at all,
   * which is the worst possible answer.
   */
  startError: string | null;

  refresh: () => Promise<void>;
  setDownloadPromptOpen: (open: boolean, focus?: Gen3dModelId | null) => void;
  download: (ids: readonly Gen3dModelId[]) => Promise<string | null>;
  generate: (req: {
    kind: 'text' | 'image';
    prompt?: string;
    /** One-or-more input images (image kind); multi = unlabeled conditioning. */
    imagePaths?: readonly string[];
    resolution: Gen3dResolution;
    texture: boolean;
    /** Stop after the text→image hop (for the Image panel's "Generate image"). */
    imageOnly?: boolean;
    /** Shape model for text→3D: TRELLIS (via an image) or Cube3D (direct). */
    engine?: 'trellis2' | 'cube3d';
    /** TRELLIS bake resolution in texels. */
    textureSize?: number;
    /** Triangle cap for the textured mesh; 0/undefined = Adaptive. */
    faceBudget?: number;
    /** Cube3D: split the result into these named parts. */
    parts?: readonly string[];
    /** Edit this image instead of generating (Mage-Flow-Edit; imageOnly). */
    editFrom?: string;
  }) => Promise<string | null>;
  runStage: (
    op: 'segment' | 'retopo' | 'texture' | 'rig',
    modelPath: string,
    /** Which asset/version this op ran on — the result becomes a node on that
     * asset's history tree instead of a new top-level asset. */
    origin?: StageOrigin,
    extra?: {
      readonly targetQuads?: number;
      readonly adaptivity?: number;
      readonly probeOnly?: boolean;
      readonly requireHumanoid?: boolean;
      readonly sourcePath?: string;
      /**
       * The humanoid verdict the user already confirmed, carried onto the
       * version this job produces. UI-only — stripped before the IPC call.
       */
      readonly knownHumanoid?: boolean;
    },
  ) => Promise<string | null>;
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
  modelReadyJobId: null,
  jobPlan: null,
  downloadPromptOpen: false,
  downloadFocus: null,
  startError: null,

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
  setDownloadPromptOpen: (open, focus = null) =>
    set({ downloadPromptOpen: open, downloadFocus: open ? focus : null }),
  download: async (ids) => {
    const res = await window.piDesktop.invoke('gen3d:download', { ids }).catch(() => null);
    if (res === null || !res.ok) return res?.error ?? 'download failed to start';
    return null;
  },
  generate: async (req) => {
    set({ startError: null });
    const res = await window.piDesktop
      .invoke('gen3d:generate', {
        kind: req.kind,
        ...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
        ...(req.imagePaths !== undefined ? { imagePaths: req.imagePaths } : {}),
        resolution: req.resolution,
        texture: req.texture,
        ...(req.imageOnly === true ? { imageOnly: true } : {}),
        ...(req.engine !== undefined ? { engine: req.engine } : {}),
        ...(req.textureSize !== undefined ? { textureSize: req.textureSize } : {}),
        ...(req.faceBudget !== undefined ? { faceBudget: req.faceBudget } : {}),
        ...(req.parts !== undefined ? { parts: req.parts } : {}),
        ...(req.editFrom !== undefined ? { editFrom: req.editFrom } : {}),
      })
      .catch(() => null);
    if (res === null || !res.ok) {
      const why = res?.error ?? 'generation failed to start';
      set({ startError: why });
      return why;
    }
    if (res.jobId !== undefined) {
      set({ jobPlan: { jobId: res.jobId, stages: plannedStages(req) } });
    }
    // Clear the viewport: this job builds a NEW model, so the previous one must
    // not sit there pretending to be it. jedd: "the plane stays in the
    // background while we generate a completely new thing." A stage op is the
    // opposite case — it transforms what is on screen, which stays put.
    if (req.imageOnly !== true) {
      useTripoStore.setState({ loadedAssetId: null, previewVersionId: null });
    }
    return null;
  },
  runStage: async (op, modelPath, origin, extra) => {
    set({ startError: null });
    // `knownHumanoid` is a UI-side carry-over, NOT part of the engine request —
    // keep it out of the IPC payload (gen3d:stage's contract does not have it).
    const { knownHumanoid, ...engineOptions } = extra ?? {};
    const res = await window.piDesktop
      .invoke('gen3d:stage', { op, modelPath, ...engineOptions })
      .catch(() => null);
    if (res === null || !res.ok) {
      const why = res?.error ?? `${op} failed to start`;
      set({ startError: why });
      return why;
    }
    if (res.jobId !== undefined) {
      set({ jobPlan: { jobId: res.jobId, stages: [op] } });
      if (origin !== undefined) stageOrigins.set(res.jobId, origin);
      // Only a probe run should raise the "humanoid?" question — the rig run
      // that follows emits the same measurement and must not re-ask.
      if (extra?.probeOnly === true) probeJobs.add(res.jobId);
      /*
       * Carry the verdict the user just CONFIRMED into the rig job.
       *
       * The shape probe (rig_worker --probe-only) measures humanoid-ness and
       * the panel asks about it; the rig that FOLLOWS is a different job, and
       * when SkinTokens is installed jobs.py routes it to skintokens_worker —
       * which emits `isHumanoid: false` as a placeholder (see confirmedHumanoid
       * for why that is a non-answer). Kept in its own map so that emission
       * cannot overwrite it.
       */
      if (knownHumanoid !== undefined) confirmedHumanoid.set(res.jobId, knownHumanoid);
    }
    return null;
  },
  cancelJob: async () => {
    const job = get().job;
    if (job === null) return;
    await window.piDesktop.invoke('gen3d:cancel', { jobId: job.jobId }).catch(() => null);
    set({ job: null, modelReadyJobId: null, jobPlan: null });
  },
  clearJob: () => set({ job: null, modelReadyJobId: null, jobPlan: null }),
}));

/** Which stages a generate request will really run, in pipeline order. */
function plannedStages(req: {
  readonly kind: 'text' | 'image';
  readonly texture: boolean;
  readonly imageOnly?: boolean;
  readonly engine?: 'trellis2' | 'cube3d';
  readonly parts?: readonly string[];
}): readonly Gen3dRole[] {
  if (req.imageOnly === true) return ['image'];
  // Cube3D is text→shape: no image stage, no texture, and an optional split.
  if (req.engine === 'cube3d' && req.kind === 'text') {
    return (req.parts?.length ?? 0) > 0 ? ['geometry', 'segment'] : ['geometry'];
  }
  const stages: Gen3dRole[] = req.kind === 'text' ? ['image', 'geometry'] : ['geometry'];
  if (req.texture) stages.push('texture');
  return stages;
}

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

/** Where a stage job came from, so its result lands on the right history tree. */
export interface StageOrigin {
  readonly assetId: string;
  readonly versionId: string;
  readonly op: TripoOp;
}

/** jobId → origin, recorded when a stage op is dispatched. */
const stageOrigins = new Map<string, StageOrigin>();

/** jobId → the rig stage's humanoid verdict, so the produced version records it. */
const jobHumanoid = new Map<string, boolean>();

/**
 * jobId → the humanoid verdict the USER confirmed, which outranks the engine's.
 *
 * `skintokens_worker.py` emits `humanoid: { isHumanoid: false, reasons: ["14
 * joints predicted by SkinTokens"] }` — and its own comment says why: "SkinTokens
 * predicts an arbitrary skeleton rather than fitting a humanoid template, so
 * there is no humanoid/non-humanoid verdict to make". It is a NON-ANSWER shaped
 * like an answer, and because it arrives on the same channel as the real
 * measurement it silently overwrote what the shape probe measured and the user
 * then confirmed. MEASURED: `shape probe said humanoid=true` and `motion library
 * hidden: the rig did not read as humanoid` in the same run, twice.
 *
 * A confirmed answer therefore lives in its own map and wins. Only the SHAPE
 * PROBE (rig_worker --probe-only) produces a verdict worth overriding it, and
 * that is a different job.
 */
const confirmedHumanoid = new Map<string, boolean>();

/** Jobs dispatched as shape probes — the only ones that ASK the user. */
const probeJobs = new Set<string>();

/**
 * The asset a GENERATE job already created, so its later artifacts extend that
 * asset instead of piling up beside it.
 *
 * A textured run emits the untextured geometry first and the textured model
 * minutes later. Both are `model-glb` on the same job, so both used to become
 * separate top-level assets — the same clutter the version tree exists to kill,
 * just on the generate path instead of the stage path.
 */
const jobRootAsset = new Map<string, { assetId: string; versionId: string }>();

/**
 * Serialises artifact ingestion PER JOB.
 *
 * `ingestModelArtifact` is async and fire-and-forget, but it only records
 * `jobRootAsset` after several awaits (fetch → arrayBuffer → dynamic import).
 * Two artifacts from one job therefore raced: the textured model could start
 * ingesting while the geometry was still awaiting, read an empty `jobRootAsset`,
 * and become a SECOND top-level asset — jedd: "multiple generated models are
 * added to the right sidebar … we should only have one entry per model". The
 * same race let `done` (which clears the job maps synchronously) land before a
 * late artifact had read them.
 *
 * Chaining each job's ingests means artifact N+1 always sees what N registered,
 * and cleanup below waits on the chain instead of cutting in front of it.
 */
const jobIngestChain = new Map<string, Promise<void>>();

/** Pull a freshly-produced GLB artifact into the viewport — as a NODE on the
 * originating asset's history tree when the job was a stage op, or as a brand
 * new asset when it was a fresh generation. This is how generated geometry
 * appears THE MOMENT it exists (before texturing ends). */
async function ingestModelArtifact(
  path: string,
  label: string,
  origin: StageOrigin | undefined,
  humanoidVerdict: boolean,
  jobId: string,
  previewPath?: string,
): Promise<void> {
  if (importedArtifacts.has(path)) return;
  importedArtifacts.add(path);
  try {
    // Display the preview when the engine says the real mesh is too heavy; the
    // asset still records `path`, so every downstream stage runs on the full
    // mesh rather than on what we happened to draw.
    const res = await fetch(pdFileUrl(previewPath ?? path));
    if (!res.ok) {
      importedArtifacts.delete(path);
      return;
    }
    const buffer = await res.arrayBuffer();
    const name = path.split('/').pop() ?? 'generated.glb';
    const io = await import('./viewer-io');
    // The model is in the viewer from here on — the generating UI switches out
    // of its full-viewport phase and into the slim bottom bar.
    const markVisible = () => useGen3dStore.setState({ modelReadyJobId: jobId });
    if (origin !== undefined) {
      io.addStageVersion(origin.assetId, origin.versionId, name, 'glb', buffer, {
        op: origin.op,
        label,
        diskPath: path,
        humanoid: humanoidVerdict,
      });
      /*
       * Tell the STUDIO which pipeline stage it is now showing.
       *
       * `useTripoStore.runStage` is the only writer of `pipelineStage`, of the
       * History list, and of the texture stage's switch to Textured mode — and
       * nothing called it. Verified: `grep -rn runStage apps/desktop/src` finds
       * only the gen3d ENGINE dispatch of the same name. So `pipelineStage`
       * never left 'mesh', every `stage === 'segment' | 'retopo' | 'rig'`
       * branch in Viewer3D was dead on the real engine path, and the History
       * tab stayed empty after five real jobs.
       *
       * MEASURED consequence: a 13.5-minute CubePart run finished, produced
       * five named part meshes with per-part colours, and changed NOTHING on
       * screen — same white model, empty Parts list (pipeline probe:
       * "segmentation (CubePart) — 0 part(s) listed in the panel (808s)").
       *
       * 'source' is the only TripoOp that is not a TripoStage, and a stage job
       * never produces one.
       */
      if (origin.op !== 'source') useTripoStore.getState().runStage(origin.op);
      markVisible();
      return;
    }
    const priorRoot = jobRootAsset.get(jobId);
    if (priorRoot !== undefined) {
      // A later artifact from the SAME generate job (texture after geometry):
      // a new version of what we already showed, not a second asset.
      io.addStageVersion(priorRoot.assetId, priorRoot.versionId, name, 'glb', buffer, {
        op: 'texture',
        label,
        diskPath: path,
      });
      markVisible();
      return;
    }
    const newId = io.importModelBuffer(name, 'glb', buffer, {
      source: 'generated',
      created: label,
      diskPath: path,
    });
    jobRootAsset.set(jobId, { assetId: newId, versionId: newId });
    markVisible();
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
  void import('./viewer-io').then((io) => {
    io.loadAssetTree();
  });
  window.piDesktop.onEvent('gen3d:job', (update) => {
    useGen3dStore.setState({ job: update });
    const origin = stageOrigins.get(update.jobId);
    // The rig stage measures the shape first — raise the "humanoid?" question
    // rather than deciding silently.
    if (update.humanoid !== undefined && origin !== undefined) {
      jobHumanoid.set(update.jobId, update.humanoid.isHumanoid);
    }
    if (update.humanoid !== undefined && origin !== undefined && probeJobs.has(update.jobId)) {
      useTripoStore.setState({
        humanoidPrompt: {
          assetId: origin.assetId,
          isHumanoid: update.humanoid.isHumanoid,
          confidence: update.humanoid.confidence,
          reasons: update.humanoid.reasons,
        },
      });
    }
    // Image artifacts build up a history so an edit can be compared against
    // what it came from, and so Make 3D acts on whichever one the user chose.
    if (update.artifact?.kind === 'image') {
      const { path, label } = update.artifact;
      useTripoStore.setState((s) => {
        if (s.imageVersions.some((v) => v.path === path)) return {};
        const imageVersions = [...s.imageVersions, { path, label }];
        return { imageVersions, imageIndex: imageVersions.length - 1 };
      });
    }
    if (update.artifact?.kind === 'model-glb') {
      const artifact = update.artifact;
      const jobId = update.jobId;
      // A verdict the user confirmed outranks anything the rig job emitted.
      const humanoid = confirmedHumanoid.get(jobId) ?? jobHumanoid.get(jobId) === true;
      // Queue behind this job's previous artifact so the geometry has registered
      // its asset before the textured model looks for it (see jobIngestChain).
      const chain = (jobIngestChain.get(jobId) ?? Promise.resolve())
        .then(() =>
          ingestModelArtifact(
            artifact.path,
            artifact.label,
            origin,
            humanoid,
            jobId,
            artifact.previewPath,
          ),
        )
        .catch(() => {});
      jobIngestChain.set(jobId, chain);
    }
    if (update.done) {
      const jobId = update.jobId;
      // Clear only once every ingest for this job has settled — clearing early
      // is what let a late artifact miss `jobRootAsset` and split into its own
      // asset.
      void (jobIngestChain.get(jobId) ?? Promise.resolve()).finally(() => {
        stageOrigins.delete(jobId);
        jobHumanoid.delete(jobId);
        confirmedHumanoid.delete(jobId);
        probeJobs.delete(jobId);
        jobRootAsset.delete(jobId);
        jobIngestChain.delete(jobId);
      });
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
