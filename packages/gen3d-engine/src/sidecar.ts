/**
 * The gen3d sidecar supervisor — spawns the uv-provisioned Python server
 * (python/server.py, stdlib http + pinned huggingface_hub) and owns its
 * lifecycle: health probing, crash restart with backoff, disposal. Mirrors
 * the mlx-manager/LlamaServerSupervisor pattern but is self-contained so this
 * package has no dependency on packages/inference.
 *
 * All process/network IO is injectable for tests; arg assembly is pure.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as net from 'node:net';
import { delimiter, join } from 'node:path';

/** Pinned sidecar deps (uv `--with`). huggingface_hub is the only runtime dep
 * of server.py itself — workers run in their own provisioned venvs. */
export const SIDECAR_HF_HUB_PIN = '0.34.4';
export const SIDECAR_PYTHON = '3.12';

export interface SidecarArgsConfig {
  /** Absolute path to python/server.py. */
  readonly serverScript: string;
  readonly port: number;
  /** Engine cache root (weights/venvs/stamps). */
  readonly cacheDir: string;
  /** Job-artifact root (inside the renderer-readable sandbox fence). */
  readonly sandboxDir: string;
  /** Registry JSON path (written from catalog.toSidecarRegistry()). */
  readonly registryPath: string;
  readonly hfHubPin?: string;
  readonly python?: string;
}

/** Build the uv argv for the sidecar. Pure. */
export function assembleSidecarArgs(cfg: SidecarArgsConfig): string[] {
  return [
    'run',
    '--no-project',
    '--python',
    cfg.python ?? SIDECAR_PYTHON,
    '--with',
    `huggingface_hub==${cfg.hfHubPin ?? SIDECAR_HF_HUB_PIN}`,
    cfg.serverScript,
    '--port',
    String(cfg.port),
    '--cache-dir',
    cfg.cacheDir,
    '--sandbox-dir',
    cfg.sandboxDir,
    '--registry',
    cfg.registryPath,
  ];
}

/**
 * Resolve the uv binary: PATH first, then the app's own provisioned copy at
 * ~/.cache/pi-desktop/uv/uv (how the rest of the app bootstraps Python), then
 * ~/.local/bin/uv (the standard installer location).
 */
export async function resolveUv(opts: {
  readonly pathEnv?: string;
  readonly home?: string;
  readonly statFn?: (p: string) => Promise<{ isFile(): boolean }>;
}): Promise<string | undefined> {
  const statFn = opts.statFn ?? stat;
  const candidates: string[] = [];
  for (const dir of (opts.pathEnv ?? '').split(delimiter)) {
    if (dir.length > 0) candidates.push(join(dir, 'uv'));
  }
  if (opts.home !== undefined && opts.home.length > 0) {
    candidates.push(join(opts.home, '.cache', 'pi-desktop', 'uv', 'uv'));
    candidates.push(join(opts.home, '.local', 'bin', 'uv'));
  }
  for (const candidate of candidates) {
    try {
      const s = await statFn(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

/** Pick a free localhost port (the sidecar binds it before health passes). */
export async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface Gen3dSidecarOptions {
  readonly uvPath: string;
  readonly serverScript: string;
  readonly cacheDir: string;
  readonly sandboxDir: string;
  readonly registryPath: string;
  readonly port: number;
  /** Extra env (HF_HOME is set automatically to <cacheDir>/hf). */
  readonly env?: Record<string, string>;
  readonly healthTimeoutMs?: number;
  readonly maxRestarts?: number;
  readonly spawnFn?: typeof spawn;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Called when the sidecar exits and no restart is attempted. */
  readonly onDown?: () => void;
}

/** Supervises one sidecar process. `ensureStarted` is idempotent. */
export class Gen3dSidecar {
  readonly baseUrl: string;
  private child: ChildProcess | null = null;
  private disposed = false;
  private restarts = 0;
  private starting: Promise<void> | null = null;
  private readonly opts: Gen3dSidecarOptions;

  constructor(opts: Gen3dSidecarOptions) {
    this.opts = opts;
    this.baseUrl = `http://127.0.0.1:${opts.port}`;
  }

  async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error('gen3d sidecar disposed');
    if (this.starting !== null) return this.starting;
    this.starting = this.startOnce().catch((err) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  private async startOnce(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? spawn;
    const log = this.opts.log ?? (() => {});
    const args = assembleSidecarArgs({
      serverScript: this.opts.serverScript,
      port: this.opts.port,
      cacheDir: this.opts.cacheDir,
      sandboxDir: this.opts.sandboxDir,
      registryPath: this.opts.registryPath,
    });
    const child = spawnFn(this.opts.uvPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HF_HOME: join(this.opts.cacheDir, 'hf'),
        ...this.opts.env,
      },
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => log('sidecar', { out: d.toString().trimEnd() }));
    child.stderr?.on('data', (d: Buffer) => log('sidecar', { err: d.toString().trimEnd() }));
    child.on('exit', (code) => {
      log('sidecar exited', { code });
      this.child = null;
      this.starting = null;
      if (this.disposed) return;
      if (this.restarts < (this.opts.maxRestarts ?? 3)) {
        const backoffMs = [1_000, 5_000, 15_000][this.restarts] ?? 15_000;
        this.restarts += 1;
        setTimeout(() => {
          if (!this.disposed) void this.ensureStarted().catch(() => this.opts.onDown?.());
        }, backoffMs);
      } else {
        this.opts.onDown?.();
      }
    });

    await this.waitHealthy();
    this.restarts = 0;
  }

  private async waitHealthy(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const deadline = Date.now() + (this.opts.healthTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('gen3d sidecar disposed');
      try {
        const res = await fetchImpl(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('gen3d sidecar failed health check');
  }

  dispose(): void {
    this.disposed = true;
    const child = this.child;
    if (child === null) return;
    this.child = null;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3_000);
    killTimer.unref?.();
  }
}
