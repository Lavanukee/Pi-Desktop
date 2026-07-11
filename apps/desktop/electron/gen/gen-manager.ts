/**
 * Generation manager — the Electron-main glue that turns a pi `generate_image`
 * request into a running mflux/MLX job and a live canvas surface.
 *
 * It stands up a token-authed line-delimited JSON-RPC server on a Unix-domain
 * socket (@pi-desktop/gen-tools/contract), publishes the socket path + token on
 * the env BEFORE the first pi spawn (mirroring browser-agent.ts), owns the
 * unified-memory-aware {@link JobQueue}, resolves the catalog model into a
 * {@link GenJob}, and streams each job's progress to the renderer as
 * `gen:open` / `gen:update` events (candidate previews + step progress).
 *
 * ── One-line app wire-ups this module needs (NOT done here, to keep round-12
 *    files untouched) ─────────────────────────────────────────────────────────
 *   1. apps/desktop/package.json deps: add `@pi-desktop/gen-service`,
 *      `@pi-desktop/gen-tools` (+ renderer `@pi-desktop/gen-canvas`).
 *   2. apps/desktop/electron/pi/pi-main.ts: add `'gen-tools'` to
 *      EXTENSION_PACKAGE_DIRS so the `generate_image` tool loads via `-e`.
 *   3. apps/desktop/electron/ipc-contract.ts: spread `GenEventMap` into
 *      AppEventMap and `GenInvokeMap` into AppInvokeMap (from ./gen/gen-ipc-contract).
 *   4. apps/desktop/electron/main.ts: call `registerGenIpc({...})` on app-ready
 *      BEFORE the first pi spawn (like registerBrowserAgentIpc), passing a
 *      `createIpcEventSender<AppEventMap>()` send fn + `isTrustedIpcEvent`.
 *   5. Renderer: a `useGen()` hook (mirroring useBrowserAgent) that, on `gen:open`,
 *      `controller.upsertTab(tabId, { kind:'gen-image', ... })` and on `gen:update`
 *      updates that tab's artifact via `genImageContent(payload)`; register the
 *      surface once with `registerGenImageSurface()`.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  activeModels,
  defaultImageModel,
  type GenEvent,
  type GenJob,
  GenServiceClient,
  getModel,
  JobQueue,
  MODALITY_CATALOG,
  type ModalityModel,
} from '@pi-desktop/gen-service';
import {
  GEN_SOCK_ENV,
  GEN_TOKEN_ENV,
  type GenBridgeRequest,
  type GenBridgeResponse,
  type GenerateImageParams,
  type GenerateImageResult,
  type GenModelSummary,
} from '@pi-desktop/gen-tools/contract';
import { createLogger, registerIpcHandlers } from '@pi-desktop/shared';
import { type IpcMain, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { toModalityCatalogEntry } from './gen-catalog-dto';
import type { GenCatalogInvokeMap, GenEventMap, GenSurfacePayload } from './gen-ipc-contract';

const log = createLogger('desktop:gen');

export interface GenManagerOptions {
  /** Yields the app window to stream surface updates to. */
  readonly getWindow: () => WebContents | null;
  /** Typed main→renderer sender (app wires `createIpcEventSender<AppEventMap>()`). */
  readonly sendEvent: <K extends keyof GenEventMap>(
    wc: WebContents,
    channel: K,
    payload: GenEventMap[K],
  ) => void;
  /** Guard renderer→main invokes (app passes `isTrustedIpcEvent`). Default: allow. */
  readonly isTrusted?: (event: IpcMainInvokeEvent) => boolean;
  /** Injectable uv resolver (app passes web-tools `ensureUv`). Default: PATH probe. */
  readonly resolveUv?: () => Promise<string>;
  /** Root dir for generated outputs. Default `<tmp>/pi-generated`. */
  readonly outputRoot?: string;
  /** Max concurrent LIGHT jobs (default 2). Heavy models always run alone. */
  readonly maxConcurrent?: number;
}

let server: net.Server | null = null;
let token = '';

function defaultSocketPath(): string {
  return path.join(tmpdir(), `pi-gen-${process.pid}-${randomBytes(4).toString('hex')}.sock`);
}

