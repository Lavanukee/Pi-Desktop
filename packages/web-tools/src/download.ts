/**
 * Minimal streamed, sha256-verified file downloader.
 *
 * A deliberately small, self-contained mirror of @pi-desktop/inference's
 * downloader (this package must not depend on inference). The uv binary is
 * ~22MB, so this skips the resume/`.part` machinery inference needs for
 * multi-GB GGUFs and just streams to a temp file, hashes, verifies, and renames.
 *
 * `fetchImpl` is injectable so unit tests drive a fixture without the network.
 * Never imports electron; runs in plain Node.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DownloadProgress {
  readonly received: number;
  readonly total: number | undefined;
  readonly fraction: number | undefined;
}

export interface DownloadOptions {
  readonly url: string;
  /** Absolute destination path; parent dirs are created. */
  readonly dest: string;
  /** Lowercase hex sha256 to verify against, when a checksum is available. */
  readonly expectedSha256?: string;
  readonly onProgress?: (p: DownloadProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly headers?: Record<string, string>;
}

export interface DownloadResult {
  readonly dest: string;
  readonly sha256: string;
  readonly bytes: number;
  /** True when a matching file already existed (no transfer). */
  readonly cached: boolean;
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

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Download `url` to `dest`, streaming and verifying. Idempotent when a checksum matches. */
export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const { url, dest, expectedSha256, onProgress, signal, headers } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  await mkdir(dirname(dest), { recursive: true });

  // Idempotency: a present file with the expected sha (or no known sha) is reused.
  if (await fileExists(dest)) {
    if (expectedSha256 === undefined) {
      const s = await stat(dest);
      return { dest, sha256: '', bytes: s.size, cached: true };
    }
    const actual = await hashFile(dest);
    if (actual === expectedSha256) {
      const s = await stat(dest);
      return { dest, sha256: actual, bytes: s.size, cached: true };
    }
    // Wrong content — fall through and re-download.
  }

  const res = await doFetch(url, { headers: { ...headers }, signal });
  if (!res.ok) throw new DownloadError(`GET ${url} failed: HTTP ${res.status} ${res.statusText}`);
  if (res.body === null) throw new DownloadError(`GET ${url} returned no body`);

  const total = toNumber(res.headers.get('content-length'));
  const partPath = `${dest}.part`;
  const hash = createHash('sha256');
  let received = 0;

  const out = createWriteStream(partPath, { flags: 'w' });
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal?.aborted === true) throw new DownloadError('aborted');
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      received += buf.length;
      onProgress?.({
        received,
        total,
        fraction: total !== undefined && total > 0 ? received / total : undefined,
      });
      if (!out.write(buf)) await once(out, 'drain');
    }
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      out.end(() => resolve());
    });
  } catch (err) {
    out.destroy();
    await rm(partPath, { force: true }).catch(() => {});
    throw err;
  }

  const sha256 = hash.digest('hex');
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    await rm(partPath, { force: true }).catch(() => {});
    throw new ChecksumMismatchError(expectedSha256, sha256);
  }

  await rename(partPath, dest);
  return { dest, sha256, bytes: received, cached: false };
}

async function hashFile(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on('data', (c) => hash.update(c));
    rs.on('end', () => resolve());
    rs.on('error', reject);
  });
  return hash.digest('hex');
}

function toNumber(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
