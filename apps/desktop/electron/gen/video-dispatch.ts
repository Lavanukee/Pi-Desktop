/**
 * Video dispatch — the electron-free routing + job-building seam for
 * `generateVideo`. It keeps the {@link registerGenIpc} gen-manager thin and,
 * crucially, keeps this module importable by a `node`-environment unit test with
 * NO `electron` dependency (see apps/desktop/vitest.config.ts).
 *
 * A video job never goes through the uv worker (worker.py `dispatch()`
 * deliberately errors on video). Instead a {@link makeVideoAwareRunner}
 * dispatching runner splits by `job.backend`:
 *
 *   - `comfyui`     → the persistent ComfyUI adapter (LTX / Wan text→video),
 *   - `hyperframes` → the Node HyperFrames runner (ffmpeg + headless Chrome
 *                     motion graphics — deterministic, CPU, commercial-safe),
 *   - everything else (mflux image / mlx-audio / triposr / trellis) → the uv
 *     worker fallback, exactly as before (image generation is unchanged).
 *
 * {@link buildVideoJob} resolves a catalog {@link ModalityModel} + normalised
 * params into the right {@link GenJob} arm (`comfy` for ComfyUI, `video` for
 * HyperFrames). {@link defaultExtractPosterFrame} pulls a still first frame out
 * of the produced MP4 (ffmpeg, best-effort) so a chat model can critique output
 * it cannot watch. Everything real-runtime is injectable so the routing/builder
 * logic unit-tests against fakes — no ComfyUI, ffmpeg, or Chrome is required.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type {
  ComfyJobSpec,
  GenEvent,
  GenJob,
  GenOutput,
  GenRunnerLike,
  JobRunner,
  ModalityModel,
  VideoJobSpec,
} from '@pi-desktop/gen-service';

/** Options a runner accepts (the {@link JobRunner} tail). */
export interface VideoRunOptions {
  readonly onEvent?: (event: GenEvent) => void;
  readonly signal?: AbortSignal;
  readonly extraWith?: readonly string[];
}

/**
 * The Node HyperFrames renderer: authors an HTML/CSS/JS scene from the spec and
 * encodes it to an MP4 with ffmpeg + headless Chrome, emitting {@link GenEvent}s
 * as it goes. Injected so the routing/dispatch is testable without ffmpeg/Chrome
 * installed. Resolves with the produced artifact(s).
 */
export type HyperFramesRender = (
  spec: VideoJobSpec,
  outputDir: string,
  onEvent: (event: GenEvent) => void,
  signal?: AbortSignal,
) => Promise<GenOutput[]>;

/**
 * The default HyperFrames renderer for an environment where the motion-graphics
 * toolchain (ffmpeg + headless Chrome) is not installed: it emits a terminal
 * `error` and rejects with a clear message. Swapped for the real renderer once
 * the HyperFrames aux deps land.
 */
export const hyperFramesRenderUnavailable: HyperFramesRender = async (spec, _dir, onEvent) => {
  const message =
    'HyperFrames motion-graphics runner is not installed (needs ffmpeg + headless Chrome). ' +
    `Cannot render "${spec.modelId}".`;
  onEvent({ event: 'error', jobId: spec.modelId, message, recoverable: false });
  throw new Error(message);
};

/**
 * Adapts a {@link HyperFramesRender} to the `run(job, opts) → GenOutput[]`
 * contract the {@link JobQueue} takes (same shape as ComfyClient /
 * GenServiceClient), reading its params off the job's `video` arm.
 */
export class HyperFramesRunner implements GenRunnerLike {
  readonly #render: HyperFramesRender;

  constructor(render: HyperFramesRender = hyperFramesRenderUnavailable) {
    this.#render = render;
  }

  async run(job: GenJob, opts: VideoRunOptions = {}): Promise<GenOutput[]> {
    const spec = job.video;
    if (spec === undefined) {
      throw new Error(`hyperframes job "${job.id}" is missing its \`video\` spec`);
    }
    return this.#render(spec, job.outputDir, (event) => opts.onEvent?.(event), opts.signal);
  }
}

/** The runners a {@link makeVideoAwareRunner} dispatches to. */
export interface VideoAwareRunnerDeps {
  /** `comfyui`-backend jobs (LTX / Wan text→video, and advanced ComfyUI image). */
  readonly comfy: GenRunnerLike;
  /** `hyperframes`-backend jobs (Node motion graphics). */
  readonly hyperframes: GenRunnerLike;
  /** Every other backend (mflux image, mlx-audio, triposr, trellis) → uv worker. */
  readonly fallback: GenRunnerLike;
}

