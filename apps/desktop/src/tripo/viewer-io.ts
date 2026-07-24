/**
 * Studio ↔ viewer command bus + model-file import.
 *
 * The three.js scene lives inside the lazily-mounted Viewer3D, but export /
 * send-to actions are triggered from chrome that renders regardless (top bar,
 * export dialog). This tiny bus forwards those requests to the live viewer,
 * which owns the geometry and runs the real three exporters. No zustand: a
 * command is an imperative one-shot, not render state.
 *
 * Import (drag-and-drop or Upload buttons) is also here: it registers the
 * file's bytes (asset-registry), adds the asset row, and loads it into the
 * viewport — the flow jedd asked for ("dragging and dropping any model
 * anywhere automatically puts it into the viewport and puts an image of it
 * into the right sidebar"; the image lands when the viewer captures its first
 * rendered frame).
 */
import { importedFormatOf, registerImportedModel } from './asset-registry';
import type { ExportFormat } from './data';
import { useTripoStore } from './store';

export interface ViewerExportRequest {
  readonly format: ExportFormat;
  readonly fileName: string;
}

export type ViewerCommandHandler = (req: ViewerExportRequest) => void;

let exportHandler: ViewerCommandHandler | null = null;

/** Viewer3D registers itself as the export executor while mounted. */
export function setViewerExportHandler(h: ViewerCommandHandler | null): void {
  exportHandler = h;
}

/** Export the current model (from the Export dialog). No-op without a viewer. */
export function requestExport(format: ExportFormat, fileName: string): void {
  exportHandler?.({ format, fileName });
}

/** Send To <app>: exports a GLB named for the target app (the interop format
 * every listed DCC imports). The button is disabled until a model is loaded. */
export function requestSendTo(targetId: string): void {
  const name = useTripoStore
    .getState()
    .assets.find((a) => a.id === useTripoStore.getState().loadedAssetId)?.name;
  exportHandler?.({ format: 'GLB', fileName: `${name ?? 'model'}-for-${targetId}` });
}

/** True when the file is an importable 3D model (.glb/.gltf/.obj/.stl). */
export function isModelFile(file: File): boolean {
  return importedFormatOf(file.name) !== null;
}

/** True when the file is an image usable as an image→3D input. */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name);
}

/** Max input images for image→3D (TRELLIS pools unlabeled views; beyond a
 * handful there's no accuracy gain, so we cap the picker). */
export const MAX_INPUT_IMAGES = 6;

/**
 * Add images to the geometry input set (from the picker or a drop): captures
 * each file's disk path (for the engine) + an object URL (for the thumbnail),
 * dedups by path, caps at MAX_INPUT_IMAGES, and switches to the Generate/Image
 * input so the drop is visible where it lands.
 */
export function addInputImages(files: readonly File[]): void {
  const s = useTripoStore.getState();
  const existing = s.genImages;
  const picked = files.filter(isImageFile).map((f) => ({
    path: window.piDesktop.pathForFile(f),
    name: f.name,
    url: URL.createObjectURL(f),
  }));
  const merged = [...existing];
  for (const p of picked) {
    if (p.path.length === 0) continue;
    if (merged.some((m) => m.path === p.path)) continue;
    if (merged.length >= MAX_INPUT_IMAGES) break;
    merged.push(p);
  }
  s.set('genImages', merged);
  s.setTool('model');
  s.set('inputMode', 'image');
}

/**
 * Import a model file: register its bytes, add the asset row (thumbnail is
 * captured by the viewer after its first rendered frame), and load it into
 * the viewport. Captures the file's real disk path (webUtils) so engine stage
 * ops can run on it. Returns false for unsupported files.
 */
export async function importModelFile(file: File): Promise<boolean> {
  const format = importedFormatOf(file.name);
  if (format === null) return false;
  const buffer = await file.arrayBuffer();
  const diskPath = window.piDesktop.pathForFile(file);
  importModelBuffer(file.name, format, buffer, {
    source: 'imported',
    created: 'Imported',
    diskPath: diskPath.length > 0 ? diskPath : undefined,
  });
  return true;
}

/**
 * Import a model from raw bytes (engine artifacts, e.g. freshly generated
 * geometry): same registry + asset + load flow as a file import.
 */
export function importModelBuffer(
  fileName: string,
  format: 'glb' | 'gltf' | 'obj' | 'stl',
  buffer: ArrayBuffer,
  opts: {
    readonly source: 'imported' | 'generated';
    readonly created: string;
    readonly diskPath?: string;
  },
): string {
  const id = registerImportedModel(fileName, format, buffer);
  const s = useTripoStore.getState();
  s.addAsset({
    id,
    name: fileName.replace(/\.[^.]+$/, ''),
    source: opts.source,
    thumb: null,
    faces: 0,
    vertices: 0,
    created: opts.created,
    ...(opts.diskPath !== undefined ? { diskPath: opts.diskPath } : {}),
  });
  s.loadAsset(id);
  return id;
}
