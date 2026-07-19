/**
 * Browser-backed web_search — the DuckDuckGo HTML scrape + the navigate → poll →
 * scrape flow (H1). Kept ELECTRON-FREE (no `electron`, no `app`) so the corp seam
 * wiring in corp-main.ts delegates here AND this stays unit-testable in the node
 * vitest env (the `electron/` tests may import only electron-free seam modules):
 * the in-page scrape is exercised against a jsdom document, and the flow against a
 * fake bridge.
 *
 * WHY (H1): the canvas browser visibly loaded REAL DuckDuckGo results, yet
 * web_search reported "0 results". The scrape ran BEFORE the results were in the
 * DOM — the navigate blocked on the full page `load` event, which for the DDG HTML
 * page drags on for tens of seconds AFTER the server-rendered results are already
 * present, so the `evaluate` fired against a page that was still "loading". The fix:
 *  - do NOT block on full page load — cap the navigate wait, then POLL the page for
 *    the results container (present the moment the document parses) up to a few
 *    seconds before scraping;
 *  - extract against the current `duckduckgo.com/html/` structure (`.result` rows,
 *    `a.result__a` titles, `.result__snippet` snippets) with tolerant fallbacks,
 *    decoding the `//duckduckgo.com/l/?uddg=` redirect to the real destination URL.
 */

/** The minimal bridge surface the search needs — the `request` slice of the
 * BrowserAgentClient (so a test can inject a fake bridge). */
