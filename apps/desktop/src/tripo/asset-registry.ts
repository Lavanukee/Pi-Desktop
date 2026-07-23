/**
 * In-memory registry for imported model files (drag-and-drop or Upload).
 * ArrayBuffers stay OUT of the zustand store (they're heavy and never drive
 * renders); the store holds asset metadata + thumbnail only, keyed by the same
 * id. The Viewer3D reads the bytes from here when a registry-backed asset is
 * loaded. Session-scoped by design (a dropped file is a working copy).
 */

export type ImportedFormat = 'glb' | 'gltf' | 'obj' | 'stl';

export interface ImportedModel {
  readonly name: string;
  readonly format: ImportedFormat;
  readonly buffer: ArrayBuffer;
}

const registry = new Map<string, ImportedModel>();
let counter = 0;

/** The imported-model format for a filename, or null when unsupported. */
export function importedFormatOf(fileName: string): ImportedFormat | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'glb' || ext === 'gltf' || ext === 'obj' || ext === 'stl') return ext;
  return null;
}

/** Store an imported model's bytes; returns its new asset id. */
export function registerImportedModel(
  name: string,
  format: ImportedFormat,
  buffer: ArrayBuffer,
): string {
  counter += 1;
  const id = `imported-${counter}`;
  registry.set(id, { name, format, buffer });
  return id;
}

export function importedModel(id: string): ImportedModel | undefined {
  return registry.get(id);
}

export function forgetImportedModel(id: string): void {
  registry.delete(id);
}
