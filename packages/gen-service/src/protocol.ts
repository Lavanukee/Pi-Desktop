/**
 * The generation job protocol — the REMOTE-CAPABLE seam between the app and a
 * generation worker (local uv/mflux today; a remote GPU worker later).
 *
 * A job is a plain JSON envelope ({@link GenJob}); the worker streams its
 * lifecycle back as newline-delimited JSON ({@link GenEvent}) on stdout. Because
 * both directions are pure JSON over a byte stream, the exact same contract works
 * whether the worker is a child process on this Mac (see {@link ../client}) or a
 * process on a remote host whose stdout is tunnelled back — the transport is the
 * only thing that changes, never this protocol.
 *
 * This module is pure types + a small NDJSON parser so BOTH the Node client and
 * any TS consumer can depend on it without pulling in Node-only APIs.
 */

/**
 * Generation modality. Image ships in phase 1; audio/video/3d are reserved so
 * the envelope + worker stay modality-pluggable (see {@link ../catalog}).
 */
export type Modality = 'image' | 'audio' | 'video' | '3d';

/**
 * The concrete backend that fulfils a job.
 *
 * Two shapes live behind this union (see round-13 synthesis §2):
 *   - process-per-job **uv worker** backends — `mflux` (image), `mlx-audio`
 *     (TTS), `triposr` / `trellis` (3D), each driven by the bundled `worker.py`
 *     over NDJSON (see {@link ../client});
 *   - the persistent-server **`comfyui`** backend — a long-lived aiohttp server
 *     on `127.0.0.1` that the ComfyUI adapter POSTs workflow JSON to and whose
 *     ws messages it translates into the SAME {@link GenEvent} union (video /
 *     music / advanced-image graphs);
 *   - `hyperframes` — the Node+ffmpeg motion-graphics path;
 *   - `torch-tts` — a torch/MPS→CPU TTS path (Chatterbox) that is NOT the
 *     mlx-audio CLI (slower, Perth-watermarked output); driven by the same uv
 *     worker but with a torch base package instead of mlx-audio.
 */
export type Backend =
  | 'mflux'
  | 'mlx-audio'
  | 'torch-tts'
  | 'triposr'
  | 'trellis'
  | 'hyperframes'
  | 'comfyui';

/**
 * Backend-resolved image parameters. The app resolves a catalog entry
 * ({@link ../catalog}) into these concrete fields so the worker stays a dumb
 * executor (no catalog knowledge on the worker side — important for the remote
 * worker, which must not need the TS catalog).
 */
export interface ImageJobSpec {
  readonly prompt: string;
  /** Catalog id — stamped as the output FOOTNOTE (e.g. `z-image-turbo`). */
  readonly modelId: string;
  /**
   * mflux console command to spawn. The unified `mflux-generate` only drives the
   * FLUX pipeline, so Z-Image / FLUX.2 / Qwen need their DEDICATED command (e.g.
   * `mflux-generate-z-image-turbo`) — carried here from the catalog.
   */
  readonly mfluxCommand: string;
  /** mflux `--model` arg when the command multiplexes families (flux2 variants, schnell). */
  readonly mfluxModel?: string;
  /** mflux `--base-model` family when `--model` is a third-party HF repo. */
  readonly baseModel?: string;
  readonly width?: number;
  readonly height?: number;
  readonly steps?: number;
  /** One seed per candidate; length drives how many images the job produces. */
  readonly seeds: readonly number[];
  readonly negativePrompt?: string;
  readonly guidance?: number;
  /** mflux `-q` weight quantization (3|4|5|6|8); omitted → full precision. */
  readonly quantize?: 3 | 4 | 5 | 6 | 8;
}

/**
 * Backend-resolved TTS parameters — the `mlx-audio` / `torch-tts` analogue of
 * {@link ImageJobSpec}. The app resolves a catalog entry into these concrete
 * fields; the worker stays catalog-free (important for a remote worker). These
 * are exactly what `worker.py`'s `build_audio_cmd` consumes.
 */