/**
 * Compose one {@link JobRunner} that routes by `job.backend`: `comfyui` → the
 * ComfyUI adapter, `hyperframes` → the Node runner, and everything else → the uv
 * worker. A superset of gen-service's `makeGenRunner` that adds the HyperFrames
 * arm; image generation (mflux → fallback) is unaffected. Heavy/light
 * unified-memory gating keys off the catalog entry, not the backend, so it works
 * across all three for free.
 */
export function makeVideoAwareRunner(deps: VideoAwareRunnerDeps): JobRunner {
  return (job, opts) => {
    switch (job.backend) {
      case 'comfyui':
        return deps.comfy.run(job, opts);
      case 'hyperframes':
        return deps.hyperframes.run(job, opts);
      default:
        return deps.fallback.run(job, opts);
    }
  };
}

/** Normalised, backend-agnostic video params the app resolves before building a job. */
export interface VideoJobParams {
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly fps: number;
  readonly steps?: number;
  readonly negativePrompt?: string;
  /** The single candidate seed (video generation is one-clip-per-job). */
  readonly seed: number;
}

/**
 * Resolve a catalog VIDEO {@link ModalityModel} + normalised params into the
 * right {@link GenJob}: a `comfy` spec for ComfyUI (LTX/Wan) — with frame count
 * derived as `round(seconds × fps)` and only param keys the workflow template
 * binds — or a `video` spec for the HyperFrames runner. Throws on a
 * non-video / mis-wired model so the caller never enqueues an invalid job.
 */
export function buildVideoJob(
  model: ModalityModel,
  params: VideoJobParams,
  jobId: string,
  outputDir: string,
): GenJob {
  if (model.modality !== 'video') {
    throw new Error(`model "${model.id}" is not a video model`);
  }
  const seeds = [params.seed];

  if (model.backend === 'comfyui') {
    if (model.comfy === undefined) {
      throw new Error(`video model "${model.id}" has no ComfyUI workflow config`);
    }
    // Only include keys the workflow template's paramMap binds (fillWorkflow
    // throws on an unbound input). `seconds × fps` collapses to a frame `length`.
    const length = Math.max(1, Math.round(params.seconds * params.fps));
    const inputs: Record<string, string | number | boolean> = {
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      length,
    };
    if (params.negativePrompt !== undefined) inputs.negativePrompt = params.negativePrompt;
    if (params.steps !== undefined) inputs.steps = params.steps;
    const comfy: ComfyJobSpec = {
      prompt: params.prompt,
      modelId: model.id,
      workflowTemplate: model.comfy.workflowTemplate,
      inputs,
      seeds,
    };
    return { id: jobId, modality: 'video', backend: 'comfyui', outputDir, comfy };
  }

  if (model.backend === 'hyperframes') {
    const video: VideoJobSpec = {
      prompt: params.prompt,
      modelId: model.id,
      width: params.width,
      height: params.height,
      seconds: params.seconds,
      fps: params.fps,
      negativePrompt: params.negativePrompt,
      seeds,
    };
    return { id: jobId, modality: 'video', backend: 'hyperframes', outputDir, video };
  }

  throw new Error(`video model "${model.id}" has unsupported backend "${model.backend}"`);
}

/** Extracts a still poster frame from a produced video, or `undefined` on failure. */
export type FrameExtractor = (videoPath: string, outDir: string) => Promise<string | undefined>;

/**
 * Default poster-frame extractor: pull the FIRST frame of the clip with ffmpeg
 * (universal Mac binary, already a HyperFrames aux dep) into `<outDir>/poster.png`.
 * Best-effort — resolves `undefined` if ffmpeg is missing or exits non-zero so a
 * failed extraction never fails the generation itself (the video is still on
 * disk); the `generate_video` tool simply omits the self-critique image.
 */
export const defaultExtractPosterFrame: FrameExtractor = (videoPath, outDir) =>
  new Promise<string | undefined>((resolve) => {
    const outPath = path.join(outDir, 'poster.png');
    try {
      const proc = spawn(
        'ffmpeg',
        ['-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', outPath],
        { stdio: 'ignore' },
      );
      proc.on('error', () => resolve(undefined));
      proc.on('close', (code) => resolve(code === 0 ? outPath : undefined));
    } catch {
      resolve(undefined);
    }
  });
