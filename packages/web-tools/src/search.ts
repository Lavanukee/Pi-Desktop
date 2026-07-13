/**
 * web_search backends behind one `SearchBackend` interface.
 *
 * Per plan §E: DuckDuckGo HTML parsing is the zero-config floor; the Brave
 * Search API is the opt-in "power" backend (key via config / PI_BRAVE_API_KEY);
 * Tavily is an optional stub behind the same interface. Backend selection puts
 * the configured primary first and always keeps DDG as the fallback floor, so a
 * failing/empty primary degrades gracefully instead of failing the tool.
 *
 * Fetching and parsing are separated: the parsers are pure functions unit-tested
 * against captured fixtures (no live network in unit tests); `fetchImpl` is
 * injectable for the same reason.
 */
import { parseHTML } from 'linkedom';

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchRequest {
  readonly count: number;
  readonly signal?: AbortSignal;
}

export interface SearchBackend {
  readonly name: string;
  /** Never throws for empty results; throws only on transport/HTTP failure so the caller can fall back. */
  search(query: string, req: SearchRequest): Promise<SearchResult[]>;
}

/** Hard ceiling on results regardless of what the caller asks for. */
export const MAX_RESULTS = 20;
export const DEFAULT_RESULTS = 8;

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

export function boundCount(requested: number | undefined): number {
  const n = requested ?? DEFAULT_RESULTS;
  if (!Number.isFinite(n)) return DEFAULT_RESULTS;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_RESULTS);
}

interface BackendDeps {
  readonly fetchImpl?: typeof fetch;
}

// --- DuckDuckGo HTML backend (default, zero-config) ------------------------

/**
 * DDG's public HTML endpoints. Requests are POSTed (the form's native method) —
 * a plain GET is far more likely to be met with the 202/403 anti-bot challenge,
 * whereas the form POST returns the real results page. `html/` is the rich
 * primary; `lite/` is a leaner, more permissive fallback with the same content
 * behind a different (table-based) markup, so a challenge on one still yields
 * results from the other before the floor gives up.
 */
const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DDG_LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';

const DDG_HEADERS: Record<string, string> = {
  'user-agent': DEFAULT_UA,
  'content-type': 'application/x-www-form-urlencoded',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  referer: 'https://duckduckgo.com/',
};

/** Decode DDG's redirect wrapper (`//duckduckgo.com/l/?uddg=<enc>&rut=...`). */
function decodeDdgHref(href: string): string | undefined {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m?.[1] !== undefined) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return undefined;
    }
  }
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  return undefined;
}

