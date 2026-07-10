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
import type { AppEventMap, LlmInvokeMap, LlmStatus } from '../ipc-contract';
import type { LlmCatalogReply, LlmOutbound, LlmRequestBody } from './protocol';

const log = createLogger('desktop:llm');
const events = createIpcEventSender<AppEventMap>();

let child: UtilityProcess | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

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
    for (const waiter of pending.values()) waiter.reject(new Error('inference-supervisor exited'));
    pending.clear();
  });

  child = proc;
  log.info('inference-supervisor forked', { pid: proc.pid });
  return proc;
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
    request({ type: 'download-model', modelId: req.modelId, quant: req.quant }),
  'llm:pause-download': () => request({ type: 'pause-download' }),
  'llm:cancel-download': () => request({ type: 'cancel-download' }),
  'llm:delete-model': (req) => request({ type: 'delete-model', modelId: req.modelId }),
  'llm:verify-model': (req) =>
    request({ type: 'verify-model', modelId: req.modelId, quant: req.quant }),
  'llm:start-server': (req) =>
    request({ type: 'start-server', modelId: req.modelId, quant: req.quant }),
  'llm:stop-server': () => request({ type: 'stop-server' }),
};

export function registerLlmIpc(ipcMain: IpcMain, allowSender: (event: unknown) => boolean): void {
  registerIpcHandlers<LlmInvokeMap>(ipcMain, handlers, { allowSender });
  // Stand the supervisor up now so its initial idle status broadcasts to the
  // window as soon as the renderer subscribes.
  ensureChild();
  app.on('will-quit', () => child?.kill());
}
