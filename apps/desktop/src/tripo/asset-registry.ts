/**
 * Model-bytes registry for the studio.
 *
 * ArrayBuffers stay OUT of the zustand store (heavy, never drive renders); the
 * store holds metadata + thumbnail only, keyed by the same id.
 *
 * It is BOUNDED. It used to retain every buffer for the whole session, so a
 * version tree with a handful of nodes pinned every mesh it had ever seen in
 * the renderer heap at once — and the renderer heap is exactly what an "oom"
 * render-process-gone hits. Buffers are now evicted oldest-first past a byte
 * budget, and anything with a disk path is re-read on demand rather than held
 * forever: engine artifacts live under the sandbox and imported files where the
 * user put them, so the bytes are never actually lost.
 *
 * The same re-read path is what lets a tree RESTORED from a previous session
 * load its versions at all — nothing was ever in this registry for those.
 */

export type ImportedFormat = 'glb' | 'gltf' | 'obj' | 'stl';

export interface ImportedModel {
  readonly name: string;
  readonly format: ImportedFormat;
  readonly buffer: ArrayBuffer;
}

interface Entry extends ImportedModel {
  /** Where to re-read the bytes from after eviction. */
  readonly diskPath?: string;
  readonly bytes: number;
}

/** How much model data the renderer may hold at once — well under the heap cap,
 * and large enough that swapping between recent versions never re-reads. */
const BUDGET_BYTES = 320 * 1024 * 1024;

/** Insertion-ordered: Map iteration gives us oldest-first eviction. */
const registry = new Map<string, Entry>();
/** Disk paths outlive eviction, so evicted bytes can always be recovered. */
const paths = new Map<string, string>();
let counter = 0;
let heldBytes = 0;

/**
 * A per-LAUNCH prefix, so ids from different sessions can never collide.
 *
 * `counter` is module state and resets to 0 every time the app starts, while
 * the asset tree is persisted in localStorage — so the first asset of session 2
 * was minted as `imported-1`, the id session 1 had already given to a different
 * model. Everything downstream keys off that id, so a collision meant:
 *
 *   - two cards for one model, both matching `selectedAssetId` (jedd: "there's
 *     2 images on a plane on the right even though they're the same, when I
 *     click on one both highlight blue")
 *   - a thumbnail capture landing on EVERY entry sharing the id ("generating
 *     that new model finally will just replace all the images of every item in
 *     the sidebar")
 *   - `assets.find(a => a.id === loadedAssetId)` resolving to the OLD entry, so
 *     the viewport kept showing the previous model and the new card sat blank.
 *
 * A launch-unique prefix fixes all three at the source. It is deliberately NOT
 * a persisted counter: nothing may depend on ids being sequential, and a value
 * derived from the launch cannot be corrupted by a half-written settings file.
 */
const SESSION = Math.random().toString(36).slice(2, 8);

/** The imported-model format for a filename, or null when unsupported. */
export function importedFormatOf(fileName: string): ImportedFormat | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'glb' || ext === 'gltf' || ext === 'obj' || ext === 'stl') return ext;
  return null;
}

function evictDownTo(budget: number, keepId: string | null): void {
  for (const [id, entry] of registry) {
    if (heldBytes <= budget) return;
    if (id === keepId) continue;
    // Only evict what we can get back, or the asset becomes unloadable.
    if (entry.diskPath === undefined) continue;
    registry.delete(id);
    heldBytes -= entry.bytes;
  }
}

/** Store a model's bytes; returns its new asset id. */
export function registerImportedModel(
  name: string,
  format: ImportedFormat,
  buffer: ArrayBuffer,
  diskPath?: string,
): string {
  counter += 1;
  const id = `imported-${SESSION}-${counter}`;
  registry.set(id, {
    name,
    format,
    buffer,
    bytes: buffer.byteLength,
    ...(diskPath !== undefined ? { diskPath } : {}),
  });
  heldBytes += buffer.byteLength;
  if (diskPath !== undefined) paths.set(id, diskPath);
  evictDownTo(BUDGET_BYTES, id);
  return id;
}

export function importedModel(id: string): ImportedModel | undefined {
  const entry = registry.get(id);
  if (entry === undefined) return undefined;
  // Touch: re-insert so recently used entries are evicted last.
  registry.delete(id);
  registry.set(id, entry);
  return entry;
}

/** pd-file:// URL for an absolute path (the scheme's `f` host + encoded path). */
function pdFileUrl(absPath: string): string {
  return `pd-file://f${absPath.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The model's bytes, re-read from disk when they were evicted (or were never
 * here, e.g. a tree restored from a previous session). Undefined when the file
 * is genuinely unavailable.
 */
export async function ensureModelBytes(
  id: string,
  diskPath?: string,
  name?: string,
): Promise<ImportedModel | undefined> {
  const held = importedModel(id);
  if (held !== undefined) return held;
  const from = diskPath ?? paths.get(id);
  if (from === undefined) return undefined;
  const format = importedFormatOf(name ?? from);
  if (format === null) return undefined;
  try {
    const res = await fetch(pdFileUrl(from));
    if (!res.ok) return undefined;
    const buffer = await res.arrayBuffer();
    const entry: Entry = {
      name: name ?? from.split('/').pop() ?? 'model',
      format,
      buffer,
      bytes: buffer.byteLength,
      diskPath: from,
    };
    registry.set(id, entry);
    heldBytes += entry.bytes;
    paths.set(id, from);
    evictDownTo(BUDGET_BYTES, id);
    return entry;
  } catch {
    return undefined;
  }
}

export function forgetImportedModel(id: string): void {
  const entry = registry.get(id);
  if (entry !== undefined) heldBytes -= entry.bytes;
  registry.delete(id);
  paths.delete(id);
}

/** Diagnostics: what the renderer is currently holding. */
export function registryStats(): { count: number; bytes: number } {
  return { count: registry.size, bytes: heldBytes };
}
