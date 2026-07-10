import {
  defaultSurfaceRegistry,
  matchKind,
  type SurfaceProps,
  type SurfaceRegistry,
} from '../registry.ts';
import { CodeSurface } from './code-surface.tsx';
import { FileSurface } from './file-surface.tsx';
import { HtmlSurface } from './html-surface.tsx';
import { MarkdownSurface } from './markdown-surface.tsx';
import { MediaPreviewSurface } from './media-preview-surface.tsx';
import { SvgSurface } from './svg-surface.tsx';

/**
 * Adapt an image/pdf artifact to the media preview surface: `content.text` is
 * the src (URL / data: URI), the type comes from the mime subtype or the kind.
 */
function MediaSurfaceAdapter({ content }: SurfaceProps) {
  const subtype = content.mimeType?.split('/')[1];
  const type = (subtype ?? content.kind).toUpperCase();
  return <MediaPreviewSurface src={content.text} type={type} />;
}

/** Adapt a file artifact (code/markdown/text) to the file viewer surface. */
function FileSurfaceAdapter({ content, streaming, onCopy }: SurfaceProps) {
  return <FileSurface content={content} streaming={streaming} onCopy={onCopy} />;
}

/**
 * Register the built-in surfaces on a registry. Returns an unregister function.
 * `opensInCanvas` encodes the default inline-vs-canvas routing: svg/html are
 * inline-eligible when small; everything else (code/markdown/image/pdf/file)
 * opens in the canvas. The `enum + registry` stays open — future surfaces
 * (video/3d/…) register the same way without touching this.
 */
export function registerBuiltinSurfaces(
  registry: SurfaceRegistry = defaultSurfaceRegistry,
): () => void {
  const unregisters = [
    registry.register({
      kind: 'code',
      canStream: true,
      opensInCanvas: true,
      match: matchKind('code'),
      component: CodeSurface,
    }),
    registry.register({
      kind: 'markdown',
      canStream: true,
      opensInCanvas: true,
      match: matchKind('markdown'),
      component: MarkdownSurface,
    }),
    registry.register({
      kind: 'html',
      canStream: true,
      opensInCanvas: false,
      match: matchKind('html'),
      component: HtmlSurface,
    }),
    registry.register({
      kind: 'svg',
      canStream: true,
      opensInCanvas: false,
      match: matchKind('svg'),
      component: SvgSurface,
    }),
    registry.register({
      kind: 'image',
      canStream: false,
      opensInCanvas: true,
      match: matchKind('image'),
      component: MediaSurfaceAdapter,
    }),
    registry.register({
      kind: 'pdf',
      canStream: false,
      opensInCanvas: true,
      match: matchKind('pdf'),
      component: MediaSurfaceAdapter,
    }),
    registry.register({
      kind: 'file',
      canStream: true,
      opensInCanvas: true,
      match: matchKind('file'),
      component: FileSurfaceAdapter,
    }),
  ];
  return () => {
    for (const unregister of unregisters) unregister();
  };
}

let defaultsRegistered = false;

/** Idempotently register the built-ins on the process-wide default registry. */
export function ensureDefaultSurfaces(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;
  registerBuiltinSurfaces(defaultSurfaceRegistry);
}
