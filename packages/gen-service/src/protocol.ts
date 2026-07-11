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

/** The concrete backend that fulfils a job (phase 1 = mflux/MLX for image). */
export type Backend = 'mflux' | 'mlx-audio' | 'triposr' | 'trellis' | 'hyperframes';

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
 * One generation job. `spec` is a discriminated union keyed by `modality`; phase
 * 1 only defines the `image` arm, but the shape is ready for audio/video/3d.
 */
export interface GenJob {
  readonly id: string;
  readonly modality: Modality;
  readonly backend: Backend;
  /** Absolute directory the worker writes final + preview artifacts into. */
  readonly outputDir: string;
  /** Modality-specific spec. Image in phase 1. */
  readonly image?: ImageJobSpec;
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
