/**
 * gen3d main-process handlers — the REAL engine implementation behind the
 * contract: a uv/Python sidecar (packages/gen3d-engine) owns downloads, disk
 * truth and worker subprocesses (TRELLIS.2-on-MPS, Mage-Flow, CubePart,
 * Hunyuan Paint, AutoRemesher); this file supervises it lazily and translates
 * its NDJSON event stream into `gen3d:*` broadcasts.
 *
 * Honesty rules preserved from the stub: before the sidecar is up (or if uv /
 * the spawn fails) the catalog reports `engineReady:false` with real sizes and
 * a cheap TS-side installed probe (stamp files), and every action returns a
 * clear error instead of pretending.
 *
 * Artifacts land under ~/.pi/desktop/sandbox/gen3d/<jobId>/ — inside the
 * pd-file fence — while model weights live in ~/.cache/pi-desktop/gen3d/.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  consumeNdjsonStream,
  detectInstalled,
  engineCacheDir,
  GEN3D_MODEL_SPECS,
  Gen3dSidecar,
  type Gen3dStage,
  gen3dSandboxDir,
  type JobUpdate,
  mapJobEvent,
  pickFreePort,
  planGenerate,
  planStageOp,
  resolveUv,
  type SidecarJobEvent,
  type StagePlan,
  specTotalBytes,
  TRELLIS_RESOLUTIONS,
  toSidecarRegistry,
} from '@pi-desktop/gen3d-engine';
import {
  createIpcEventSender,
  createLogger,
  type IpcHandlers,
  registerIpcHandlers,
} from '@pi-desktop/shared';
import { app, BrowserWindow, type IpcMain, type WebContents } from 'electron';
import type { AppEventMap } from '../ipc-contract';
import type { Gen3dInvokeMap, Gen3dModelId, Gen3dModelInfo } from './gen3d-contract';

const log = createLogger('desktop:gen3d');
const events = createIpcEventSender<AppEventMap>();

function broadcast<K extends keyof AppEventMap & string>(
  channel: K,
  payload: AppEventMap[K],
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) events.send(win.webContents, channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle (lazy: first catalog/download/generate boots it).
// ---------------------------------------------------------------------------

let sidecar: Gen3dSidecar | null = null;
let sidecarStarting: Promise<Gen3dSidecar | null> | null = null;
const eventsAbort = new AbortController();
/** jobId → stage plan captured when the job started (weights for percent math). */
const jobPlans = new Map<string, readonly StagePlan[]>();
/** Model ids with a download in flight (mirrored from sidecar events for the
 * catalog's `downloading` flag when composed TS-side). */
const downloading = new Set<string>();

/** Where python/server.py lives: packages/gen3d-engine/python (source tree in
 * dev; override with GEN3D_PY_DIR for packaged builds — see report). */
function sidecarScriptPath(): string {
  const override = process.env.GEN3D_PY_DIR;
  if (override !== undefined && override.length > 0) return path.join(override, 'server.py');
  return path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'gen3d-engine',
    'python',
    'server.py',
  );
}

async function ensureSidecar(): Promise<Gen3dSidecar | null> {
  if (sidecar !== null) return sidecar;
  if (sidecarStarting !== null) return sidecarStarting;
  sidecarStarting = startSidecar().catch((err) => {
    log.warn('gen3d sidecar failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    sidecarStarting = null;
    return null;
  });
  return sidecarStarting;
}

async function startSidecar(): Promise<Gen3dSidecar | null> {
  const serverScript = sidecarScriptPath();
  if (!existsSync(serverScript)) {
    log.warn('gen3d sidecar script missing', { serverScript });
    return null;
  }
  const uvPath = await resolveUv({ pathEnv: process.env.PATH, home: app.getPath('home') });
  if (uvPath === undefined) {
    log.warn('gen3d: uv not found — engine unavailable until uv is installed');
    return null;
  }
  const cacheDir = engineCacheDir(app.getPath('home'));
  const sandboxDir = gen3dSandboxDir(app.getPath('home'));
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });
  const registryPath = path.join(cacheDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify(toSidecarRegistry(), null, 2));

  const port = await pickFreePort();
  const instance = new Gen3dSidecar({
    uvPath,
    serverScript,
    cacheDir,
    sandboxDir,
    registryPath,
    port,
    log: (msg, meta) => log.info(msg, meta),
    onDown: () => {
      if (sidecar === instance) sidecar = null;
      sidecarStarting = null;
      broadcast('gen3d:catalog-changed', { at: Date.now() });
    },
  });
  await instance.ensureStarted();
  sidecar = instance;
  wireEventStream(instance);
  log.info('gen3d sidecar up', { baseUrl: instance.baseUrl });
  broadcast('gen3d:catalog-changed', { at: Date.now() });
  return instance;
}

/** URLs already being consumed — a crashed sidecar restarts on the SAME port,
 * and its old reconnecting stream loop would otherwise be joined by a second
 * one (double events) when the supervisor re-wires. */
const wiredEventUrls = new Set<string>();

function wireEventStream(instance: Gen3dSidecar): void {
  const url = `${instance.baseUrl}/events`;
  if (wiredEventUrls.has(url)) return;
  wiredEventUrls.add(url);
  void consumeNdjsonStream({
    url,
    signal: eventsAbort.signal,
    onValue: (value) => handleSidecarEvent(value),
  }).finally(() => wiredEventUrls.delete(url));
}

