import DOMPurify from 'dompurify';

/**
 * DOMPurify trust boundaries for the canvas.
 *
 * Threat model: artifact content is LLM-generated and therefore UNTRUSTED. Two
 * boundaries exist, and they are deliberately different:
 *
 *  1. SVG surface — `sanitizeSvg`. SVG is rendered INLINE, in the app's own
 *     renderer document/origin. Inline SVG can carry `<script>`, event handlers
 *     (`onload`), `<foreignObject>` (arbitrary HTML), and `javascript:`/external
 *     `href`s — any of which would execute in the app origin (full XSS: access
 *     to the preload bridge, IPC, session data). So SVG MUST be DOMPurify-
 *     sanitized to strip all script vectors before it touches the app DOM. This
 *     is a HARD boundary — there is no sandbox behind it.
 *
 *  2. HTML surface — the sandboxed iframe (`allow-scripts` WITHOUT
 *     `allow-same-origin`). Here scripts are INTENTIONALLY allowed (interactive
 *     HTML/games are the whole point) and the containment boundary is the frame
 *     sandbox + CSP `frame-src`, NOT DOMPurify. Stripping scripts there would
 *     defeat the feature. See `html-surface.tsx` for that boundary's docs.
 *     `sanitizeHtmlStatic` below is the OTHER html path: a script-stripping pass
 *     for when untrusted HTML must be shown WITHOUT a sandbox (static preview,
 *     or HTML embedded directly into app DOM). Never feed sandbox-bound
 *     interactive HTML through it.
 */

let purifier: typeof DOMPurify | undefined;

function getPurifier(): typeof DOMPurify {
  if (purifier) return purifier;
  if (typeof window === 'undefined') {
    throw new Error('@pi-desktop/canvas sanitizers require a DOM (window).');
  }
  // Bind to the live window lazily so importing the package in a DOM-less
  // context (e.g. the Electron main process) does not throw at import time.
  purifier = DOMPurify(window);
  return purifier;
}

/**
 * Sanitize SVG markup for INLINE rendering in the app origin. Keeps drawing
 * elements/filters; removes `<script>`, `<foreignObject>`, event-handler
 * attributes, and non-safe URIs. Safe to `innerHTML` into an app element.
 *
 * Streaming-safe: partial/incomplete SVG (unclosed tags mid-stream) is accepted
 * — the parser auto-closes and this returns the sanitized prefix, so callers can
 * sanitize the growing buffer every frame.
 */
export function sanitizeSvg(markup: string): string {
  return getPurifier().sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // foreignObject is an HTML smuggling vector even under the svg profile.
    FORBID_TAGS: ['foreignObject', 'script'],
    FORBID_ATTR: ['xlink:href'],
  });
}

/**
 * Sanitize HTML for NON-sandboxed embedding: strips `<script>`, event handlers,
 * and `javascript:`/`data:` script URIs, keeping structural/markup content.
 * Use ONLY when HTML must render without the iframe sandbox. Interactive HTML
 * bound for the sandboxed harness must NOT pass through here.
 */
export function sanitizeHtmlStatic(markup: string): string {
  return getPurifier().sanitize(markup, {
    FORBID_TAGS: ['script'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    ADD_ATTR: ['target'],
  });
}
