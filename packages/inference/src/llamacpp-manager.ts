/**
 * llama.cpp binary manager: ensure a pinned release is downloaded, verified,
 * extracted, and its `llama-server` located; plus feature probing.
 *
 * Idempotent — a `.installed.json` marker records the resolved server path and
 * verified sha; a second call with the binary already present returns fast
 * without re-downloading. Electron-free (spawn/exec injected structurally so it
 * unit-tests in plain Node, mirroring pi-bridge).
 */
import { execFile as execFileCb, spawn as spawnCb } from 'node:child_process';
import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type DownloadProgress, downloadFile } from './download.js';
import {
  assetDownloadUrl,
  type LlamaCppRelease,
  PINNED_LLAMACPP,
  releaseApiUrl,
} from './llamacpp-manifest.js';
import { llamacppDir } from './paths.js';

const execFile = promisify(execFileCb);

/** Structural slice of the exec surface so tests inject a fake. */
export type ExecFileFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface EnsureLlamaCppOptions {
  /** Release to install; defaults to the pinned manifest. */
  readonly release?: LlamaCppRelease;
  /** Cache dir override (defaults to `~/.cache/pi-desktop/llamacpp/<tag>`). */
  readonly dir?: string;
  readonly onProgress?: (p: DownloadProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** Injectable extractor (tests). Default: `tar -xzf`. */
  readonly extract?: (archivePath: string, destDir: string) => Promise<void>;
  /** Injectable exec (tests). Default: node execFile. */
  readonly execFileImpl?: ExecFileFn;
  /**
   * When true, cross-check the pinned sha256 against GitHub's live asset digest
   * before downloading (belt-and-braces). Default false (offline-friendly).
   */
  readonly verifyDigestFromApi?: boolean;
}

export interface LlamaCppInstall {
  readonly tag: string;
  readonly dir: string;
  /** Absolute path to the `llama-server` executable. */
  readonly serverPath: string;
  /** Verified sha256 of the downloaded archive. */
  readonly archiveSha256: string;
}

interface InstallMarker {
  readonly tag: string;
  readonly serverPath: string;
  readonly archiveSha256: string;
}

const MARKER = '.installed.json';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
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

async function defaultExtract(archivePath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnCb('tar', ['-xzf', archivePath, '-C', destDir]);
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

async function resolveDigestFromApi(
  release: LlamaCppRelease,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ sha256?: string; size?: number }> {
  const res = await fetchImpl(releaseApiUrl(release), {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'pi-desktop' },
    signal,
  });
  if (!res.ok) return {};
  const body = (await res.json()) as {
    assets?: Array<{ name: string; size?: number; digest?: string | null }>;
  };
  const asset = body.assets?.find((a) => a.name === release.macosArm64.name);
  if (asset === undefined) return {};
  const digest = asset.digest ?? undefined;
  const sha256 =
    digest?.startsWith('sha256:') === true ? digest.slice('sha256:'.length) : undefined;
  return { sha256, size: asset.size };
}

/**
 * Ensure the pinned llama.cpp release is installed; return the resolved
 * `llama-server` path. Skips all work when already present + verified.
 */
export async function ensureLlamaCpp(opts: EnsureLlamaCppOptions = {}): Promise<LlamaCppInstall> {
  const release = opts.release ?? PINNED_LLAMACPP;
  const dir = opts.dir ?? llamacppDir(release.tag);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const extract = opts.extract ?? defaultExtract;

  // Fast path: honour the install marker if the server binary still exists.
  const markerPath = join(dir, MARKER);
  if (await pathExists(markerPath)) {
    try {
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstallMarker;
      if (await pathExists(marker.serverPath)) {
        return {
          tag: release.tag,
          dir,
          serverPath: marker.serverPath,
          archiveSha256: marker.archiveSha256,
        };
      }
    } catch {
      // Corrupt marker — fall through and reinstall.
    }
  }

  let expectedSha = release.macosArm64.sha256;
  if (opts.verifyDigestFromApi === true) {
    const live = await resolveDigestFromApi(release, fetchImpl, opts.signal);
    if (live.sha256 !== undefined && live.sha256 !== expectedSha) {
      throw new Error(
        `pinned sha256 for ${release.macosArm64.name} (${expectedSha}) does not match ` +
          `GitHub's live digest (${live.sha256}); refusing to install`,
      );
    }
    if (live.sha256 !== undefined) expectedSha = live.sha256;
  }

  const archivePath = join(dir, release.macosArm64.name);
  await downloadFile({
    url: assetDownloadUrl(release, release.macosArm64.name),
    dest: archivePath,
    expectedSha256: expectedSha,
    expectedBytes: release.macosArm64.sizeBytes,
    onProgress: opts.onProgress,
    signal: opts.signal,
    fetchImpl,
    headers: { 'user-agent': 'pi-desktop' },
  });

  await extract(archivePath, dir);

  const serverPath = await findExecutable(dir, 'llama-server');
  if (serverPath === undefined) {
    throw new Error(
      `llama-server not found under ${dir} after extracting ${release.macosArm64.name}`,
    );
  }
  await chmod(serverPath, 0o755).catch(() => {
    // Best-effort; tar usually preserves the mode already.
  });

  const marker: InstallMarker = { tag: release.tag, serverPath, archiveSha256: expectedSha };
  await writeFile(markerPath, JSON.stringify(marker, null, 2));

  return { tag: release.tag, dir, serverPath, archiveSha256: expectedSha };
}

export interface ServerFeatures {
  /** MTP speculative decoding via `--spec-type draft-mtp`. */
  readonly mtp: boolean;
  /** Vision projector support via `--mmproj`. */
  readonly mmproj: boolean;
  /** Multi-slot parallel decoding via `--parallel`. */
  readonly parallel: boolean;
  /** Draft-model speculative decoding via `--model-draft`/`-md`. */
  readonly draftModel: boolean;
}

/**
 * Probe a server binary's supported features by parsing `--help`.
 *
 * MTP is the load-bearing one: launch mode selection depends on whether this
 * build advertises `draft-mtp`. Runs the binary with a short timeout.
 */
export async function probeServerFeatures(
  serverPath: string,
  opts: { execFileImpl?: ExecFileFn } = {},
): Promise<ServerFeatures> {
  const exec = opts.execFileImpl ?? execFile;
  let help = '';
  try {
    const { stdout, stderr } = await exec(serverPath, ['--help'], {
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    help = `${stdout}\n${stderr}`;
  } catch (err) {
    // Some builds print help to stderr and exit non-zero; salvage the text.
    const e = err as { stdout?: string; stderr?: string };
    help = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    if (help.trim().length === 0) throw err;
  }
  return {
    mtp: help.includes('draft-mtp'),
    mmproj: help.includes('--mmproj'),
    parallel: help.includes('--parallel') || help.includes('-np'),
    draftModel: help.includes('--model-draft') || /(^|\s)-md(\s|,)/.test(help),
  };
}
