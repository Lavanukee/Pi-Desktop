/**
 * uv runtime bootstrap — self-contained in this package (W6 owns its Python
 * runtime independently of @pi-desktop/inference).
 *
 * Detects an existing `uv` on PATH first; otherwise downloads the pinned
 * standalone uv binary for macOS arm64 into `~/.cache/pi-desktop/uv/<version>/`
 * (streamed, sha256-verified when the checksum sibling is reachable), extracts
 * it, and records an `.installed.json` marker so subsequent runs skip all work.
 * Mirrors the inference package's binary-cache approach but shares nothing with
 * it. Provisioning an isolated Python is uv's job (see python.ts) — we never
 * touch system Python.
 *
 * spawn/extract are injectable so unit tests never require a real download.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { access, chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { type DownloadProgress, downloadFile } from './download.js';
import { uvDir } from './paths.js';

/** Pinned uv release. Bump deliberately; the checksum is verified when reachable. */
export interface UvRelease {
  readonly version: string;
  /** Release asset filename for macOS arm64. */
  readonly assetName: string;
  /** Executable name inside the extracted archive. */
  readonly binName: string;
}

export const PINNED_UV: UvRelease = {
  version: '0.11.28',
  assetName: 'uv-aarch64-apple-darwin.tar.gz',
  binName: 'uv',
};

function assetUrl(release: UvRelease): string {
  return `https://github.com/astral-sh/uv/releases/download/${release.version}/${release.assetName}`;
}

export interface EnsureUvOptions {
  readonly release?: UvRelease;
  /** Cache dir override (defaults to `~/.cache/pi-desktop/uv/<version>`). */
  readonly dir?: string;
  readonly onProgress?: (p: DownloadProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** Injectable extractor (tests). Default: `tar -xzf`. */
  readonly extract?: (archivePath: string, destDir: string) => Promise<void>;
  /** Skip the PATH probe (tests forcing the download path). */
  readonly ignorePath?: boolean;
  /** PATH string to scan when probing (tests). Default: process.env.PATH. */
  readonly pathEnv?: string;
}

export interface UvInstall {
  /** Absolute path (download) or bare `uv` (found on PATH) to invoke. */
  readonly uvPath: string;
  readonly source: 'path' | 'download';
  readonly version?: string;
}

interface InstallMarker {
  readonly version: string;
  readonly uvPath: string;
}

const MARKER = '.installed.json';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve an executable by scanning PATH (so we get an absolute path). */
async function resolveOnPath(
  name: string,
  pathEnv: string | undefined,
): Promise<string | undefined> {
  const raw = pathEnv ?? '';
  for (const dir of raw.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // not here; keep scanning
    }
  }
  return undefined;
}

async function defaultExtract(archivePath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn('tar', ['-xzf', archivePath, '-C', destDir]);
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr}`)),
    );
  });
}

/** Recursively locate an executable by name within a directory tree. */
async function findExecutable(root: string, name: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return undefined;
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findExecutable(full, name);
      if (found !== undefined) return found;
    } else if (entry.isFile() && entry.name === name) {
      return full;
    }
  }
  return undefined;
}

/** Best-effort fetch of the `<asset>.sha256` sibling → lowercase hex digest. */
async function fetchChecksum(
  release: UvRelease,
  doFetch: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const res = await doFetch(`${assetUrl(release)}.sha256`, { signal });
    if (!res.ok) return undefined;
    const text = await res.text();
    const token = text.trim().split(/\s+/)[0];
    return token !== undefined && /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensure uv is available; return how to invoke it. Prefers an existing PATH
 * install, else downloads + verifies the pinned binary into the cache. Skips all
 * work when the cache marker + binary are already present.
 */
export async function ensureUv(opts: EnsureUvOptions = {}): Promise<UvInstall> {
  const release = opts.release ?? PINNED_UV;

  if (opts.ignorePath !== true) {
    const onPath = await resolveOnPath(release.binName, opts.pathEnv ?? process.env.PATH);
    if (onPath !== undefined) return { uvPath: onPath, source: 'path' };
  }

  const dir = opts.dir ?? uvDir(release.version);
  const doFetch = opts.fetchImpl ?? fetch;
  const extract = opts.extract ?? defaultExtract;

  // Fast path: honour the install marker if the binary still exists.
  const markerPath = join(dir, MARKER);
  if (await pathExists(markerPath)) {
    try {
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstallMarker;
      if (await pathExists(marker.uvPath)) {
        return { uvPath: marker.uvPath, source: 'download', version: release.version };
      }
    } catch {
      // Corrupt marker — fall through and reinstall.
    }
  }

  await mkdir(dir, { recursive: true });
  const archivePath = join(dir, release.assetName);
  const expectedSha256 = await fetchChecksum(release, doFetch, opts.signal);

  await downloadFile({
    url: assetUrl(release),
    dest: archivePath,
    expectedSha256,
    onProgress: opts.onProgress,
    signal: opts.signal,
    fetchImpl: doFetch,
    headers: { 'user-agent': 'pi-desktop-web-tools' },
  });

  await extract(archivePath, dir);

  const uvPath = await findExecutable(dir, release.binName);
  if (uvPath === undefined) {
    throw new Error(
      `${release.binName} not found under ${dir} after extracting ${release.assetName}`,
    );
  }
  await chmod(uvPath, 0o755).catch(() => {});

  const marker: InstallMarker = { version: release.version, uvPath };
  await writeFile(markerPath, JSON.stringify(marker, null, 2));

  return { uvPath, source: 'download', version: release.version };
}
