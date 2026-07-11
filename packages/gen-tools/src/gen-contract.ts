/**
 * Wire protocol for the GENERATION bridge — the seam between the pi child (this
 * extension) and the Electron main process that owns the JobQueue + the canvas.
 *
 * Same shape + rationale as the browser-agent bridge (packages/browser-use/
 * protocol.ts): pi extensions run inside the spawned pi child (a separate
 * `ELECTRON_RUN_AS_NODE` process) with no access to `ipcMain` or the heavy
 * Python worker, so the app stands up a token-authed, line-delimited JSON-RPC
 * server on a Unix-domain socket and publishes its path + token on the child's
 * env before spawn. The extension connects and issues `generate`; the app
 * enqueues the job on the JobQueue, streams progress to the canvas (renderer),
 * and answers this request with the produced output paths.
 *
 * Because `generate` blocks until the (multi-second → multi-minute) job finishes,
 * the request timeout here is far larger than the browser bridge's. Pure types +
 * string constants so both sides depend on it without coupling.
 */
import type { GenOutput } from '@pi-desktop/gen-service';

/** Env var carrying the gen bridge socket path (Unix socket / Windows pipe). */
export const GEN_SOCK_ENV = 'PI_GEN_SOCK';
/** Env var carrying the shared secret every request must echo. */
export const GEN_TOKEN_ENV = 'PI_GEN_TOKEN';

/**
 * RPC methods the app's gen bridge implements.
 *
 * The METHOD NAME is the modality discriminator on the wire: `generate` is
 * image-shaped (mflux/MLX via the uv worker), `generateVideo` is video-shaped
 * (app-side bridge dispatches to `JobQueue → ComfyClient` for LTX/Wan, or the
 * Node HyperFrames runner for motion graphics — NOT the uv worker, whose
 * `dispatch()` deliberately errors on video). `generate` stays image-only so the
 * existing `generate_image` tool is unaffected.
 */
export type GenBridgeMethod = 'generate' | 'generateVideo' | 'cancel' | 'listModels';

/** One request on the wire. */
export interface GenBridgeRequest {
  readonly id: number;
  readonly token: string;
  readonly method: GenBridgeMethod;
  readonly params?: Record<string, unknown>;
}

/** One response on the wire. Never throws across the boundary. */
export interface GenBridgeResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** Params for the `generate` method (image modality, phase 1). */
export interface GenerateImageParams {
  readonly prompt: string;
  /** Catalog model id (e.g. `flux2-klein-4b`, `z-image-turbo`). Default = catalog default. */
  readonly model?: string;
  /** `<w>x<h>` (e.g. `512x512`). Default 1024x1024. */
  readonly size?: string;
  /** Candidate count (distinct seeds). Default 1. */
  readonly n?: number;
  readonly steps?: number;
  readonly seed?: number;
  readonly negativePrompt?: string;
}

/** Result of a completed `generate`: the job id + every produced output. */
export interface GenerateImageResult {
  readonly jobId: string;
  readonly outputs: readonly GenOutput[];
}

/** Params for the `generateVideo` method (video modality, phase 1). */
export interface GenerateVideoParams {
  readonly prompt: string;
  /**
   * Catalog video model id (e.g. `ltx-video-2b-distilled`, `wan2.1-t2v-1.3b`,
   * or a `hyperframes` motion-graphics entry). Default = catalog default video
   * model. The bridge routes by the model's catalog backend: ComfyUI (LTX/Wan)
   * or the Node HyperFrames runner.
   */
  readonly model?: string;
  /** Clip duration in seconds. Default per model/catalog. */
  readonly seconds?: number;
  /** `<w>x<h>` (e.g. `768x512`). Default per model. */
  readonly size?: string;
  /** Frames per second. Default per model. */
  readonly fps?: number;
  /** Base RNG seed for reproducibility. */
  readonly seed?: number;
  /** What to avoid in the video. */
  readonly negativePrompt?: string;
}

/**
 * Result of a completed `generateVideo`: the job id, every produced video
 * artifact, and a POSTER FRAME.
 *
 * A chat model can't watch an MP4, so — mirroring the pixels-as-image-blocks
 * self-critique that `generate_image` uses — the app extracts a first/mid frame
 * of the produced video as a still image and returns its path here. The
 * `generate_video` tool attaches that frame as an `image` block so a
 * vision-capable model can SEE (and, in phase 2, critique) its own output.
 * `posterFramePath` is absent when frame extraction failed (the video paths in
 * `outputs` are still valid).
 */
export interface GenerateVideoResult {
  readonly jobId: string;
  readonly outputs: readonly GenOutput[];
  /** Path to a still frame of the produced video, for model self-critique. */
  readonly posterFramePath?: string;
}

/** A catalog entry summary returned by `listModels` (model-viewer surfacing). */
export interface GenModelSummary {
  readonly id: string;
  readonly modality: string;
  readonly label: string;
  readonly license: string;
  readonly commercialUse: boolean;
  readonly runsLocally: boolean;
  readonly reserved: boolean;
}
