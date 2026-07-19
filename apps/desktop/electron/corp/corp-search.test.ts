import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  createBrowserSearch,
  DDG_RESULTS_READY_SCRIPT,
  DDG_SCRAPE_SCRIPT,
  ddgSearchUrl,
  type SearchBridge,
  type SearchResult,
  shapeSearchResults,
} from './corp-search';

// ── the in-page scrape, against real-shaped DDG HTML markup (jsdom) ──────────

/** A slimmed but faithful `duckduckgo.com/html/` results fragment: `.result` rows
 * with `a.result__a` titles wrapped in the `//duckduckgo.com/l/?uddg=` redirect and
 * `.result__snippet` snippets, plus an ad row that must be skipped and a direct
 * (non-redirect) protocol-relative link. `&amp;` mirrors the raw HTML entity DDG
 * emits (jsdom decodes it to `&` on getAttribute). */
const SAMPLE_DDG_HTML = `<!doctype html><html><body>
  <div class="result result--ad">
    <a class="result__a" href="//duckduckgo.com/y.js?ad=1">SPONSORED — buy stuff</a>
    <a class="result__snippet">an ad we must skip</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2F&amp;rut=deadbeef">MDN Web Docs</a>
    </h2>
    <a class="result__snippet">Resources for developers, by developers.</a>
  </div>
  <div class="result results_links web-result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FDuckDuckGo">DuckDuckGo - Wikipedia</a>
    <a class="result__snippet">A privacy-focused search engine.</a>
  </div>
  <div class="result web-result">
    <a class="result__a" href="//example.org/direct">Direct protocol-relative link</a>
  </div>
</body></html>`;

/** Run the browser-executed scrape string against a jsdom document, exactly the way
 * `webContents.executeJavaScript(script)` would (`document` is the page global; here
 * it is the injected jsdom document via `new Function`'s parameter). */
function runScrape(html: string): SearchResult[] {
  const doc = new JSDOM(html).window.document;
  const runner = new Function('document', `return ${DDG_SCRAPE_SCRIPT};`) as (
    d: Document,
  ) => SearchResult[];
  return runner(doc);
}

function runReady(html: string): number {
  const doc = new JSDOM(html).window.document;
  const runner = new Function('document', `return ${DDG_RESULTS_READY_SCRIPT};`) as (
    d: Document,
  ) => number;
  return runner(doc);
}

describe('DDG_SCRAPE_SCRIPT — extracts the visible hits from current DDG HTML', () => {
  it('pulls title + decoded url + snippet for each real result', () => {
    const results = runScrape(SAMPLE_DDG_HTML);
    // The ad row is skipped; the three real results remain.
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: 'MDN Web Docs',
      url: 'https://developer.mozilla.org/en-US/',
      snippet: 'Resources for developers, by developers.',
    });
    expect(results[1]?.title).toBe('DuckDuckGo - Wikipedia');
    expect(results[1]?.url).toBe('https://en.wikipedia.org/wiki/DuckDuckGo');
    expect(results.some((r) => /buy stuff/i.test(r.title))).toBe(false); // ad skipped
  });

  it('DECODES the //duckduckgo.com/l/?uddg= redirect to the real destination', () => {
    const [first] = runScrape(SAMPLE_DDG_HTML);
    expect(first?.url.startsWith('https://')).toBe(true);
    expect(first?.url).not.toContain('duckduckgo.com/l/');
    expect(first?.url).not.toContain('uddg=');
  });

  it('tolerates a direct (non-redirect) protocol-relative href → https:', () => {
    const results = runScrape(SAMPLE_DDG_HTML);
    const direct = results.find((r) => r.title === 'Direct protocol-relative link');
    expect(direct?.url).toBe('https://example.org/direct');
    expect(direct?.snippet).toBe(''); // no snippet node → empty, not a crash
  });

  it('returns [] for a page with no results (never throws)', () => {
    expect(runScrape('<!doctype html><html><body><p>No results.</p></body></html>')).toEqual([]);
  });
});

describe('DDG_RESULTS_READY_SCRIPT — counts the results container', () => {
  it('is > 0 once results are in the DOM, 0 before they render', () => {
    expect(runReady(SAMPLE_DDG_HTML)).toBeGreaterThan(0);
    expect(runReady('<!doctype html><html><body><div class="loading"></div></body></html>')).toBe(
      0,
    );
  });
});

describe('shapeSearchResults — shaping + clamping (pure)', () => {
  it('drops non-object / untitled rows, coerces url/snippet, clamps to count', () => {
    const raw = [
      { title: 'A', url: 'https://a', snippet: 'sa' },
      { title: 'B' }, // missing url/snippet → coerced to ''
      { url: 'https://c' }, // no title → dropped
      null,
      'nonsense',
    ];
    const out = shapeSearchResults(raw, 5);
    expect(out).toEqual([
      { title: 'A', url: 'https://a', snippet: 'sa' },
      { title: 'B', url: '', snippet: '' },
    ]);
    expect(shapeSearchResults(raw, 1)).toHaveLength(1);
  });

  it('returns [] for non-array input', () => {
    expect(shapeSearchResults(undefined, 5)).toEqual([]);
    expect(shapeSearchResults({ nope: true }, 5)).toEqual([]);
  });
});

