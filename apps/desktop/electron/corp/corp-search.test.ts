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

/** A faithful fragment of the CURRENT `html.duckduckgo.com/html/` POST response
 * (mirrors packages/web-tools/src/fixtures/duckduckgo-current.html, captured 2026-07).
 * The load-bearing shape: each organic hit is a `div.result …` whose `links_main`
 * body holds an `h2.result__title > a.result__a` with a DIRECT `https://` href (the
 * `//duckduckgo.com/l/?uddg=` redirect wrapper is now mostly gone), an
 * `a.result__snippet` (with `<b>` highlights), and a `result__extras__url`. Included
 * on purpose: a sponsored `result--ad` row (must be skipped), ONE legacy `uddg=`
 * redirect row (proves the decode still works — `&amp;` is the raw entity DDG emits,
 * which jsdom decodes to `&` on getAttribute), and one protocol-relative `//` href. */
const SAMPLE_DDG_HTML = `<!doctype html><html><body>
<div id="links" class="results">
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://developer.mozilla.org/en-US/">MDN Web Docs</a>
      </h2>
      <a class="result__snippet" href="https://developer.mozilla.org/en-US/">Resources for <b>developers</b>, by developers.</a>
      <div class="result__extras"><div class="result__extras__url">
        <a class="result__url" href="https://developer.mozilla.org/en-US/">developer.mozilla.org</a>
      </div></div>
    </div>
  </div>

  <!-- A sponsored row: no organic content, must be skipped. -->
  <div class="result result--ad result--ad--small">
    <div class="links_main result__body">
      <span class="badge--ad">Ad</span>
      <a class="result__a result--ad__a" href="https://duckduckgo.com/y.js?ad=1">SPONSORED — buy stuff</a>
    </div>
  </div>

  <!-- Legacy redirect-wrapped row: the decode must still recover the destination. -->
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FDuckDuckGo&amp;rut=deadbeef">DuckDuckGo - Wikipedia</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FDuckDuckGo">A privacy-focused search engine.</a>
    </div>
  </div>

  <!-- Protocol-relative direct href, no snippet node. -->
  <div class="result web-result">
    <div class="links_main result__body">
      <a class="result__a" href="//example.org/direct">Direct protocol-relative link</a>
    </div>
  </div>
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

  it('passes a DIRECT https result__a href through unchanged (the current markup)', () => {
    const mdn = runScrape(SAMPLE_DDG_HTML).find((r) => r.title === 'MDN Web Docs');
    expect(mdn?.url).toBe('https://developer.mozilla.org/en-US/');
  });

  it('still DECODES a legacy //duckduckgo.com/l/?uddg= redirect to the real destination', () => {
    const wiki = runScrape(SAMPLE_DDG_HTML).find((r) => r.title === 'DuckDuckGo - Wikipedia');
    expect(wiki?.url).toBe('https://en.wikipedia.org/wiki/DuckDuckGo');
    expect(wiki?.url).not.toContain('duckduckgo.com/l/');
    expect(wiki?.url).not.toContain('uddg=');
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

  it('returns [] for a page carrying ONLY an ad / no-result row (no organic hit)', () => {
    const adOnly = `<!doctype html><html><body><div id="links" class="results">
      <div class="result result--ad"><a class="result__a result--ad__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
      <div class="result no-results result--no-result"><a class="result__a" href="https://duckduckgo.com/">No results.</a></div>
    </div></body></html>`;
    expect(runScrape(adOnly)).toEqual([]);
  });
});

describe('DDG_RESULTS_READY_SCRIPT — counts GENUINE organic results only', () => {
  it('is > 0 once organic results are in the DOM, 0 before they render', () => {
    expect(runReady(SAMPLE_DDG_HTML)).toBeGreaterThan(0);
    expect(runReady('<!doctype html><html><body><div class="loading"></div></body></html>')).toBe(
      0,
    );
  });

  it('is 0 when only ad / no-result filler rows have rendered (does not fire early)', () => {
    // The live "0 results" cause: the poll used to see these `.result` rows and fire
    // the scrape before the organic hits rendered. It must now wait (count 0).
    const fillerOnly = `<!doctype html><html><body><div id="links" class="results">
      <div class="result result--ad result--ad--small"><a class="result__a result--ad__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
      <div class="result result--no-result">No results found for your query.</div>
    </div></body></html>`;
    expect(runReady(fillerOnly)).toBe(0);
  });

  it('counts exactly the organic hits in the current markup (ad row excluded)', () => {
    // SAMPLE has 3 organic div.result rows + 1 ad row → the ad must not be counted.
    expect(runReady(SAMPLE_DDG_HTML)).toBe(3);
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
