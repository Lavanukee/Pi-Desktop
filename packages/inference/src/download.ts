/**
 * Streamed, resumable, sha256-verified file downloader with progress.
 *
 * Shared by the llama.cpp binary manager and the GGUF model downloader — both
 * pull large files (10MB…30GB) over HTTP from GitHub releases / HuggingFace
 * `resolve` URLs, which honour `Range` (accept-ranges: bytes), so an
 * interrupted transfer resumes from a `.part` sidecar instead of restarting.
 *
 * Design notes:
 * - The sha256 is computed over the *whole* file. On resume we re-hash the
 *   bytes already on disk before appending, so the digest stays correct.
 * - Idempotent: if the destination already exists and matches the expected
 *   sha256 (or expected size when no sha is known), we return immediately.
 * - `fetchImpl` is injectable so unit tests drive a local fixture server (and
 *   can simulate a mid-stream disconnect) without touching the network.
 * - Never imports electron; runs in plain Node.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DownloadProgress {
  /** Source URL. */
  readonly url: string;
  /** Final destination path. */
  readonly dest: string;
  /** Bytes written so far (including any resumed prefix). */
  readonly received: number;
  /** Total expected bytes, or undefined if the server sent no length. */
  readonly total: number | undefined;
  /** received/total in [0,1], or undefined when total is unknown. */
  readonly fraction: number | undefined;
}

export interface DownloadOptions {
  readonly url: string;
  /** Absolute destination path; parent dirs are created. */
  readonly dest: string;
  /** Lowercase hex sha256 to verify against (recommended). */
  readonly expectedSha256?: string;
  /** Expected total size in bytes; used for the idempotency check when no sha. */
  readonly expectedBytes?: number;
  readonly onProgress?: (p: DownloadProgress) => void;
  readonly signal?: AbortSignal;
  /** Injectable fetch (tests / proxies). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Extra request headers (e.g. HF auth — not needed for public repos). */
  readonly headers?: Record<string, string>;
  /** Progress emit throttle in ms (default 250). */
  readonly progressIntervalMs?: number;
}

export interface DownloadResult {
  readonly dest: string;
  readonly sha256: string;
  readonly bytes: number;
  /** True when the existing file already satisfied the request (no transfer). */
  readonly cached: boolean;
  /** True when at least some bytes were resumed from a prior `.part`. */
  readonly resumed: boolean;
}

export class DownloadError extends Error {
  override readonly name: string = 'DownloadError';
}
export class ChecksumMismatchError extends DownloadError {
  override readonly name: string = 'ChecksumMismatchError';
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
}

/** Hash an existing file's contents into a running hash, streaming. */
async function hashExisting(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve());
    rs.on('error', reject);
  });
}

async function computeSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await hashExisting(path, hash);
  return hash.digest('hex');
}

/**
 * Download `url` to `dest`, resuming and verifying. Returns the verified sha256
 * and byte count. Throws {@link DownloadError} / {@link ChecksumMismatchError}
 * on failure (these are expected, recoverable conditions the caller reports).
 */
export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const {
    url,
    dest,
    expectedSha256,
    expectedBytes,
    onProgress,
    signal,
    headers,
    progressIntervalMs = 250,
  } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const partPath = `${dest}.part`;

  await mkdir(dirname(dest), { recursive: true });

  // --- Idempotency: already-complete destination -------------------------
  const existingSize = await fileSize(dest);
  if (existingSize !== undefined) {
    if (expectedSha256 !== undefined) {
      const actual = await computeSha256(dest);
      if (actual === expectedSha256) {
        return { dest, sha256: actual, bytes: existingSize, cached: true, resumed: false };
      }
      // Wrong content — fall through and re-download from scratch.
    } else if (expectedBytes === undefined || existingSize === expectedBytes) {
      const actual = await computeSha256(dest);
      return { dest, sha256: actual, bytes: existingSize, cached: true, resumed: false };
    }
  }

  // --- Resume setup ------------------------------------------------------
  let resumeFrom = (await fileSize(partPath)) ?? 0;
  const hash = createHash('sha256');
  let resumed = false;

  const reqHeaders: Record<string, string> = { ...headers };
  if (resumeFrom > 0) reqHeaders.Range = `bytes=${resumeFrom}-`;

  const res = await doFetch(url, { headers: reqHeaders, signal });
  if (!res.ok && res.status !== 206) {
    throw new DownloadError(`GET ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  if (res.body === null) {
    throw new DownloadError(`GET ${url} returned no body`);
  }

  // Server may ignore Range and send 200 (full file) — restart cleanly.
  const serverHonoredRange = res.status === 206;
  if (resumeFrom > 0 && serverHonoredRange) {
    await hashExisting(partPath, hash);
    resumed = true;
  } else {
    resumeFrom = 0; // 200 → we receive the whole file; overwrite the .part.
  }

  // Total = prefix already hashed + what this response carries.
  const contentLength = Number(res.headers.get('content-length') ?? '');
  const total =
    Number.isFinite(contentLength) && contentLength > 0
      ? resumeFrom + contentLength
      : expectedBytes;

  let received = resumeFrom;
  let lastEmit = 0;
  const emit = (force: boolean): void => {
    if (onProgress === undefined) return;
    const now = Date.now();
    if (!force && now - lastEmit < progressIntervalMs) return;
    lastEmit = now;
    onProgress({
      url,
      dest,
      received,
      total,
      fraction: total !== undefined && total > 0 ? received / total : undefined,
    });
  };
  emit(true);

  const out = createWriteStream(partPath, { flags: resumeFrom > 0 ? 'a' : 'w' });
  try {
    // res.body is a WHATWG ReadableStream; iterate it directly. A mid-stream
    // disconnect throws here, leaving the flushed prefix in `.part` to resume.
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal?.aborted === true) throw new DownloadError('aborted');
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      received += buf.length;
      emit(false);
      if (!out.write(buf)) await once(out, 'drain');
    }
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      out.end(() => resolve());
    });
  } catch (err) {
    out.destroy();
    throw err;
  }
  emit(true);

  const sha256 = hash.digest('hex');
  const bytes = received;

  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw new ChecksumMismatchError(expectedSha256, sha256);
  }
  if (expectedSha256 === undefined && expectedBytes !== undefined && bytes !== expectedBytes) {
    throw new DownloadError(`size mismatch: expected ${expectedBytes} bytes, got ${bytes}`);
  }

  await rename(partPath, dest);
  return { dest, sha256, bytes, cached: false, resumed };
}
