/**
 * gen3d main-process handlers — currently the HONEST STUB implementation of
 * the contract: the catalog reports the real models with their real download
 * sizes but `engineReady:false` / `installed:false`, and every action returns
 * a clear "engine not installed yet" error instead of pretending.
 *
 * The engine wave replaces the internals of this file with the real uv/Python
 * sidecar wiring (downloads + MPS inference + progress events) WITHOUT
 * changing the contract — the UI is already written against it.
 */
import { createLogger, type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain, WebContents } from 'electron';
import type { Gen3dInvokeMap, Gen3dModelInfo } from './gen3d-contract';

const log = createLogger('desktop:gen3d');

/** Real repo sizes (HF API, 2026-07): the download dialog shows these. */
const MODELS: readonly Gen3dModelInfo[] = [
  {
    id: 'trellis2',
    label: 'TRELLIS-2 (4B)',
    role: 'geometry',
    sizeBytes: 16_200_000_000,
    installed: false,
    downloading: false,
    note: 'Image → 3D geometry (microsoft/TRELLIS.2-4B)',
  },
  {
    id: 'mageflow',
    label: 'Mage-Flow Turbo',
    role: 'image',
    sizeBytes: 17_500_000_000,
    installed: false,
    downloading: false,
    note: 'Text → image, the first hop of text → 3D (microsoft/Mage-Flow-Turbo)',
  },
  {
    id: 'hunyuan-paint',
    label: 'Hunyuan Paint',
    role: 'texture',
    sizeBytes: 14_900_000_000,
    installed: false,
    downloading: false,
    note: 'Texture generation (tencent/Hunyuan3D-2.1 paint)',
  },
  {
    id: 'cubepart',
    label: 'CubePart',
    role: 'segment',
    sizeBytes: 9_900_000_000,
    installed: false,
    downloading: false,
    note: 'Semantic part segmentation (Roblox/cubepart)',
  },
  {
    id: 'autoremesher',
    label: 'AutoRemesher',
    role: 'retopo',
    sizeBytes: 0,
    installed: false,
    downloading: false,
    note: 'Quad retopology (huxingyi/autoremesher, compiled locally)',
  },
];

const NOT_INSTALLED =
  'The 3D engine is not installed yet — open the download prompt to fetch the models.';

const handlers: IpcHandlers<Gen3dInvokeMap> = {
  'gen3d:catalog': () => ({
    engineReady: false,
    models: MODELS,
    // The engine-verified TRELLIS.2 presets (512 / 1024_cascade / 1536_cascade).
    resolutions: { low: 512, medium: 1024, high: 1536 },
  }),
  'gen3d:download': (req) => {
    log.info('gen3d download requested (stub)', { ids: req.ids });
    return { ok: false, error: NOT_INSTALLED };
  },
  'gen3d:cancel-download': () => ({ ok: false }),
  'gen3d:generate': () => ({ ok: false, error: NOT_INSTALLED }),
  'gen3d:stage': () => ({ ok: false, error: NOT_INSTALLED }),
  'gen3d:cancel': () => ({ ok: false }),
};

export function registerGen3dIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
  _getWebContents: () => WebContents | null,
): void {
  registerIpcHandlers<Gen3dInvokeMap>(ipcMain, handlers, { allowSender });
}