describe('ddgSearchUrl', () => {
  it('builds the DDG HTML endpoint with the query URL-encoded', () => {
    expect(ddgSearchUrl('breakout game js')).toBe(
      'https://duckduckgo.com/html/?q=breakout%20game%20js',
    );
  });
});

// ── the navigate → poll → scrape flow, against a fake bridge ──────────────────

interface BridgeCall {
  readonly method: string;
  readonly script?: string;
}

/** A fake bridge recording every call. `navigate` returns the injected promise (a
 * never-resolving one proves the flow does not block on full load); `evaluate`
 * dispatches on which script it was handed — the readiness probe returns the next
 * count in `readySeq`, the scrape returns `scrape()` (or throws it). */
function fakeBridge(opts: {
  readonly navigate?: () => Promise<unknown>;
  readonly readySeq: number[];
  readonly scrape?: () => unknown;
}): { bridge: SearchBridge; calls: BridgeCall[] } {
  const calls: BridgeCall[] = [];
  let readyIdx = 0;
  const bridge: SearchBridge = {
    request: (async (method: string, params?: Record<string, unknown>) => {
      const script = typeof params?.script === 'string' ? params.script : undefined;
      calls.push({ method, ...(script !== undefined ? { script } : {}) });
      if (method === 'navigate') return (opts.navigate ?? (async () => ({})))();
      if (method === 'evaluate') {
        if (script === DDG_RESULTS_READY_SCRIPT) {
          const v = opts.readySeq[Math.min(readyIdx, opts.readySeq.length - 1)] ?? 0;
          readyIdx += 1;
          return v;
        }
        if (script === DDG_SCRAPE_SCRIPT) {
          if (opts.scrape) return opts.scrape();
          return [];
        }
      }
      return undefined;
    }) as SearchBridge['request'],
  };
  return { bridge, calls };
}

/** A synchronous injected sleep (no real time passes) → deterministic tests. */
const instantSleep = async (): Promise<void> => undefined;

const SCRAPE_HITS = [{ title: 'Hit', url: 'https://hit', snippet: 'a hit' }];

describe('createBrowserSearch — navigate → poll → scrape (H1)', () => {
  it('navigates to the DDG url, POLLS until results are ready, then scrapes', async () => {
    const { bridge, calls } = fakeBridge({ readySeq: [0, 0, 3], scrape: () => SCRAPE_HITS });
    const search = createBrowserSearch(bridge, {
      navSettleMs: 10,
      resultsTimeoutMs: 5000,
      pollIntervalMs: 250,
      sleep: instantSleep,
    });
    const out = await search('breakout game', 5);

    expect(calls[0]?.method).toBe('navigate');
    const readyCalls = calls.filter((c) => c.script === DDG_RESULTS_READY_SCRIPT);
    const scrapeCalls = calls.filter((c) => c.script === DDG_SCRAPE_SCRIPT);
    expect(readyCalls).toHaveLength(3); // polled until the 3rd probe saw results
    expect(scrapeCalls).toHaveLength(1); // scraped exactly once, AFTER results were ready
    expect(out).toEqual(SCRAPE_HITS);
  });

  it('does NOT block on a navigate that never resolves (no waiting for full load)', async () => {
    // navigate hangs forever (the DDG page keeps "loading" ~tens of seconds) — the
    // search must still poll + scrape and return promptly.
    const { bridge } = fakeBridge({
      navigate: () => new Promise<never>(() => {}),
      readySeq: [2],
      scrape: () => SCRAPE_HITS,
    });
    const search = createBrowserSearch(bridge, {
      navSettleMs: 5,
      resultsTimeoutMs: 1000,
      pollIntervalMs: 250,
      sleep: instantSleep,
    });
    await expect(search('anything', 3)).resolves.toEqual(SCRAPE_HITS);
  });

  it('scrapes anyway after the poll never sees results (returns partial/empty, never hangs)', async () => {
    const { bridge, calls } = fakeBridge({ readySeq: [0], scrape: () => SCRAPE_HITS });
    const search = createBrowserSearch(bridge, {
      navSettleMs: 5,
      resultsTimeoutMs: 1000,
      pollIntervalMs: 250, // 1000/250 → 4 bounded polls
      sleep: instantSleep,
    });
    const out = await search('q', 5);
    const readyCalls = calls.filter((c) => c.script === DDG_RESULTS_READY_SCRIPT);
    expect(readyCalls).toHaveLength(4); // bounded poll count, then it scrapes regardless
    expect(out).toEqual(SCRAPE_HITS);
  });

  it('returns [] when the scrape evaluate errors (web_search falls back to its backend)', async () => {
    const { bridge } = fakeBridge({
      readySeq: [1],
      scrape: () => {
        throw new Error('evaluate blew up');
      },
    });
    const search = createBrowserSearch(bridge, {
      navSettleMs: 5,
      resultsTimeoutMs: 500,
      pollIntervalMs: 250,
      sleep: instantSleep,
    });
    await expect(search('q', 5)).resolves.toEqual([]);
  });
});
