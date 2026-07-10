/**
 * Renders a connector's mark inside the gallery's icon boxes: the real,
 * self-contained inline brand SVG (`connector.iconSvg`) when present — a
 * published brand glyph for known brands, a neutral category glyph otherwise —
 * else the emoji `icon` as a last resort.
 *
 * The SVG is monochrome (`fill`/`stroke: currentColor`), so it inherits the
 * box's text color and reads on both light and dark. The markup is trusted: it
 * originates from the in-repo connector catalog (packages/mcp-lite), never user
 * input or the network.
 */
import type { KnownConnector } from '@pi-desktop/mcp-lite';

export function ConnectorIcon({
  connector,
  size,
}: {
  connector: Pick<KnownConnector, 'icon' | 'iconSvg' | 'name'>;
  /** Rendered mark size in px (the enclosing box supplies its own footprint). */
  size: number;
}) {
  if (connector.iconSvg !== undefined && connector.iconSvg.length > 0) {
    return (
      <span
        className="inline-flex items-center justify-center"
        style={{ width: size, height: size }}
        data-testid="connector-icon-svg"
        aria-hidden
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, self-contained brand SVG from the in-repo connector catalog (no user/network input)
        dangerouslySetInnerHTML={{ __html: connector.iconSvg }}
      />
    );
  }
  return <span aria-hidden>{connector.icon}</span>;
}
