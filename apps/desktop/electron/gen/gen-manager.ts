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
  ComfyClient,
  defaultImageModel,
  defaultVideoModel,
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
  type GenerateVideoParams,
  type GenerateVideoResult,
  type GenModelSummary,
} from '@pi-desktop/gen-tools/contract';
import { createLogger, registerIpcHandlers } from '@pi-desktop/shared';
import { type IpcMain, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import {
  type AssetConsent,
  type EnsureAssetFn,
  type GenAssetNeed,
  makeComfyAssetGate,
} from './asset-gate';
import { type ComfyInstallManager, GPL_CONSENT_DISCLOSURE } from './comfy-install';
import { surfaceModalityCatalog } from './gen-catalog-dto';
import type {
  GenCatalogInvokeMap,
  GenEventMap,
  GenInvokeMap,
  GenSurfacePayload,
} from './gen-ipc-contract';
import {
  buildVideoJob,
  defaultExtractPosterFrame,
  type FrameExtractor,
  type HyperFramesRender,
  HyperFramesRunner,
  makeVideoAwareRunner,
} from './video-dispatch';

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
  /**
   * ComfyUI http origin resolver for `comfyui`-backed video (LTX/Wan) jobs.
   * Default REJECTS (ComfyUI not configured) — the real app starts the supervisor
   * and returns its `http://127.0.0.1:<port>` origin (or a remote host).
   */
  readonly comfyResolveOrigin?: () => Promise<string>;
  /**
   * Node HyperFrames motion-graphics renderer (ffmpeg + headless Chrome). Default
   * emits a clear "not installed" error until the aux deps land.
   */
  readonly hyperFramesRender?: HyperFramesRender;
  /** Poster-frame extractor for video self-critique. Default: ffmpeg best-effort. */
  readonly extractPosterFrame?: FrameExtractor;
  /**
   * Download-then-CONTINUE gate: awaited before a job is enqueued so a job whose
   * model/pack is missing PROMPTS the user, downloads on accept, then continues
   * the SAME job (see asset-gate.ts). Throws to abort (declined / failed).
   * Default: none (assets assumed present). When {@link comfyInstall} is given
   * and this is omitted, a ComfyUI gate is derived from it automatically.
   */
  readonly ensureAsset?: EnsureAssetFn;
  /**
   * The ComfyUI install-manager (comfy-install.ts). When provided, the
   * `gen:comfy-status` / `gen:comfy-consent` / `gen:comfy-start` invokes answer
   * from it (the modular-download UI), and — unless {@link ensureAsset} is set —
   * a download-then-continue gate for `comfyui`-backed jobs is built from it.
   */
  readonly comfyInstall?: Pick<ComfyInstallManager, 'status' | 'recordConsent' | 'run'>;
}

/**
 * The download need for a model, or `undefined` when nothing must be fetched
 * up-front. Only `comfyui`-backed entries (LTX / Wan video, advanced ComfyUI
 * image/music) carry a downloadable pack — mflux image auto-fetches on the
 * worker, and HyperFrames is pure-CPU — so only they gate. The pack id matches
 * the catalog id (comfy-install keeps them in sync).
 */
