/**
 * Main-process host for the "inference-supervisor" utilityProcess: forks it,
 * proxies the trusted-sender-gated `llm:*` invoke channels to it over
 * parentPort, and rebroadcasts its status / download-progress messages to every
 * app window as `llm:*` events. The supervisor owns llama-server; main only
 * relays, so a crash there never takes the UI down.
 */
import path from 'node:path';
import {
  createIpcEventSender,
  createLogger,
  type IpcHandlers,
  registerIpcHandlers,
} from '@pi-desktop/shared';
import { app, BrowserWindow, type IpcMain, type UtilityProcess, utilityProcess } from 'electron';
import type { AppEventMap, HfInvokeMap, LlmInvokeMap, LlmStatus } from '../ipc-contract';
import type {
  HfListFilesReply,
  HfRegisterReply,
  HfSearchReply,
  LlmCatalogReply,
  LlmOutbound,
  LlmRequestBody,
} from './protocol';

const log = createLogger('desktop:llm');
const events = createIpcEventSender<AppEventMap>();

let child: UtilityProcess | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

/** Last status the supervisor broadcast — the source of the utility endpoint the
 * pi child points its reliability engine at (task #54). */
let lastStatus: LlmStatus | null = null;

/**
 * The OpenAI-compatible endpoint of the currently-running local model, or null
 * when no server is up. `baseUrl` already ends in `/v1` (supervisor.baseUrl), so
 * it feeds `PI_DESKTOP_UTILITY_BASE_URL` directly; `model` is the served id.
 * pi-main reads this at spawn to point the harness fixer/review/classifier at
 * the same local server. Never a hardcoded URL — absent server ⇒ null ⇒ the
 * harness degrades to its heuristic fallback.
 */
export function getInferenceUtility(): { baseUrl: string; model: string } | null {
  if (
    lastStatus === null ||
    !lastStatus.serverRunning ||
    lastStatus.baseUrl === null ||
    lastStatus.baseUrl.length === 0
  ) {
    return null;
  }
  return { baseUrl: lastStatus.baseUrl, model: lastStatus.model?.id ?? 'utility' };
}

/** The model the coordination harness starts when none is already running (the
 * utility/fast pick — sub-12B Q8 qwen). Named so a missing-model message can
 * point the user at the exact id to download. */
export const CORP_MODEL_ID = 'qwen3.5-4b-mtp';

/**
 * The outcome of {@link ensureCorpInferenceServer}: either a running endpoint,
 * or an honest failure carrying the model id + reason so the caller can SURFACE
 * a user-meaningful "model isn't available" instead of degrading silently.
 */
export type CorpInferenceResult =
  | { readonly ok: true; readonly baseUrl: string; readonly model: string }
  | { readonly ok: false; readonly modelId: string; readonly error: string };

/**
 * Ensure a local model server is up for the coordination harness. When a server
 * is already running it is reused as-is; otherwise the recommended sub-12B Q8 qwen
 * ({@link CORP_MODEL_ID} `Q8_0`) is started via the SAME supervisor path the Model
 * Manager uses. Context size is auto-capped to 16384 by the supervisor
 * (CONTEXT_CAP), so the corp turns run with `-c 16384` without a knob here.
 *
 * Never throws: a model that cannot be found/started resolves to an `ok:false`
 * result carrying the model id + error, so the caller surfaces it (a missing
 * model is a loud, honest terminal state — never a silent degrade to a stub).
 */
export async function ensureCorpInferenceServer(): Promise<CorpInferenceResult> {
  const existing = getInferenceUtility();
  if (existing !== null) return { ok: true, ...existing };
  try {
    const res = await request<{ success: boolean; baseUrl?: string; error?: string }>({
      type: 'start-server',
      modelId: CORP_MODEL_ID,
      quant: 'Q8_0',
      launchMode: 'fast-text',
    });
    if (res.success && res.baseUrl !== undefined && res.baseUrl.length > 0) {
      return { ok: true, baseUrl: res.baseUrl, model: CORP_MODEL_ID };
    }
    // A server may have raced up during the start attempt — reuse it if so.
    const late = getInferenceUtility();
    if (late !== null) return { ok: true, ...late };
    return { ok: false, modelId: CORP_MODEL_ID, error: res.error ?? 'model not available' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn('ensureCorpInferenceServer: start-server failed', { error });
    const late = getInferenceUtility();
    if (late !== null) return { ok: true, ...late };
    return { ok: false, modelId: CORP_MODEL_ID, error };
  }
}

function broadcast<K extends keyof AppEventMap & string>(
  channel: K,
  payload: AppEventMap[K],
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) events.send(win.webContents, channel, payload);
  }
}