export interface SearchBridge {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** One scraped hit, in the shape web-tools' {@link BrowserSearchFn} returns. */
export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Build the DuckDuckGo HTML results URL for a query (server-rendered results a
 * `browser_read`/scrape can extract; not bot-blocked the way a scraped backend is). */
export function ddgSearchUrl(query: string): string {
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

/**
 * In-page scrape for the browser-backed web_search: runs (via `evaluate`) on the
 * loaded DuckDuckGo HTML results page and returns the top hits as
 * `{title,url,snippet}`. DDG's HTML endpoint wraps each result link in a
 * `//duckduckgo.com/l/?uddg=<encoded>` redirect — decoded here so the returned URL
 * is the real destination (usable by web_fetch). Selectors are tolerant (a chain of
 * fallbacks) so a small markup drift still yields the visible hits. Pure string (an
 * `evaluate` script); never throws (guards + try/catch), returns [] if the shape
 * changes entirely. Testable: `new Function('document', 'return ' + script)(doc)`.
 */
export const DDG_SCRAPE_SCRIPT = String.raw`(() => {
  try {
    var decode = function (h) {
      try {
        var m = /[?&]uddg=([^&]+)/.exec(h || '');
        if (m) return decodeURIComponent(m[1]);
      } catch (e) {}
      if (h && h.indexOf('//') === 0) return 'https:' + h;
      return h || '';
    };
    var out = [];
    var nodes = document.querySelectorAll('.result, .web-result, .results_links, .results_links_deep');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // Skip DDG's own ad / no-result filler rows.
      if (el.className && /result--ad|result--no-result/.test(el.className)) continue;
      var a = el.querySelector('a.result__a') || el.querySelector('.result__title a') || el.querySelector('a[href]');
      if (!a) continue;
      var title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) continue;
      var sn = el.querySelector('.result__snippet') || el.querySelector('.result__snippet a');
      out.push({
        title: title,
        url: decode(a.getAttribute('href') || ''),
        snippet: sn ? (sn.textContent || '').replace(/\s+/g, ' ').trim() : '',
      });
      if (out.length >= 20) break;
    }
    return out;
  } catch (e) {
    return [];
  }
})()`;

/**
 * In-page readiness probe (H1): how many result containers are present RIGHT NOW.
 * The DDG HTML results are server-rendered, so they exist the moment the document
 * parses — well before the `load` event — which is exactly what lets the flow poll
 * for them instead of hanging on full load. Pure string; never throws.
 */
export const DDG_RESULTS_READY_SCRIPT = `(() => {
  try {
    return document.querySelectorAll('.result, .web-result, .results_links, .results_links_deep').length;
  } catch (e) {
    return 0;
  }
})()`;

/** Timing knobs for the search flow — all overridable (tests inject a fake clock). */
export interface BrowserSearchTiming {
  /** Cap on AWAITING the navigate before moving on to poll (ms). The navigate keeps
   * running in the background; we never block on full page load. Default 2500. */
  readonly navSettleMs?: number;
  /** Total time to poll the page for the results container (ms). Default 5000. */
  readonly resultsTimeoutMs?: number;
  /** Gap between readiness polls (ms). Default 250. */
  readonly pollIntervalMs?: number;
  /** Injectable sleep (tests pass a synchronous stub for determinism). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_NAV_SETTLE_MS = 2_500;
const DEFAULT_RESULTS_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Shape + clamp the raw scrape output into typed results (drops non-object / untitled
 * rows, coerces url/snippet, keeps at most `count`). Pure + unit-tested.
 */
export function shapeSearchResults(raw: unknown, count: number): SearchResult[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .filter(
      (r): r is { title: string; url?: string; snippet?: string } =>
        r !== null && typeof r === 'object' && typeof (r as { title?: unknown }).title === 'string',
    )
    .slice(0, Math.max(0, count))
    .map((r) => ({
      title: String(r.title),
      url: String(r.url ?? ''),
      snippet: String(r.snippet ?? ''),
    }));
}

/**
 * Await `p`, but give up after `ms` — resolving (never rejecting) so a slow navigate
 * (blocked on the full `load` event) can NEVER wedge the search. The losing navigate
 * keeps running in the background; its eventual failure is swallowed so it can't
 * surface as an unhandled rejection.
 */
async function settleWithin(
  p: Promise<unknown>,
  ms: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const guarded = p.then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([guarded, sleep(ms)]);
}

/**
 * Build the browser-backed `web_search` (H1) over a bridge: NAVIGATE the canvas
 * browser to the DDG HTML results (the user watches it live), POLL for the
 * server-rendered results container without blocking on full page load, then scrape
 * the visible hits. Returns [] on any bridge error (the web_search tool then falls
 * back to its configured scrape backend). The returned fn matches web-tools'
 * `BrowserSearchFn`.
 */
export function createBrowserSearch(
  bridge: SearchBridge,
  timing: BrowserSearchTiming = {},
): (query: string, count: number) => Promise<SearchResult[]> {
  const navSettleMs = timing.navSettleMs ?? DEFAULT_NAV_SETTLE_MS;
  const resultsTimeoutMs = timing.resultsTimeoutMs ?? DEFAULT_RESULTS_TIMEOUT_MS;
  const pollIntervalMs = timing.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = timing.sleep ?? realSleep;
  // Poll a fixed number of times (derived from the timeout) so the loop is bounded
  // and deterministic under an injected clock (no reliance on wall-clock advancing).
  const maxPolls = Math.max(1, Math.ceil(resultsTimeoutMs / Math.max(1, pollIntervalMs)));

  return async (query: string, count: number): Promise<SearchResult[]> => {
    // Kick off navigation but do NOT block on full page load — cap the wait, then poll.
    await settleWithin(
      bridge.request('navigate', { url: ddgSearchUrl(query) }),
      navSettleMs,
      sleep,
    );

    // Poll the page for the results container (present as soon as the doc parses).
    for (let i = 0; i < maxPolls; i++) {
      let ready = 0;
      try {
        ready = Number(await bridge.request('evaluate', { script: DDG_RESULTS_READY_SCRIPT })) || 0;
      } catch {
        ready = 0;
      }
      if (ready > 0) break;
      if (i < maxPolls - 1) await sleep(pollIntervalMs);
    }

    // Scrape (even if the poll never saw results — the page may still carry partial
    // hits, and returning what is there beats returning nothing).
    let raw: unknown = [];
    try {
      raw = await bridge.request('evaluate', { script: DDG_SCRAPE_SCRIPT });
    } catch {
      raw = [];
    }
    return shapeSearchResults(raw, count);
  };
}