export interface AudioJobSpec {
  /** Text to synthesize. */
  readonly prompt: string;
  /** Catalog id — stamped as the output FOOTNOTE (e.g. `kokoro-82m`). */
  readonly modelId: string;
  /**
   * The RESOLVED HF repo id passed to mlx-audio `--model`. This is NOT always the
   * provenance repo: Kokoro's card is `hexgrad/Kokoro-82M` but mlx-audio loads
   * `prince-canuma/Kokoro-82M` — the catalog carries the resolved value.
   */
  readonly mlxAudioModel: string;
  /** `--voice` preset (e.g. `af_heart` / `Chelsie`). */
  readonly voice?: string;
  /** `--speed`. */
  readonly speed?: number;
  /** `--lang_code` (e.g. `a` = American English). */
  readonly lang?: string;
  /** `--steps` (model-specific diffusion steps). */
  readonly steps?: number;
  /** `--audio_format` (default `wav`). */
  readonly audioFormat?: string;
  /**
   * Reference audio clip for ZERO-SHOT VOICE CLONING (`--ref_audio`). Present
   * only for the models that expose a clone path (Qwen3-TTS, MOSS, Dia, Voxtral,
   * Chatterbox). Without it, synthesis uses a preset voice only — so this is the
   * field that makes every "3s zero-shot clone" claim real in-product.
   */
  readonly refAudio?: string;
  /**
   * Transcript of {@link refAudio} (`--ref_text`), when the clone model wants the
   * reference text alongside the reference clip. Only meaningful with `refAudio`.
   */
  readonly refText?: string;
  /**
   * One seed per candidate; the TTS CLI has no seed knob, so length drives the
   * candidate COUNT + the output stamp.
   */
  readonly seeds: readonly number[];
}

/**
 * Backend-resolved motion-graphics video parameters — the `hyperframes` analogue
 * of {@link ImageJobSpec}. The app resolves a catalog VIDEO entry + user params
 * into these concrete fields; the Node HyperFrames runner (ffmpeg + headless
 * Chrome) consumes them to author an HTML/CSS/JS scene and encode it to an MP4.
 *
 * This arm is ONLY the deterministic, CPU, non-diffusion path. Photoreal
 * text→video (LTX / Wan) instead resolves to a {@link ComfyJobSpec} and runs on
 * the persistent ComfyUI server — video NEVER goes through the uv worker (whose
 * `dispatch()` deliberately errors on video). Kept catalog-free (like
 * {@link ImageJobSpec}) so a remote runner needs no TS catalog.
 */
export interface VideoJobSpec {
  readonly prompt: string;
  /** Catalog id — stamped as the output FOOTNOTE (e.g. `hyperframes`). */
  readonly modelId: string;
  readonly width?: number;
  readonly height?: number;
  /** Clip duration in seconds. */
  readonly seconds?: number;
  /** Frames per second. */
  readonly fps?: number;
  readonly negativePrompt?: string;
  /**
   * One seed per candidate; length drives how many clips the job produces (the
   * motion-graphics runner is deterministic, so the seed also stamps the output).
   */
  readonly seeds: readonly number[];
}

/**
 * ComfyUI catalog wiring — analogous to {@link ../catalog!MfluxBackendConfig},
 * but for the persistent-server `comfyui` backend. A catalog entry names the
 * parameterized workflow-JSON `workflowTemplate` and a `paramMap` that binds each
 * standard catalog param name (`prompt` / `width` / `steps` / `seed` / …) to the
 * node-input path it splices into inside that template (e.g. `prompt` →
 * `"6.inputs.text"`). The app resolves an entry + user params into a
 * {@link ComfyJobSpec}; the ComfyUI adapter (a separate module) owns loading the
 * template and POSTing it. Forward-dated template ids / node paths are labelled
 * `[fwd]` in the catalog notes and finalised against the real graphs at build.
 */
export interface ComfyBackendConfig {
  readonly kind: 'comfyui';
  /** Id of the parameterized workflow-JSON template in the Phase-A registry. */
  readonly workflowTemplate: string;
  /** catalog param name → node-input path (e.g. `prompt` → `"6.inputs.text"`). */
  readonly paramMap: Record<string, string>;
}

/**
 * Backend-resolved ComfyUI parameters — the `comfyui`-backend analogue of
 * {@link ImageJobSpec}. The app resolves a catalog entry's
 * {@link ComfyBackendConfig} + user params into which workflow template to load
 * and the concrete input VALUES to splice into its nodes. The adapter maps each
 * `inputs` key → a node input via the entry's paramMap, POSTs the graph to
 * `/prompt`, and streams progress back as {@link GenEvent}s. Kept catalog-free
 * (like {@link ImageJobSpec}) so a remote ComfyUI needs no TS catalog.
 */
export interface ComfyJobSpec {
  readonly prompt: string;
  /** Catalog id — stamped as the output FOOTNOTE (e.g. `ltx-2`). */
  readonly modelId: string;
  /** Workflow-JSON template id to load (from the Phase-A template registry). */
  readonly workflowTemplate: string;
  /**
   * Resolved input VALUES keyed by catalog param name (prompt / width / steps /
   * length / seconds / seed / …). The adapter binds each key to a node input via
   * the entry's paramMap; values are the concrete scalars for this job.
   */
  readonly inputs: Record<string, string | number | boolean>;
  /** One seed per candidate; length drives how many outputs the job produces. */
  readonly seeds: readonly number[];
}

