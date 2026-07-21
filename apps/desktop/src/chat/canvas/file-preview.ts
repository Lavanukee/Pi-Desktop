/**
 * Pure helpers for the binary MODALITY previews (images / video / audio / pdf /
 * 3D models / Office docs). Kept free of React / DOM / IPC so the extension→kind
 * mapping and the `pd-file://` URL builder are unit-testable in a node env; the
 * stateful tab wiring that consumes them lives in file-tabs.ts.
 */
import type { CanvasTabKind } from '@pi-desktop/canvas';

// Each extension maps to a canvas tab kind + an upper-cased media-type hint the
// surface uses to pick its concrete renderer. SVG is DELIBERATELY absent: it
// renders as text/svg in the file surface (with a raw↔rendered toggle), so
// routing it here would lose that. The older binary .doc/.ppt are not covered —
// mammoth / the pptx reader only handle the OOXML (zip) formats.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'apng']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus']);
const MODEL_EXT = new Set(['glb', 'gltf', 'obj', 'stl', 'ply']);

/** A binary file's preview tab kind + media-type hint, or null when the file is
 * not a previewable modality (→ falls back to the text/code file surface). The
 * `ext` is the lower-cased extension with no leading dot. */
export function previewKindForExt(ext: string): { kind: CanvasTabKind; mediaType: string } | null {
  if (IMAGE_EXT.has(ext)) return { kind: 'image', mediaType: ext.toUpperCase() };
  if (VIDEO_EXT.has(ext)) return { kind: 'video', mediaType: ext.toUpperCase() };
  if (AUDIO_EXT.has(ext)) return { kind: 'audio', mediaType: ext.toUpperCase() };
  if (ext === 'pdf') return { kind: 'pdf', mediaType: 'PDF' };
  if (MODEL_EXT.has(ext)) return { kind: 'model', mediaType: ext.toUpperCase() };
  if (ext === 'docx') return { kind: 'doc', mediaType: 'DOCX' };
  if (ext === 'pptx') return { kind: 'doc', mediaType: 'PPTX' };
  return null;
}

/**
 * Absolute path → a `pd-file://` URL the canvas media surfaces load bytes from.
 * The path becomes the URL's (percent-encoded) pathname so main can decode it
 * with `decodeURIComponent(url.pathname)` and realpath-fence it; each segment is
 * encoded individually so spaces / unicode / reserved chars survive but the `/`
 * separators stay intact.
 */
export function pdFileUrl(absPath: string): string {
  const encoded = absPath.split('/').map(encodeURIComponent).join('/');
  return `pd-file://f${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}
