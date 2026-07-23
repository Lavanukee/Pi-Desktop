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

/**
 * Import a model file: register its bytes, add the asset row (thumbnail is
 * captured by the viewer after its first rendered frame), and load it into
 * the viewport. Returns false for unsupported files.
 */
export async function importModelFile(file: File): Promise<boolean> {
  const format = importedFormatOf(file.name);
  if (format === null) return false;
  const buffer = await file.arrayBuffer();
  const id = registerImportedModel(file.name, format, buffer);
  const s = useTripoStore.getState();
  s.addAsset({
    id,
    name: file.name.replace(/\.[^.]+$/, ''),
    source: 'imported',
    thumb: null,
    faces: 0,
    vertices: 0,
    created: 'Imported',
  });
  s.loadAsset(id);
  return true;
}