function needForModel(model: ModalityModel): GenAssetNeed | undefined {
  if (model.backend !== 'comfyui') return undefined;
  return {
    kind: 'pack',
    id: model.id,
    label: model.label,
    approxSizeGB: model.approxSizeGB,
  };
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
  // Video routes to a persistent ComfyUI server (LTX/Wan) or the Node HyperFrames
  // runner — never the uv worker. Both default to a clear "not configured" error
  // until their runtimes install; image (mflux) still runs on the uv `client`.
  const comfy = new ComfyClient({
    resolveOrigin:
      opts.comfyResolveOrigin ??
      (() =>
        Promise.reject(
          new Error('ComfyUI is not configured for local video generation on this machine'),
        )),
  });
  const hyperframes = new HyperFramesRunner(opts.hyperFramesRender);
  const extractPoster = opts.extractPosterFrame ?? defaultExtractPosterFrame;
  const jobQueue = new JobQueue({
    maxConcurrent: opts.maxConcurrent ?? 2,
    runner: makeVideoAwareRunner({ comfy, hyperframes, fallback: client }),
  });

  const send = <K extends keyof GenEventMap>(channel: K, payload: GenEventMap[K]): void => {
    const wc = opts.getWindow();
    if (wc !== null && !wc.isDestroyed()) opts.sendEvent(wc, channel, payload);
  };

  // ── download-then-continue gate (asset-gate.ts) ─────────────────────────────
  // A job whose ComfyUI pack is missing PROMPTS the user, downloads on accept,
  // then continues the SAME job. Explicit `ensureAsset` wins (tests); otherwise a
  // ComfyUI gate is derived from the injected install-manager. A single-flight
  // pending consent is resolved by the `gen:comfy-start` invoke (renderer Accept).
  let pendingConsent: ((consent: AssetConsent) => void) | null = null;
  const awaitConsent = (_need: GenAssetNeed): Promise<AssetConsent> => {
    // Surface the one-time GPL disclosure; the modular-download UI drives Accept.
    send('gen:comfy-install', { kind: 'consent-required', disclosure: GPL_CONSENT_DISCLOSURE });
    return new Promise<AssetConsent>((resolve) => {
      pendingConsent = resolve;
    });
  };
  const ensureAsset: EnsureAssetFn | undefined =
    opts.ensureAsset ??
    (opts.comfyInstall !== undefined
      ? makeComfyAssetGate(opts.comfyInstall, { awaitConsent })
      : undefined);

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
      // Download-then-continue: an mflux image needs no up-front pack, so this is
      // a no-op here; the seam is uniform so a future comfyui-backed image gates too.
      const need = needForModel(model);
      if (need !== undefined && ensureAsset !== undefined) await ensureAsset(need);
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

  async function handleGenerateVideo(raw: GenerateVideoParams): Promise<GenerateVideoResult> {
    const model = getModel(raw.model ?? defaultVideoModel().id);
    if (model === undefined || model.modality !== 'video') {
      throw new Error(`unknown or non-video model "${raw.model ?? ''}"`);
    }
    const jobId = `gen_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const outputDir = path.join(outputRoot, jobId);
    await mkdir(outputDir, { recursive: true });

    const clamp = (n: number, lo: number, hi: number): number =>
      Math.max(lo, Math.min(hi, Math.round(n)));
    const { width, height } = parseSize(raw.size);
    const seconds = clamp(raw.seconds ?? 5, 1, 60);
    const fps = clamp(raw.fps ?? 24, 1, 60);
    const seed = raw.seed ?? randomInt(0, 1_000_000_000);

    const job: GenJob = buildVideoJob(
      model,
      {
        prompt: raw.prompt,
        width,
        height,
        seconds,
        fps,
        steps: model.defaultSteps,
        negativePrompt: raw.negativePrompt,
        seed,
      },
      jobId,
      outputDir,
    );

    const tabId = `pi:gen-${jobId}`;
    const modelInfo = { id: model.id, label: model.label, license: model.license };
    // One candidate (video generation is one clip per job); reuse the image
    // surface payload shape (candidate.finalSrc carries the produced MP4 url).
    let candidate: GenSurfacePayload['candidates'][number] = { seed, status: 'pending' };
    let progress: GenSurfacePayload['progress'];

    const payload = (status: GenSurfacePayload['status'], error?: string): GenSurfacePayload => ({
      model: modelInfo,
      prompt: raw.prompt,
      candidates: [{ ...candidate }],
      progress,
      status,
      error,
    });

    send('gen:open', { tabId, payload: payload('generating') });

    const onEvent = (event: GenEvent): void => {
      if (event.event === 'progress') {
        candidate = { ...candidate, status: 'generating' };
        progress = { candidate: 0, step: event.step, total: event.total };
        send('gen:update', { tabId, payload: payload('generating') });
      } else if (event.event === 'candidate') {
        candidate = { ...candidate, status: 'done', finalSrc: toSrc(event.output.outputPath) };
        send('gen:update', { tabId, payload: payload('generating') });
      }
    };

    try {
      // Download-then-continue: a comfyui-backed video (LTX / Wan) whose weights
      // pack is missing PROMPTS the user, downloads on accept, then continues here.
      const need = needForModel(model);
      if (need !== undefined && ensureAsset !== undefined) await ensureAsset(need);
      const outputs = await jobQueue.enqueue(job, { heavy: model.heavy, onEvent }).result;
      progress = undefined;
      send('gen:update', { tabId, payload: payload('done') });
      // A chat model can't watch an MP4 — extract a still poster frame (best-effort).
      let posterFramePath: string | undefined;
      const first = outputs[0];
      if (first !== undefined) {
        posterFramePath = await extractPoster(first.outputPath, outputDir);
      }
      return { jobId, outputs, posterFramePath };
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
      case 'generateVideo':
        return handleGenerateVideo(params as unknown as GenerateVideoParams);
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

  // ComfyUI modular-download install manager (comfy-install.ts). Registered only
  // when a manager is injected, so the model-browser install UI + the
  // download-then-continue gate answer from the SAME manager. The manager streams
  // its own progress via its `emit` dep (main wires it to `send('gen:comfy-install')`).
  const installer = opts.comfyInstall;
  if (installer !== undefined) {
    ipcMain.handle(
      'gen:comfy-status',
      async (event, req: GenInvokeMap['gen:comfy-status']['request']) => {
        guard(event, 'gen:comfy-status');
        return { state: await installer.status(req?.acceptedLicenses) };
      },
    );
    ipcMain.handle('gen:comfy-consent', async (event) => {
      guard(event, 'gen:comfy-consent');
      await installer.recordConsent();
      return { ok: true };
    });
    ipcMain.handle(
      'gen:comfy-start',
      async (event, req: GenInvokeMap['gen:comfy-start']['request']) => {
        guard(event, 'gen:comfy-start');
        // A pending download-then-continue gate takes precedence: Accept resolves
        // it (the gate runs the install + continues the job); don't double-run here.
        if (pendingConsent !== null) {
          const resolve = pendingConsent;
          pendingConsent = null;
          resolve({ accepted: true, acceptedLicenses: req.acceptedLicenses });
          return { state: await installer.status(req.acceptedLicenses) };
        }
        return { state: await installer.run(req.packIds, req.acceptedLicenses) };
      },
    );
  }
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
      // Tool-only rows (e.g. hyperframes) are filtered here — the model browser
      // enumerates MODELS, not the agent's generation tools.
      'gen:modality-catalog': () => ({ models: surfaceModalityCatalog(MODALITY_CATALOG) }),
    },
    { allowSender },
  );
}

/** Test/lifecycle hook: close the socket server. */
export function disposeGen(): void {
  server?.close();
  server = null;
}