function textOf(el: { textContent?: string | null } | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

interface ParsedEl {
  textContent?: string | null;
  getAttribute(n: string): string | null;
  querySelector(sel: string): ParsedEl | null;
  closest?(sel: string): ParsedEl | null;
  nextElementSibling?: ParsedEl | null;
}

/**
 * Pure parser for the `html.duckduckgo.com/html/` results page. Tolerant of both
 * the current markup (a direct `https://…` href on `a.result__a`) and the legacy
 * `//duckduckgo.com/l/?uddg=` redirect wrapper. Sponsored `result--ad` blocks are
 * dropped so paid rows never masquerade as organic results.
 */
export function parseDuckDuckGoHtml(html: string, count: number): SearchResult[] {
  const { document } = parseHTML(html);
  const out: SearchResult[] = [];
  const blocks = Array.from(document.querySelectorAll('div.result')) as ParsedEl[];
  for (const block of blocks) {
    const cls = block.getAttribute('class') ?? '';
    if (/\bresult--ad\b/.test(cls)) continue; // sponsored row
    const anchor = block.querySelector('a.result__a');
    if (anchor === null) continue; // ad / empty / "no results" rows
    const href = anchor.getAttribute('href') ?? '';
    const url = decodeDdgHref(href);
    if (url === undefined) continue;
    const title = textOf(anchor);
    if (title.length === 0) continue;
    const snippet = textOf(block.querySelector('a.result__snippet'));
    out.push({ title, url, snippet });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Pure parser for the `lite.duckduckgo.com/lite/` results table: each result is
 * an `a.result-link` (direct href) whose snippet lives in a following row's
 * `td.result-snippet` cell.
 */
export function parseDuckDuckGoLite(html: string, count: number): SearchResult[] {
  const { document } = parseHTML(html);
  const out: SearchResult[] = [];
  const anchors = Array.from(document.querySelectorAll('a.result-link')) as ParsedEl[];
  for (const anchor of anchors) {
    const url = decodeDdgHref(anchor.getAttribute('href') ?? '');
    if (url === undefined) continue;
    const title = textOf(anchor);
    if (title.length === 0) continue;
    // Snippet sits in one of the next few rows' `.result-snippet` cell.
    let snippet = '';
    let row = anchor.closest?.('tr')?.nextElementSibling ?? null;
    for (let i = 0; i < 3 && row != null; i++) {
      const cell = row.querySelector('td.result-snippet') ?? row.querySelector('.result-snippet');
      if (cell !== null) {
        snippet = textOf(cell);
        break;
      }
      row = row.nextElementSibling ?? null;
    }
    out.push({ title, url, snippet });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Recognise DDG's anti-bot / rate-limit interstitial, which it sometimes serves
 * with a 2xx status (so a status check alone misses it). Callers treat a matched
 * page as "blocked" rather than a genuine empty result set.
 */
export function isDuckDuckGoChallenge(html: string): boolean {
  return /anomaly-modal|challenge-form|bots use duckduckgo|If this error persists/i.test(html);
}

interface DdgEndpoint {
  readonly label: string;
  readonly url: string;
  readonly parse: (html: string, count: number) => SearchResult[];
}

const DDG_ENDPOINTS: readonly DdgEndpoint[] = [
  { label: 'html', url: DDG_HTML_ENDPOINT, parse: parseDuckDuckGoHtml },
  { label: 'lite', url: DDG_LITE_ENDPOINT, parse: parseDuckDuckGoLite },
];

export function duckDuckGoBackend(deps: BackendDeps = {}): SearchBackend {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    name: 'duckduckgo',
    async search(query, req) {
      const body = new URLSearchParams({ q: query, kl: 'wt-wt' }).toString();
      // POST the query to each endpoint in turn. A challenge/blocked page on one
      // is skipped so the next can answer; only when NONE returns a usable page
      // do we throw, so the caller records a note ("rate-limited") instead of a
      // silent, unexplained empty result set.
      let sawUsablePage = false;
      let lastStatus = 0;
      for (const ep of DDG_ENDPOINTS) {
        let res: Response;
        try {
          res = await doFetch(ep.url, {
            method: 'POST',
            headers: DDG_HEADERS,
            body,
            signal: req.signal,
          });
        } catch (err) {
          if (req.signal?.aborted) throw err; // honour cancellation
          lastStatus = 0;
          continue; // transport error on one endpoint — try the next
        }
        lastStatus = res.status;
        if (!res.ok) continue; // 202/403 anti-bot challenge
        const html = await res.text();
        if (isDuckDuckGoChallenge(html)) continue;
        sawUsablePage = true;
        const results = ep.parse(html, req.count);
        if (results.length > 0) return results;
      }
      if (!sawUsablePage) {
        throw new Error(
          `DuckDuckGo served no usable results page (last status ${
            lastStatus || 'network error'
          }); it may be rate-limiting automated requests`,
        );
      }
      return []; // reached a clean page that genuinely had no results
    },
  };
}

// --- Brave Search API backend (opt-in "power" option) ----------------------

interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

/** Pure parser for the Brave Search API web results JSON. */
export function parseBraveJson(raw: unknown, count: number): SearchResult[] {
  const body = raw as BraveResponse;
  const results = body.web?.results ?? [];
  const out: SearchResult[] = [];
  for (const r of results) {
    if (typeof r.url !== 'string' || r.url.length === 0) continue;
    out.push({
      title: (r.title ?? '').replace(/\s+/g, ' ').trim(),
      url: r.url,
      // Brave descriptions include <strong> highlight markup; strip tags.
      snippet: (r.description ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    });
    if (out.length >= count) break;
  }
  return out;
}

export function braveBackend(apiKey: string, deps: BackendDeps = {}): SearchBackend {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    name: 'brave',
    async search(query, req) {
      const url =
        'https://api.search.brave.com/res/v1/web/search' +
        `?q=${encodeURIComponent(query)}&count=${req.count}`;
      const res = await doFetch(url, {
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip',
          'x-subscription-token': apiKey,
        },
        signal: req.signal,
      });
      if (!res.ok) {
        throw new Error(`Brave Search HTTP ${res.status} ${res.statusText}`);
      }
      return parseBraveJson(await res.json(), req.count);
    },
  };
}

// --- Tavily backend (optional stub, same interface) ------------------------

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

export function parseTavilyJson(raw: unknown, count: number): SearchResult[] {
  const body = raw as TavilyResponse;
  const out: SearchResult[] = [];
  for (const r of body.results ?? []) {
    if (typeof r.url !== 'string' || r.url.length === 0) continue;
    out.push({
      title: (r.title ?? '').trim(),
      url: r.url,
      snippet: (r.content ?? '').replace(/\s+/g, ' ').trim(),
    });
    if (out.length >= count) break;
  }
  return out;
}

export function tavilyBackend(apiKey: string, deps: BackendDeps = {}): SearchBackend {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    name: 'tavily',
    async search(query, req) {
      const res = await doFetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: req.count,
          search_depth: 'basic',
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new Error(`Tavily HTTP ${res.status} ${res.statusText}`);
      return parseTavilyJson(await res.json(), req.count);
    },
  };
}

// --- Selection + health fallback -------------------------------------------

export type BackendName = 'auto' | 'duckduckgo' | 'brave' | 'tavily';

export interface WebSearchConfig {
  readonly braveApiKey?: string;
  readonly tavilyApiKey?: string;
  /** Force a backend; "auto" picks the best available (Brave > Tavily > DDG). */
  readonly backend?: BackendName;
  /** Injected for tests / proxies. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Read a {@link WebSearchConfig} from environment variables. */
export function webSearchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebSearchConfig {
  const backend = env.PI_WEB_SEARCH_BACKEND;
  return {
    braveApiKey: env.PI_BRAVE_API_KEY || undefined,
    tavilyApiKey: env.PI_TAVILY_API_KEY || undefined,
    backend: isBackendName(backend) ? backend : 'auto',
  };
}

function isBackendName(v: string | undefined): v is BackendName {
  return v === 'auto' || v === 'duckduckgo' || v === 'brave' || v === 'tavily';
}

/**
 * Resolve the ordered backend chain: the configured/available primary first,
 * DuckDuckGo always last as the floor (deduped when it is already primary).
 */
export function resolveSearchBackends(config: WebSearchConfig): SearchBackend[] {
  const deps: BackendDeps = { fetchImpl: config.fetchImpl };
  const ddg = duckDuckGoBackend(deps);
  const chain: SearchBackend[] = [];
  const want = config.backend ?? 'auto';

  const brave = config.braveApiKey ? braveBackend(config.braveApiKey, deps) : undefined;
  const tavily = config.tavilyApiKey ? tavilyBackend(config.tavilyApiKey, deps) : undefined;

  if (want === 'brave' && brave) chain.push(brave);
  else if (want === 'tavily' && tavily) chain.push(tavily);
  else if (want === 'auto') {
    if (brave) chain.push(brave);
    else if (tavily) chain.push(tavily);
  }
  // "duckduckgo", or any selection whose key was missing, falls to the floor.
  chain.push(ddg);
  return chain;
}

export interface WebSearchOutcome {
  readonly results: SearchResult[];
  /** Name of the backend whose results were returned. */
  readonly backend: string;
  /** Non-fatal note (e.g. a primary backend failed and we fell back). */
  readonly note?: string;
}

/**
 * Run the search across the backend chain. Returns the first non-empty result
 * set; on a thrown backend it records a note and tries the next. Never throws —
 * the worst case is an empty result set from the floor with an explanatory note.
 */
export async function runWebSearch(
  backends: readonly SearchBackend[],
  query: string,
  req: SearchRequest,
): Promise<WebSearchOutcome> {
  const notes: string[] = [];
  let lastBackend = backends.at(-1)?.name ?? 'none';
  for (let i = 0; i < backends.length; i++) {
    const backend = backends[i];
    if (backend === undefined) continue;
    lastBackend = backend.name;
    try {
      const results = await backend.search(query, req);
      if (results.length > 0) {
        return {
          results,
          backend: backend.name,
          note: notes.length ? notes.join('; ') : undefined,
        };
      }
      if (i < backends.length - 1)
        notes.push(`${backend.name} returned no results, trying fallback`);
    } catch (err) {
      if (i < backends.length - 1) {
        notes.push(`${backend.name} failed (${errMessage(err)}), falling back`);
      } else {
        notes.push(`${backend.name} failed (${errMessage(err)})`);
      }
    }
  }
  return { results: [], backend: lastBackend, note: notes.length ? notes.join('; ') : undefined };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
