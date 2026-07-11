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

/** RPC methods the app's gen bridge implements. */
export type GenBridgeMethod = 'generate' | 'cancel' | 'listModels';

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
