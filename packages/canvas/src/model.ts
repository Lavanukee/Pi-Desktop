/**
 * The typed artifact model shared by every canvas surface.
 *
 * `ArtifactKind` is intentionally OPEN: the four kinds shipped in W7 are named
 * for autocomplete, but the `(string & {})` tail keeps the type assignable from
 * any string so future surfaces (image | video | 3d | browser | …) register
 * without a breaking change to this union or to the registry.
 */
export type KnownArtifactKind = 'code' | 'markdown' | 'html' | 'svg' | 'image' | 'pdf' | 'file';

// The `& {}` intersection is the canonical "open string union" trick: it preserves
// literal autocomplete for the known kinds while still accepting any future string
// kind, so new surfaces (image/video/3d/browser) register without a breaking change.
export type ArtifactKind = KnownArtifactKind | (string & {});

/**
 * The renderable payload of an artifact. Surfaces receive exactly this (plus
 * streaming state) — never the full `Artifact` — so a surface can be reused
 * outside the panel with only its content.
 */
export interface ArtifactContent {
  kind: ArtifactKind;
  /** Raw text: source code, markdown source, HTML document, or SVG markup. */
  text: string;
  /**
   * Language id for the code surface (`javascript` | `typescript` | `html` |
   * `css` | `python` | `markdown` | …). Ignored by non-code surfaces.
   */
  language?: string;
  /** MIME hint when known (e.g. `text/html`, `image/svg+xml`). */
  mimeType?: string;
}

/**
 * A canvas artifact. `content.kind` drives surface resolution; `filename`
 * (when present) feeds language inference and export naming.
 */
export interface Artifact {
  id: string;
  title?: string;
  filename?: string;
  content: ArtifactContent;
  /** Free-form bag for surfaces we haven't built yet; never read by the core. */
  metadata?: Record<string, unknown>;
}
