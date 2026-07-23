import {
  createIpcClient,
  createIpcEventHub,
  IPC_EVENT_CHANNEL,
  type IpcEventEnvelope,
} from '@pi-desktop/shared';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  APP_INVOKE_CHANNELS,
  type AppEventMap,
  type AppInvokeMap,
  type PiDesktopBridge,
} from './ipc-contract';

const client = createIpcClient<AppInvokeMap>(ipcRenderer);
const hub = createIpcEventHub<AppEventMap>();

// Attach to the wire immediately: events main sends before React mounts are
// buffered by the hub and flushed to the first subscriber (load-bearing).
ipcRenderer.on(IPC_EVENT_CHANNEL, (_event, envelope: IpcEventEnvelope) => {
  hub.dispatch(envelope);
});

// Runtime mirror of the compile-time contract. invoke is otherwise a verbatim
// passthrough, so without this gate renderer code could reach ANY channel any
// main-process module ever registers, not just the contract surface.
const allowedInvokeChannels: ReadonlySet<string> = new Set(APP_INVOKE_CHANNELS);

const bridge: PiDesktopBridge = {
  invoke: (channel, request) =>
    allowedInvokeChannels.has(channel)
      ? client.invoke(channel, request)
      : Promise.reject(new Error(`[preload] blocked invoke to unregistered channel "${channel}"`)),
  onEvent: (channel, listener) => hub.subscribe(channel, listener),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('piDesktop', bridge);
