/**
 * web_fetch: native fetch → readability → turndown → markdown.
 *
 * Replaces RemotePi's `execSync(curl)` + regex tag-stripping with a real
 * extraction pipeline: linkedom parses the HTML into a DOM, @mozilla/readability
 * isolates the article, turndown renders it to markdown. Scripts/styles are
 * removed up front so nothing executable leaks even on the fallback path.
 *
 * The fetch is bounded on every axis: AbortSignal timeout, a download byte cap
 * (streamed, so we stop reading a hostile 10GB page early), redirects followed
 * but the final URL reported back, and the markdown output length-capped.
 *
 * `htmlToMarkdown` is pure (unit-tested on a fixture); `fetchReadable` wraps it
 * with the bounded fetch.
 */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5_000_000;
export const DEFAULT_MAX_MARKDOWN_CHARS = 40_000;

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

export interface HtmlToMarkdownResult {
  readonly title: string;
  readonly markdown: string;
  readonly truncated: boolean;
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  // Belt-and-braces: drop anything non-content turndown might otherwise keep.
  td.remove(['script', 'style', 'noscript', 'template', 'iframe']);
  return td;
}

/** Convert an HTML string to article markdown. Pure; no network. */
export function htmlToMarkdown(
  html: string,
  opts: { maxChars?: number } = {},
): HtmlToMarkdownResult {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_MARKDOWN_CHARS;
  const { document } = parseHTML(html);

  // Strip executable / presentational nodes before extraction.
  for (const el of Array.from(document.querySelectorAll('script, style, noscript, template'))) {
    (el as { remove(): void }).remove();
  }

  let title = '';
  let contentHtml = '';
  try {
    // Readability mutates its document, so hand it the already-parsed DOM.
    const article = new Readability(document as never, { charThreshold: 100 }).parse();
    if (article) {
      title = article.title ?? '';
      contentHtml = article.content ?? '';
    }
  } catch {
    // Readability can throw on pathological markup — fall back to raw body.
  }

  if (contentHtml.trim().length === 0) {
    const doc = document as { title?: string; body?: { innerHTML?: string } };
    title = title || doc.title || '';
    contentHtml = doc.body?.innerHTML ?? html;
  }

  let markdown = makeTurndown().turndown(contentHtml).trim();
  let truncated = false;
  if (markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars);
    truncated = true;
  }
  return { title: title.trim(), markdown, truncated };
}

export interface FetchReadableOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxMarkdownChars?: number;
  readonly userAgent?: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface FetchReadableResult {
  readonly title: string;
  /** Final URL after redirects. */
  readonly url: string;
  readonly markdown: string;
  /** True if the download or the markdown output was capped. */
  readonly truncated: boolean;
}

/** Fetch a URL and return extracted markdown. Throws on HTTP/transport failure. */
export async function fetchReadable(
  url: string,
  opts: FetchReadableOptions = {},
): Promise<FetchReadableResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxMarkdownChars = opts.maxMarkdownChars ?? DEFAULT_MAX_MARKDOWN_CHARS;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const doFetch = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await doFetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const finalUrl = res.url || url;
    const { text, truncated: downloadTruncated } = await readBodyCapped(res, maxBytes);
    const {
      title,
      markdown,
      truncated: mdTruncated,
    } = htmlToMarkdown(text, {
      maxChars: maxMarkdownChars,
    });
    return { title, url: finalUrl, markdown, truncated: downloadTruncated || mdTruncated };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (body === null) {
    const t = await res.text();
    const truncated = t.length > maxBytes;
    return { text: truncated ? t.slice(0, maxBytes) : t, truncated };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(Buffer.from(value));
      total += value.length;
      if (total >= maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const buf = Buffer.concat(chunks);
  const sliced = truncated ? buf.subarray(0, maxBytes) : buf;
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(sliced), truncated };
}
