/**
 * Additive registration of the generation image surface on the canvas surface
 * registry. Nothing here edits the canvas core (round-12): it calls the public
 * `registerSurface` with a NEW `gen-image` kind at a high priority so it wins
 * over any generic image matcher, and returns an unregister fn.
 *
 * Data travels on the artifact as JSON in `content.text` (the open ArtifactKind
 * model is designed for exactly this), encoded/decoded by the helpers here.
 */
import {
  type ArtifactContent,
  defaultSurfaceRegistry,
  matchKind,
  registerSurface,
  type SurfaceProps,
  type SurfaceRegistry,
} from '@pi-desktop/canvas';
import { GenImageSurface, type GenImageSurfaceData } from './gen-image-surface.tsx';

/** The canvas artifact kind for a generation image surface. */
export const GEN_IMAGE_KIND = 'gen-image';
const GEN_IMAGE_MIME = 'application/x-pi-gen-image+json';

/** Encode surface data into a canvas artifact content payload. */
export function genImageContent(data: GenImageSurfaceData): ArtifactContent {
  return { kind: GEN_IMAGE_KIND, text: JSON.stringify(data), mimeType: GEN_IMAGE_MIME };
}

/** Decode + lightly validate surface data from an artifact content, or null. */
export function parseGenImageData(content: ArtifactContent): GenImageSurfaceData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const data = parsed as Partial<GenImageSurfaceData>;
  if (
    data.model === undefined ||
    typeof data.model.id !== 'string' ||
    typeof data.model.label !== 'string' ||
    typeof data.model.license !== 'string' ||
    !Array.isArray(data.candidates)
  ) {
    return null;
  }
  return data as GenImageSurfaceData;
}

/** Surface adapter: parse the artifact payload → the pure surface component. */
function GenImageSurfaceAdapter({ content }: SurfaceProps) {
  const data = parseGenImageData(content);
  if (data === null) {
    return <div className="pd-gen-error">Invalid generation data</div>;
  }
  return <GenImageSurface data={data} />;
}

/**
 * Register the generation image surface. Returns an unregister function.
 * `canStream: true` — step previews stream in progressively as the job runs.
 */
export function registerGenImageSurface(
  registry: SurfaceRegistry = defaultSurfaceRegistry,
): () => void {
  return registry.register({
    kind: GEN_IMAGE_KIND,
    canStream: true,
    opensInCanvas: true,
    priority: 10, // outrank any generic image matcher
    match: matchKind(GEN_IMAGE_KIND),
    component: GenImageSurfaceAdapter,
  });
}

/** Convenience: register on the process-wide default registry. */
export function registerGenSurfacesDefault(): () => void {
  return registerSurface({
    kind: GEN_IMAGE_KIND,
    canStream: true,
    opensInCanvas: true,
    priority: 10,
    match: matchKind(GEN_IMAGE_KIND),
    component: GenImageSurfaceAdapter,
  });
}