function summariseModel(m: ModalityModel): GenModelSummary {
  return {
    id: m.id,
    modality: m.modality,
    label: m.label,
    license: m.license,
    commercialUse: m.commercialUse,
    runsLocally: m.runsLocally,
    reserved: m.reserved === true,
  };
}

/** Parse `<w>x<h>` into even, bounded dims (default 1024²). Mirrors gen-tools. */
function parseSize(size: string | undefined): { width: number; height: number } {
  const fallback = { width: 1024, height: 1024 };
  if (size === undefined) return fallback;
  const m = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i.exec(size.trim());
  if (m === null) return fallback;
  const clamp = (n: number): number => Math.max(256, Math.min(1536, Math.round(n / 16) * 16));
  return { width: clamp(Number(m[1])), height: clamp(Number(m[2])) };
}

/** A file path → a loadable src. NOTE: if the renderer's CSP blocks file://, the
 * app should serve these via its media protocol instead (one-line swap here). */
function toSrc(p: string): string {
  return pathToFileURL(p).href;
}

export function registerGenIpc(opts: GenManagerOptions): void {
  const outputRoot = opts.outputRoot ?? path.join(tmpdir(), 'pi-generated');
  const client = new GenServiceClient({ resolveUv: opts.resolveUv });
  const jobQueue = new JobQueue({
    maxConcurrent: opts.maxConcurrent ?? 2,
    runner: (job, o) => client.run(job, o),
  });

  const send = <K extends keyof GenEventMap>(channel: K, payload: GenEventMap[K]): void => {
    const wc = opts.getWindow();
    if (wc !== null && !wc.isDestroyed()) opts.sendEvent(wc, channel, payload);
  };

  async function handleGenerate(raw: GenerateImageParams): Promise<GenerateImageResult> {
    const model = getModel(raw.model ?? defaultImageModel().id);
    if (model === undefined || model.modality !== 'image' || model.mflux === undefined) {
      throw new Error(`unknown or non-image model "${raw.model ?? ''}"`);
    }
    const jobId = `gen_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const outputDir = path.join(outputRoot, jobId);
    await mkdir(outputDir, { recursive: true });

    const { width, height } = parseSize(raw.size);
    const n = Math.max(1, Math.min(8, Math.round(raw.n ?? 1)));
    const base = raw.seed ?? randomInt(0, 1_000_000_000);
    const seeds = Array.from({ length: n }, (_, i) => base + i);
    const steps = raw.steps ?? model.defaultSteps;

    const job: GenJob = {
      id: jobId,
      modality: 'image',
      backend: 'mflux',
      outputDir,
      image: {
        prompt: raw.prompt,
        modelId: model.id,
        mfluxCommand: model.mflux.command,
        mfluxModel: model.mflux.model,
        width,
        height,
        steps,
        seeds,
        negativePrompt: raw.negativePrompt,
        quantize: model.defaultQuantize,
      },
    };

    const tabId = `pi:gen-${jobId}`;
    const modelInfo = { id: model.id, label: model.label, license: model.license };
    // Mutable surface state we re-send on each event.
    const candidates: GenSurfacePayload['candidates'][number][] = seeds.map((seed) => ({
      seed,
      status: 'pending' as const,
    }));
    let progress: GenSurfacePayload['progress'];

    const payload = (status: GenSurfacePayload['status'], error?: string): GenSurfacePayload => ({
      model: modelInfo,
      prompt: raw.prompt,
      candidates: candidates.map((c) => ({ ...c })),
      progress,
      status,
      error,
    });

    send('gen:open', { tabId, payload: payload('generating') });

    const onEvent = (event: GenEvent): void => {
      if (event.event === 'progress') {
        const c = candidates[event.candidate];
        if (c !== undefined) {
          candidates[event.candidate] = {
            ...c,
            status: 'generating',
            previewSrc: event.previewPath !== undefined ? toSrc(event.previewPath) : c.previewSrc,
          };
        }
        progress = { candidate: event.candidate, step: event.step, total: event.total };
        send('gen:update', { tabId, payload: payload('generating') });
      } else if (event.event === 'candidate') {
        const c = candidates[event.index];
        if (c !== undefined) {
          candidates[event.index] = {
            ...c,
            status: 'done',
            finalSrc: toSrc(event.output.outputPath),
          };
        }
        send('gen:update', { tabId, payload: payload('generating') });
      }
    };

    try {
      const outputs = await jobQueue.enqueue(job, {
        heavy: model.heavy,
        onEvent,
      }).result;
      progress = undefined;
      send('gen:update', { tabId, payload: payload('done') });
      return { jobId, outputs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send('gen:update', { tabId, payload: payload('error', message) });
      throw err;
    }
  }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'generate':
        return handleGenerate(params as unknown as GenerateImageParams);
      case 'cancel': {
        const jobId = String((params as { jobId?: unknown }).jobId ?? '');
        return { canceled: jobQueue.cancel(jobId) };
      }
      case 'listModels':
        return activeModels().map(summariseModel);
      default:
        throw new Error(`unknown gen method: ${method}`);
    }
  }

  // ── socket server (mirrors browser-agent.ts) ────────────────────────────────
  async function handleLine(socket: net.Socket, line: string): Promise<void> {
    let req: GenBridgeRequest;
    try {
      req = JSON.parse(line) as GenBridgeRequest;
    } catch {
      return;
    }
    if (typeof req.id !== 'number') return;
    const respond = (patch: Partial<GenBridgeResponse>): void => {
      try {
        socket.write(`${JSON.stringify({ id: req.id, ok: true, ...patch })}\n`);
      } catch {
        /* peer gone */
      }
    };
    if (req.token !== token) {
      respond({ ok: false, error: 'unauthorized' });
      return;
    }
    try {
      respond({ ok: true, result: await dispatch(req.method, req.params ?? {}) });
    } catch (err) {
      respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleConnection(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const l = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (l.trim() !== '') void handleLine(socket, l);
        nl = buffer.indexOf('\n');
      }
    });
  }

  const socketPath = process.env[GEN_SOCK_ENV] ?? defaultSocketPath();
  token = process.env[GEN_TOKEN_ENV] ?? randomBytes(24).toString('hex');
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* stale socket */
  }
  server = net.createServer((socket) => handleConnection(socket));
  server.on('error', (e) => log.error('gen bridge server error', { error: String(e) }));
  server.listen(socketPath, () => log.info('gen bridge listening', { socketPath }));
  // Publish for the pi child spawned later (env read at spawn time).
  process.env[GEN_SOCK_ENV] = socketPath;
  process.env[GEN_TOKEN_ENV] = token;

  // Renderer→main: cancel + tab-mounted ack.
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (opts.isTrusted !== undefined && !opts.isTrusted(event)) {
      throw new Error(`[gen] rejected "${channel}": untrusted`);
    }
  };
  ipcMain.handle('gen:cancel', (event, req: { jobId: string }) => {
    guard(event, 'gen:cancel');
    return { canceled: jobQueue.cancel(req.jobId) };
  });
  ipcMain.handle('gen:register', (event) => {
    guard(event, 'gen:register');
    return { ok: true };
  });
}

/**
 * Surface the vetted modality catalog to the renderer as plain DTOs
 * (`gen:modality-catalog`), mirroring how `registerLlmIpc` surfaces the
 * inference catalog. Deliberately SEPARATE from {@link registerGenIpc}: the
 * model browser must be able to enumerate every vetted generation model without
 * standing up the generation socket bridge (that lands with gen-as-tools). The
 * renderer's `useGenStore` consumes the result; nothing here touches the
 * gen-service barrel on the renderer side.
 */
export function registerGenCatalogIpc(
  ipc: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<GenCatalogInvokeMap>(
    ipc,
    {
      'gen:modality-catalog': () => ({ models: MODALITY_CATALOG.map(toModalityCatalogEntry) }),
    },
    { allowSender },
  );
}

/** Test/lifecycle hook: close the socket server. */
export function disposeGen(): void {
  server?.close();
  server = null;
}
