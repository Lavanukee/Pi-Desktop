/**
 * gen3d — the 3D-generation engine IPC contract (Bobble 3D studio backend).
 *
 * The studio's stages are backed by REAL local models (all offline after
 * download, run by a uv/Python sidecar on Metal/MPS):
 *   geometry  → microsoft/TRELLIS.2-4B (image → 3D structured latents)
 *   image     → microsoft/Mage-Flow-Turbo (text → image, the text→3D first hop)
 *   texture   → tencent/Hunyuan3D-2.1 (the Hunyuan Paint component)
 *   segment   → Roblox/cubepart
 *   retopo    → AutoRemesher (huxingyi, MIT — compiled CLI, no download weight)
 *
 * This file is the SEAM between the renderer UI and the engine: the UI is
 * written against these types only; gen3d-main.ts implements them (stubbed as
 * "not installed" until the sidecar lands). Everything long-running reports
 * through `gen3d:*` events — per-stage progress percents, live stage messages,
 * and ARTIFACTS as soon as they exist (the untextured mesh lands in the viewer
 * the moment geometry finishes, while texturing keeps running).
 */

/** Engine model ids (stable — used in settings, downloads, and the catalog). */
export type Gen3dModelId = 'trellis2' | 'mageflow' | 'hunyuan-paint' | 'cubepart' | 'autoremesher';

/** Which studio stage a model backs. */
export type Gen3dRole = 'geometry' | 'image' | 'texture' | 'segment' | 'retopo';

export interface Gen3dModelInfo {
  readonly id: Gen3dModelId;
  readonly label: string;
  readonly role: Gen3dRole;
  /** Total download size in bytes (0 for compiled tools like AutoRemesher). */
  readonly sizeBytes: number;
  /** Fully downloaded + ready to run. */
  readonly installed: boolean;
  /** A download is currently in flight. */
  readonly downloading: boolean;
  /** Short capability note for the download dialog. */
  readonly note: string;
}

/** TRELLIS structure resolution presets (verified against the repo by the
 * engine; the UI treats them as low/medium/high). */
export type Gen3dResolution = 'low' | 'medium' | 'high';

/** A generation/stage job's live update. `overallPercent` spans the whole
 * pipeline; `stagePercent` is within the current stage. */
export interface Gen3dJobUpdate {
  readonly jobId: string;
  /** Pipeline position, e.g. 'image' | 'geometry' | 'texture' | 'segment' | 'retopo'. */
  readonly stage: Gen3dRole;
  /** Human stage line, e.g. "Geometry done — texturing (step 12/30)…". */
  readonly message: string;
  readonly stagePercent: number;
  readonly overallPercent: number;
  /** A produced artifact, pushed AS SOON as it exists (geometry-first). */
  readonly artifact?: {
    readonly kind: 'image' | 'model-glb';
    /** Absolute path on disk (renderer loads via the pd-file scheme / fs read). */
    readonly path: string;
    /** Label, e.g. "Untextured geometry" / "Textured model" / "Input image". */
    readonly label: string;
  };
  readonly done: boolean;
  readonly error?: string;
}

export interface Gen3dDownloadUpdate {
  readonly id: Gen3dModelId;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly done: boolean;
  readonly error?: string;
}

export type Gen3dInvokeMap = {
  /** The engine catalog: every model with real sizes + installed state, plus
   * whether the sidecar runtime itself is ready. */
  'gen3d:catalog': {
    request: undefined;
    response: {
      readonly engineReady: boolean;
      readonly models: readonly Gen3dModelInfo[];
      /** Engine-verified resolution presets, e.g. {low:768, medium:1024, high:1536}. */
      readonly resolutions: Readonly<Record<Gen3dResolution, number>>;
    };
  };
  /** Start downloading the given models (progress via gen3d:download events). */
  'gen3d:download': {
    request: { readonly ids: readonly Gen3dModelId[] };
    response: { readonly ok: boolean; readonly error?: string };
  };
  'gen3d:cancel-download': {
    request: { readonly id: Gen3dModelId };
    response: { readonly ok: boolean };
  };
  /** Generate a model. kind 'text' runs text→image→3D (Mage-Flow → TRELLIS);
   * kind 'image' starts from one or more input images (TRELLIS-2 does arbitrary
   * unlabeled multi-image conditioning — more images improve accuracy).
   * `texture` chains the native texture bake; `imageOnly` stops after the
   * text→image hop (Image panel). */
  'gen3d:generate': {
    request: {
      readonly kind: 'text' | 'image';
      readonly prompt?: string;
      readonly imagePaths?: readonly string[];
      readonly resolution: Gen3dResolution;
      readonly texture: boolean;
      readonly imageOnly?: boolean;
    };
    response: { readonly ok: boolean; readonly jobId?: string; readonly error?: string };
  };
  /** Run a single downstream stage on an existing model file. */
  'gen3d:stage': {
    request: {
      readonly op: 'segment' | 'retopo' | 'texture';
      readonly modelPath: string;
      /** Optional image/prompt context for texturing. */
      readonly prompt?: string;
    };
    response: { readonly ok: boolean; readonly jobId?: string; readonly error?: string };
  };
  'gen3d:cancel': {
    request: { readonly jobId: string };
    response: { readonly ok: boolean };
  };
};

/** Broadcast events (renderer subscribes via window.piDesktop.onEvent). */
export type Gen3dEventMap = {
  'gen3d:job': Gen3dJobUpdate;
  'gen3d:download': Gen3dDownloadUpdate;
  /** Catalog changed (a download finished / the sidecar came up). */
  'gen3d:catalog-changed': { readonly at: number };
};

export const GEN3D_INVOKE_CHANNELS = [
  'gen3d:catalog',
  'gen3d:download',
  'gen3d:cancel-download',
  'gen3d:generate',
  'gen3d:stage',
  'gen3d:cancel',
] as const satisfies readonly (keyof Gen3dInvokeMap)[];