function ensureChild(): UtilityProcess {
  if (child !== null) return child;
  const entry = path.join(__dirname, 'inference-supervisor.js');
  const proc = utilityProcess.fork(entry, [], { serviceName: 'inference-supervisor' });

  proc.on('message', (message: LlmOutbound) => {
    if (message.kind === 'status') {
      lastStatus = message.status;
      broadcast('llm:status', message.status);
      return;
    }
    if (message.kind === 'download-progress') {
      broadcast('llm:download-progress', message.progress);
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.kind === 'reply') waiter.resolve(message.result);
    else waiter.reject(new Error(message.error));
  });

  proc.on('exit', (code) => {
    log.warn('inference-supervisor exited', { code });
    child = null;
    lastStatus = null;
    for (const waiter of pending.values()) waiter.reject(new Error('inference-supervisor exited'));
    pending.clear();
  });

  child = proc;
  log.info('inference-supervisor forked', { pid: proc.pid });
  return proc;
}

/**
 * App-quit teardown for the inference stack. Killing the utilityProcess is what
 * makes its `process.on('SIGTERM'|'exit')` handlers reap the llama-server
 * grandchild (supervisor-entry.ts) — so no llama-server survives quit holding
 * the model in RAM/VRAM. Bounded: if the utilityProcess is wedged and never
 * emits `exit`, we resolve on the timeout rather than blocking the quit.
 *
 * Wired into the single ordered quit sequence (pi-main quit-hold `extraTeardown`),
 * which runs BEFORE `app.exit()`. `app.exit()` does not emit `will-quit`, so the
 * `will-quit` handler below is only a backstop for quit paths that bypass the hold.
 */
export async function shutdownInference(timeoutMs = 1500): Promise<void> {
  const proc = child;
  if (proc === null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  try {
    // Default SIGTERM: caught in supervisor-entry, which SIGKILLs llama-server.
    proc.kill();
  } catch {
    // already gone
  }
  const timed = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    t.unref?.();
  });
  await Promise.race([exited, timed]);
}

function request<T>(req: LlmRequestBody): Promise<T> {
  const proc = ensureChild();
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    proc.postMessage({ ...req, id });
  });
}

const handlers: IpcHandlers<LlmInvokeMap> = {
  'llm:get-status': () => request<LlmStatus>({ type: 'get-status' }),
  'llm:list-catalog': () => request<LlmCatalogReply>({ type: 'list-catalog' }),
  'llm:download-model': (req) =>
    request({
      type: 'download-model',
      modelId: req.modelId,
      quant: req.quant,
      hfToken: req.hfToken,
    }),
  'llm:pause-download': () => request({ type: 'pause-download' }),
  'llm:cancel-download': () => request({ type: 'cancel-download' }),
  'llm:delete-model': (req) => request({ type: 'delete-model', modelId: req.modelId }),
  'llm:verify-model': (req) =>
    request({ type: 'verify-model', modelId: req.modelId, quant: req.quant }),
  'llm:start-server': (req) =>
    request({
      type: 'start-server',
      modelId: req.modelId,
      quant: req.quant,
      launchMode: req.launchMode,
    }),
  'llm:stop-server': () => request({ type: 'stop-server' }),
};

/** Hugging Face browse/register channels — proxied to the same supervisor, which
 * owns hf-search + the discovered-model registry (see supervisor-entry.ts). */
const hfHandlers: IpcHandlers<HfInvokeMap> = {
  'hf:search': (req) =>
    request<HfSearchReply>({
      type: 'hf-search',
      query: req.query,
      family: req.family,
      task: req.task,
      gated: req.gated,
      minLikes: req.minLikes,
      sort: req.sort,
      limit: req.limit,
      hfToken: req.hfToken,
    }),
  'hf:list-files': (req) =>
    request<HfListFilesReply>({
      type: 'hf-list-files',
      repoId: req.repoId,
      contextWindow: req.contextWindow,
      hfToken: req.hfToken,
    }),
  'hf:register': (req) =>
    request<HfRegisterReply>({
      type: 'register-hf-model',
      hit: req.hit,
      file: req.file,
      mmproj: req.mmproj,
      mtpFile: req.mtpFile,
      contextWindow: req.contextWindow,
    }),
};

export function registerLlmIpc(ipcMain: IpcMain, allowSender: (event: unknown) => boolean): void {
  registerIpcHandlers<LlmInvokeMap>(ipcMain, handlers, { allowSender });
  registerIpcHandlers<HfInvokeMap>(ipcMain, hfHandlers, { allowSender });
  // Stand the supervisor up now so its initial idle status broadcasts to the
  // window as soon as the renderer subscribes.
  ensureChild();
  app.on('will-quit', () => child?.kill());
}