function handleSidecarEvent(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const event = value as Record<string, unknown>;
  if (event.type === 'download') {
    const id = String(event.id) as Gen3dModelId;
    const done = event.done === true;
    if (done) downloading.delete(id);
    else downloading.add(id);
    broadcast('gen3d:download', {
      id,
      receivedBytes: Number(event.receivedBytes ?? 0),
      totalBytes: Number(event.totalBytes ?? 0),
      done,
      ...(typeof event.error === 'string' ? { error: event.error } : {}),
    });
    return;
  }
  if (event.type === 'job') {
    const jobId = String(event.jobId);
    const plan = jobPlans.get(jobId) ?? planGenerate('image', true);
    const update: JobUpdate = mapJobEvent(plan, event as unknown as SidecarJobEvent);
    if (update.done) jobPlans.delete(jobId);
    broadcast('gen3d:job', {
      jobId: update.jobId,
      stage: update.stage,
      message: update.message,
      stagePercent: update.stagePercent,
      overallPercent: update.overallPercent,
      ...(update.artifact !== undefined ? { artifact: update.artifact } : {}),
      done: update.done,
      ...(update.error !== undefined ? { error: update.error } : {}),
    });
    return;
  }
  if (event.type === 'catalog-changed') {
    broadcast('gen3d:catalog-changed', { at: Number(event.at ?? Date.now()) });
  }
}

async function sidecarPost<T>(route: string, body: unknown): Promise<T | null> {
  const instance = await ensureSidecar();
  if (instance === null) return null;
  try {
    const res = await fetch(`${instance.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    log.warn('gen3d sidecar request failed', {
      route,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Catalog composition — TS labels/sizes/notes + sidecar (or stamp-file) truth.
// ---------------------------------------------------------------------------

function composeModels(
  installed: Record<string, boolean>,
  inFlight: ReadonlySet<string>,
): Gen3dModelInfo[] {
  return GEN3D_MODEL_SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    role: spec.role,
    sizeBytes: specTotalBytes(spec),
    installed: installed[spec.id] === true,
    downloading: inFlight.has(spec.id),
    note: spec.note,
  }));
}

const ENGINE_DOWN =
  'The 3D engine runtime is not available (uv/Python sidecar failed to start). Install uv and retry.';

const handlers: IpcHandlers<Gen3dInvokeMap> = {
  'gen3d:catalog': async () => {
    const instance = await ensureSidecar();
    if (instance !== null) {
      try {
        const res = await fetch(`${instance.baseUrl}/catalog`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          const body = (await res.json()) as {
            models: { id: string; installed: boolean; downloading: boolean }[];
          };
          const installed: Record<string, boolean> = {};
          const inFlight = new Set<string>();
          for (const m of body.models) {
            installed[m.id] = m.installed;
            if (m.downloading) inFlight.add(m.id);
          }
          return {
            engineReady: true,
            models: composeModels(installed, inFlight),
            resolutions: TRELLIS_RESOLUTIONS,
          };
        }
      } catch (err) {
        log.warn('gen3d catalog fetch failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Sidecar down: honest degraded catalog from stamp files.
    const installed = detectInstalled(existsSync, engineCacheDir(app.getPath('home')));
    return {
      engineReady: false,
      models: composeModels(installed, downloading),
      resolutions: TRELLIS_RESOLUTIONS,
    };
  },
  'gen3d:download': async (req) => {
    const res = await sidecarPost<{ ok: boolean; error?: string }>('/download', { ids: req.ids });
    if (res === null) return { ok: false, error: ENGINE_DOWN };
    return res;
  },
  'gen3d:cancel-download': async (req) => {
    const res = await sidecarPost<{ ok: boolean }>('/cancel-download', { id: req.id });
    return res ?? { ok: false };
  },
  'gen3d:generate': async (req) => {
    const res = await sidecarPost<{ ok: boolean; jobId?: string; error?: string }>(
      '/generate',
      req,
    );
    if (res === null) return { ok: false, error: ENGINE_DOWN };
    if (res.ok && res.jobId !== undefined) {
      jobPlans.set(res.jobId, planGenerate(req.kind, req.texture));
    }
    return res;
  },
  'gen3d:stage': async (req) => {
    const res = await sidecarPost<{ ok: boolean; jobId?: string; error?: string }>('/stage', req);
    if (res === null) return { ok: false, error: ENGINE_DOWN };
    if (res.ok && res.jobId !== undefined) {
      jobPlans.set(res.jobId, planStageOp(req.op));
    }
    return res;
  },
  'gen3d:cancel': async (req) => {
    const res = await sidecarPost<{ ok: boolean }>('/cancel', { jobId: req.jobId });
    return res ?? { ok: false };
  },
};

export function registerGen3dIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
  _getWebContents: () => WebContents | null,
): void {
  registerIpcHandlers<Gen3dInvokeMap>(ipcMain, handlers, { allowSender });
  app.on('before-quit', () => {
    eventsAbort.abort();
    sidecar?.dispose();
  });
}

/** Re-exported so tests can assert the stage union stays in sync. */
export type { Gen3dStage };
