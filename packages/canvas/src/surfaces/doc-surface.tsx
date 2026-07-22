import { Button, Spinner } from '@pi-desktop/ui';
import DOMPurify from 'dompurify';
import { unzipSync } from 'fflate';
import * as mammoth from 'mammoth';
import { type JSX, useEffect, useState } from 'react';

// `import * as mammoth from 'mammoth'` resolves the bare package, so Vite applies
// mammoth's `browser` field — it swaps the two node-only internals (unzip / file
// access) for browser shims, so no node builtins leak into the renderer chunk.
// (If a build ever surfaced a `Buffer`/`fs` leak the escape hatch is the
// pre-bundled standalone at `mammoth/mammoth.browser`, but that ships no types —
// this form keeps mammoth's `Result` typing, so we prefer it while it holds.)

/** The two Office formats this surface understands. */
type DocKind = 'docx' | 'pptx';

/** One rendered paragraph of a slide, carrying a STABLE render id (the slide's
 * zip path + its paragraph index) so React keys never fall back to a bare array
 * index — duplicate lines within a deck are common. */
interface PptxLine {
  id: string;
  text: string;
}

/** A single parsed slide: its 1-based position (the "Slide N" label) and the
 * non-empty text lines lifted from its `<a:t>` runs. */
interface PptxSlide {
  /** Stable, unique React key — the slide's path inside the .pptx zip. */
  id: string;
  /** 1-based position in the sorted deck (drives the "Slide N" caption). */
  number: number;
  lines: PptxLine[];
}

/**
 * The parsed document, ready to render. `docx` is a single sanitized HTML blob
 * (mammoth's conversion, DOMPurify'd); `pptx` is the foundation slide model — an
 * ordered list of slides, each a list of text lines. Discriminated on `kind` so
 * the render branch is exhaustive and type-narrowed.
 */
type ParsedDoc = { kind: 'docx'; html: string } | { kind: 'pptx'; slides: PptxSlide[] };

type Status = 'loading' | 'loaded' | 'error';

/** Slide parts live at `ppt/slides/slideN.xml` (the `_rels/…xml.rels` siblings
 * sit under `ppt/slides/_rels/`, so this anchored pattern never matches them). */
const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;

/** A DrawingML text run: `<a:t>…</a:t>`. Tolerant of attributes on the tag and of
 * runs that span newlines (`[\s\S]`), non-greedy so adjacent runs stay separate. */
const TEXT_RUN = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;

/** The lowercase file extension of a `pd-file://` URL (sans query/hash), upper-
 * cased — the fallback when the `type` hint isn't one we recognize. */
function extensionOf(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const path = src.split(/[?#]/)[0] ?? '';
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toUpperCase() : undefined;
}

/** Resolve the render path from the (upper-cased) `type` hint, falling back to
 * the src extension. Returns null for anything this surface can't preview. */
function resolveDocKind(type: string, src: string | undefined): DocKind | null {
  const hint = type.toUpperCase();
  if (hint === 'DOCX') return 'docx';
  if (hint === 'PPTX') return 'pptx';
  const ext = extensionOf(src);
  if (ext === 'DOCX') return 'docx';
  if (ext === 'PPTX') return 'pptx';
  return null;
}

/** The slide number baked into a `slideN.xml` path (for a numeric — not lexical —
 * sort, so slide2 precedes slide10). Non-matches sort first as 0. */
function slideNumber(path: string): number {
  const match = SLIDE_PATH.exec(path);
  return match ? Number(match[1]) : 0;
}

/** Decode the five predefined XML entities. `&amp;` is unescaped LAST so an input
 * like `&amp;lt;` resolves to the literal `&lt;` rather than being double-decoded
 * into `<`. */
function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Lift a slide's text into lines. Heuristic (foundation fidelity): each `<a:p>`
 * paragraph becomes one line, formed by concatenating that paragraph's `<a:t>`
 * runs in document order, then entity-decoding. We split the XML on the `</a:p>`
 * boundary so runs group by their owning paragraph; whitespace-only paragraphs
 * (layout spacers) are dropped so they don't render as blank `<p>`s.
 */
function extractSlideLines(xml: string, slideId: string): PptxLine[] {
  const lines: PptxLine[] = [];
  const paragraphs = xml.split('</a:p>');
  for (let i = 0; i < paragraphs.length; i += 1) {
    let text = '';
    // matchAll is self-contained per call, so the shared /g regex carries no
    // lastIndex state across paragraphs.
    for (const run of (paragraphs[i] ?? '').matchAll(TEXT_RUN)) {
      text += run[1] ?? '';
    }
    const decoded = decodeXmlEntities(text);
    if (decoded.trim().length > 0) {
      lines.push({ id: `${slideId}:${i}`, text: decoded });
    }
  }
  return lines;
}

/** Word path: mammoth → HTML → sanitize. mammoth inlines embedded images as
 * `data:` URIs, which DOMPurify keeps for `<img>` by default — so we DON'T pass a
 * restrictive `ALLOWED_URI_REGEXP` (that would strip them). `ADD_ATTR: ['target']`
 * preserves hyperlink targets that survive the html profile. */
async function parseDocx(arrayBuffer: ArrayBuffer): Promise<ParsedDoc> {
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
  });
  return { kind: 'docx', html: clean };
}

/** PowerPoint path: unzip, find + numerically order the slide parts, and pull the
 * text runs from each. Throws on a deck with no slides so it surfaces through the
 * shared error panel (there is nothing to preview). */
