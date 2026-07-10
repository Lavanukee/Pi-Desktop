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

/** Pure parser for the `html.duckduckgo.com/html/` results page. */
export function parseDuckDuckGoHtml(html: string, count: number): SearchResult[] {
  const { document } = parseHTML(html);
  const out: SearchResult[] = [];
  const blocks = Array.from(document.querySelectorAll('div.result')) as Array<{
    querySelector(
      sel: string,
    ): { textContent?: string | null; getAttribute(n: string): string | null } | null;
  }>;
  for (const block of blocks) {
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

export function duckDuckGoBackend(deps: BackendDeps = {}): SearchBackend {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    name: 'duckduckgo',
    async search(query, req) {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await doFetch(url, {
        headers: { 'user-agent': DEFAULT_UA, accept: 'text/html' },
        signal: req.signal,
      });
      // DDG occasionally serves an anti-bot page (non-200); treat as "no results"
      // rather than throwing, since DDG is the floor and there is nowhere to fall.
      if (!res.ok) return [];
      const html = await res.text();
      return parseDuckDuckGoHtml(html, req.count);
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