/**
 * One generation job. The modality-specific spec is a set of optional arms keyed
 * off `backend` — the `image`/`audio` arms drive the uv worker; the `comfy` arm
 * drives the persistent ComfyUI adapter (LTX/Wan video, music, advanced image);
 * the `video` arm drives the Node HyperFrames (ffmpeg) motion-graphics runner.
 * `GenEvent` is shared across all of them.
 */
export interface GenJob {
  readonly id: string;
  readonly modality: Modality;
  readonly backend: Backend;
  /** Absolute directory the worker writes final + preview artifacts into. */
  readonly outputDir: string;
  /** Image spec — the uv/mflux worker path (backend `mflux`). */
  readonly image?: ImageJobSpec;
  /** TTS spec — the uv/mlx-audio (or torch-tts) worker path. */
  readonly audio?: AudioJobSpec;
  /** ComfyUI spec — video / music / advanced-image graphs (backend `comfyui`). */
  readonly comfy?: ComfyJobSpec;
  /** Motion-graphics video spec — the Node HyperFrames (ffmpeg) runner (backend `hyperframes`). */
  readonly video?: VideoJobSpec;
}

/** A finished artifact a job produced. */
export interface GenOutput {
  readonly outputPath: string;
  readonly modality: Modality;
  /** The model that produced it — the FOOTNOTE the canvas stamps on every output. */
  readonly model: string;
  readonly seed?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * A lifecycle event streamed from the worker as one JSON object per line.
 *
 * Order for a successful image job:
 *   start → (download*) → progress* (+ candidate on each finished image) → done
 * Any point may instead terminate with `error`. `log` lines are advisory.
 */
export type GenEvent =
  | {
      readonly event: 'start';
      readonly jobId: string;
      readonly total: number;
      readonly candidates: number;
    }
  /** Model weights are being fetched (first run). `ratio` in [0,1] when known. */
  | {
      readonly event: 'download';
      readonly jobId: string;
      readonly ratio?: number;
      readonly detail?: string;
    }
  /** Denoising progress for the current candidate. `previewPath` is a step image when available. */
  | {
      readonly event: 'progress';
      readonly jobId: string;
      readonly candidate: number;
      readonly step: number;
      readonly total: number;
      readonly previewPath?: string;
    }
  /** One candidate finished and is on disk. */
  | {
      readonly event: 'candidate';
      readonly jobId: string;
      readonly index: number;
      readonly output: GenOutput;
    }
  /** Terminal success: every output on disk. */
  | { readonly event: 'done'; readonly jobId: string; readonly outputs: readonly GenOutput[] }
  /** Terminal failure. */
  | {
      readonly event: 'error';
      readonly jobId: string;
      readonly message: string;
      readonly recoverable?: boolean;
    }
  /** Advisory worker log line (stderr passthrough). */
  | { readonly event: 'log'; readonly jobId: string; readonly text: string };

/** The terminal event kinds. */
export type TerminalGenEvent = Extract<GenEvent, { event: 'done' | 'error' }>;

const GEN_EVENT_KINDS = new Set([
  'start',
  'download',
  'progress',
  'candidate',
  'done',
  'error',
  'log',
]);

/** Narrow an unknown parsed value to a {@link GenEvent}. */
export function isGenEvent(value: unknown): value is GenEvent {
  if (value === null || typeof value !== 'object') return false;
  const kind = (value as { event?: unknown }).event;
  return typeof kind === 'string' && GEN_EVENT_KINDS.has(kind);
}

/**
 * Parse one NDJSON line into a {@link GenEvent}, or `null` for blank lines,
 * non-JSON keep-alives, or JSON that is not a recognised event (so a worker that
 * interleaves stray stdout can never crash the reader — mirrors afm/stream.ts).
 */
export function parseGenEventLine(line: string): GenEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isGenEvent(parsed) ? parsed : null;
}

/**
 * Incremental newline-delimited JSON reader. Feed it stdout chunks; it buffers
 * partial lines and returns the {@link GenEvent}s completed by each chunk. Call
 * {@link flush} once the stream closes to drain a trailing unterminated line.
 */
export class NdjsonParser {
  #buffer = '';

  /** Feed a chunk; returns every complete, recognised event it produced. */
  push(chunk: string): GenEvent[] {
    this.#buffer += chunk;
    const events: GenEvent[] = [];
    let nl = this.#buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      const event = parseGenEventLine(line);
      if (event !== null) events.push(event);
      nl = this.#buffer.indexOf('\n');
    }
    return events;
  }

  /** Drain any trailing line the stream ended without a newline. */
  flush(): GenEvent[] {
    const rest = this.#buffer;
    this.#buffer = '';
    const event = parseGenEventLine(rest);
    return event !== null ? [event] : [];
  }
}