function parsePptx(arrayBuffer: ArrayBuffer): ParsedDoc {
  const files: Record<string, Uint8Array> = unzipSync(new Uint8Array(arrayBuffer));
  const slidePaths = Object.keys(files)
    .filter((path) => SLIDE_PATH.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (slidePaths.length === 0) {
    throw new Error('No slides found in presentation');
  }
  const decoder = new TextDecoder();
  const slides: PptxSlide[] = slidePaths.map((path, index) => {
    const bytes = files[path];
    const xml = bytes ? decoder.decode(bytes) : '';
    return { id: path, number: index + 1, lines: extractSlideLines(xml, path) };
  });
  return { kind: 'pptx', slides };
}

export interface DocSurfaceProps {
  /** pd-file:// URL to fetch the document bytes from (may be undefined). */
  src?: string;
  /** Upper-cased type hint: 'DOCX' | 'PPTX' (fallback: infer from src extension). */
  type: string;
  /** Bump to force a refetch of the same src. */
  reloadNonce?: number;
  onRefresh?: () => void;
  className?: string;
}

/**
 * DocSurface — the Office-document preview BODY (the header/operation bar lives
 * elsewhere, as with {@link MediaPreviewSurface}). It fetches the bytes once per
 * `src`/`reloadNonce`, then renders one of two paths:
 *
 *   • DOCX — mammoth converts the doc to HTML; we DOMPurify it (embedded images
 *     ride along as inlined `data:` URIs) and inject it via `dangerouslySetInner-
 *     HTML` inside a scrollable page. The sanitize is the trust boundary: this
 *     HTML lands INLINE in the app origin, so scripts/handlers must be stripped.
 *   • PPTX — a FOUNDATION render: unzip the deck, pull the `<a:t>` text runs from
 *     each `slideN.xml` (numerically ordered), and stack the slides as text cards.
 *     Richer visual fidelity comes later; this establishes real, offline slide
 *     text with zero network access.
 *
 * Loading shows a spinner; a missing src, an unsupported type, a failed fetch, or
 * a parse that throws all land on the shared "Try again" error panel. The fetch
 * is aborted and guarded on unmount/change so an in-flight load never setState()s
 * into a gone component.
 */
export function DocSurface({
  src,
  type,
  reloadNonce = 0,
  onRefresh,
  className,
}: DocSurfaceProps): JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [result, setResult] = useState<ParsedDoc | null>(null);
  // A specific error line (corrupt file vs. fetch failure vs. unsupported) so the
  // user can tell "the app broke" from "this file isn't a real .pptx".
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // `attempt` is the retry trigger: the [Try again] button bumps it to re-run the
  // fetch effect on the SAME src (like reloadNonce, but user-driven).
  const [attempt, setAttempt] = useState(0);

  // A new src, an external refresh (reloadNonce), or a retry (attempt) is a fresh
  // load. reloadNonce/attempt are trigger-only (never read in the body), so the
  // exhaustive-deps check is intentionally waived — as in the sibling surfaces.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on src/type/reload/retry.
  useEffect(() => {
    // No src → nothing to fetch; resolve straight to the error panel (a load that
    // never starts must not hang on a dead spinner).
    if (!src) {
      setStatus('error');
      setResult(null);
      return;
    }

    const kind = resolveDocKind(type, src);
    const controller = new AbortController();
    // A local flag in addition to the AbortController: setState after unmount is
    // the bug we're guarding, and abort alone can't stop the resolved-promise
    // microtask that follows arrayBuffer().
    let cancelled = false;
    setStatus('loading');
    setResult(null);

    void (async () => {
      try {
        if (!kind) {
          throw new Error(`Unsupported document type: ${type}`);
        }
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch document: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const parsed = kind === 'docx' ? await parseDocx(arrayBuffer) : parsePptx(arrayBuffer);
        if (cancelled) return;
        setResult(parsed);
        setStatus('loaded');
      } catch (err) {
        // An abort is an expected teardown, not a user-facing failure.
        if (cancelled || controller.signal.aborted) return;
        const m = err instanceof Error ? err.message : '';
        // A fetch failure is an app/permission problem; anything else here is a
        // decode failure — mammoth/fflate throwing means the bytes aren't a valid
        // OOXML package (corrupt, or a flat-XML export mislabeled .docx/.pptx).
        setErrorMsg(
          m.startsWith('Failed to fetch')
            ? 'Couldn’t load this file.'
            : kind
              ? `This ${kind.toUpperCase()} couldn’t be read — the file may be corrupt or not a valid Office document.`
              : m || 'Unsupported document.',
        );
        setResult(null);
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [src, type, reloadNonce, attempt]);

  const retry = (): void => {
    setStatus('loading');
    setErrorMsg(null);
    setAttempt((n) => n + 1);
    onRefresh?.();
  };

  const rootClass = ['pd-doc', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      {status === 'error' ? (
        <div className="pd-media-error" role="alert">
          <p className="pd-media-error-title">{errorMsg ?? 'Failed to load file content'}</p>
          <Button size="sm" variant="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : status === 'loading' || result === null ? (
        <div className="pd-media-status">
          <Spinner size={24} />
        </div>
      ) : result.kind === 'docx' ? (
        <div className="pd-doc-scroll pd-scroll">
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify-sanitized docx HTML (contract). */}
          <div className="pd-doc-page" dangerouslySetInnerHTML={{ __html: result.html }} />
        </div>
      ) : (
        <div className="pd-doc-scroll pd-scroll">
          {result.slides.map((slide) => (
            <section className="pd-doc-slide" key={slide.id}>
              <div className="pd-doc-slide-num">Slide {slide.number}</div>
              {slide.lines.length > 0 ? (
                slide.lines.map((line) => <p key={line.id}>{line.text}</p>)
              ) : (
                <p className="pd-doc-slide-empty">(no text)</p>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
