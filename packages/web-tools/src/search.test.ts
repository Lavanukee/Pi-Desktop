import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  boundCount,
  duckDuckGoBackend,
  isDuckDuckGoChallenge,
  MAX_RESULTS,
  parseBraveJson,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
  parseTavilyJson,
  resolveSearchBackends,
  runWebSearch,
  type SearchBackend,
  type SearchResult,
  webSearchConfigFromEnv,
} from './search.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const ddgHtml = fixture('duckduckgo.html'); // legacy redirect-wrapper markup
const ddgCurrent = fixture('duckduckgo-current.html'); // current direct-href markup
const ddgLite = fixture('duckduckgo-lite.html');
const ddgEmpty = fixture('duckduckgo-empty.html');
const ddgChallenge = fixture('duckduckgo-challenge.html');
const braveJson = JSON.parse(fixture('brave.json')) as unknown;

describe('parseDuckDuckGoHtml', () => {
  it('extracts title/url/snippet and decodes the legacy uddg redirect, skipping ad rows', () => {
    const results = parseDuckDuckGoHtml(ddgHtml, 10);
    expect(results).toHaveLength(3); // ad row without result__a is skipped
    expect(results[0]).toEqual({
      title: 'Example Domain',
      url: 'http://www.example.com/',
      snippet:
        'This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.',
    });
    expect(results[1]?.url).toBe('https://en.wikipedia.org/wiki/Example.com');
    expect(results[2]?.title).toBe('Example domains and names - Google Developers');
  });

  // Regression guard: DDG dropped the `//duckduckgo.com/l/?uddg=` redirect
  // wrapper for a DIRECT https href on result__a. This fixture captures the
  // CURRENT markup so a future change can't silently drop back to zero results.
  it('parses the current direct-href markup and drops sponsored result--ad rows', () => {
    const results = parseDuckDuckGoHtml(ddgCurrent, 10);
    expect(results).toHaveLength(3); // the result--ad block is excluded
    expect(results[0]).toEqual({
      title: 'Example Domain',
      url: 'https://www.example.com/',
      snippet:
        'This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.',
    });
    expect(results.map((r) => r.url)).not.toContain('https://duckduckgo.com/y.js?ad=1');
    expect(results[2]?.title).toBe('Example Domains - IANA');
  });

  it('respects the count bound', () => {
    expect(parseDuckDuckGoHtml(ddgHtml, 1)).toHaveLength(1);
  });

  it('returns [] on an anti-bot / no-results page', () => {
    expect(parseDuckDuckGoHtml(ddgEmpty, 10)).toEqual([]);
  });
});

describe('parseDuckDuckGoLite', () => {
  it('extracts title/url and the following-row snippet from the lite table', () => {
    const results = parseDuckDuckGoLite(ddgLite, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Example Domain',
      url: 'https://www.example.com/',
      snippet: 'This domain is for use in illustrative examples in documents.',
    });
    expect(results[1]?.url).toBe('https://en.wikipedia.org/wiki/Example.com');
  });

  it('respects the count bound', () => {
    expect(parseDuckDuckGoLite(ddgLite, 1)).toHaveLength(1);
  });
});

describe('isDuckDuckGoChallenge', () => {
  it('flags the anomaly interstitial (even when served 200) but not real pages', () => {
    expect(isDuckDuckGoChallenge(ddgChallenge)).toBe(true);
    expect(isDuckDuckGoChallenge(ddgCurrent)).toBe(false);
    expect(isDuckDuckGoChallenge(ddgEmpty)).toBe(false);
  });
});

describe('parseBraveJson', () => {
  it('maps results and strips <strong> highlight markup from descriptions', () => {
    const results = parseBraveJson(braveJson, 10);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: 'Example Domain',
      url: 'https://www.example.com/',
      snippet: 'This domain is for use in illustrative examples in documents.',
    });
    expect(results[1]?.url).toBe('https://en.wikipedia.org/wiki/Example.com');
  });

  it('respects the count bound', () => {
    expect(parseBraveJson(braveJson, 2)).toHaveLength(2);
  });
});

describe('parseTavilyJson', () => {
  it('maps title/url/content', () => {
    const raw = { results: [{ title: 'T', url: 'https://t.example', content: 'body  text' }] };
    expect(parseTavilyJson(raw, 10)).toEqual([
      { title: 'T', url: 'https://t.example', snippet: 'body text' },
    ]);
  });
});

describe('boundCount', () => {
  it('defaults to 8, clamps to [1, MAX_RESULTS]', () => {
    expect(boundCount(undefined)).toBe(8);
    expect(boundCount(0)).toBe(1);
    expect(boundCount(999)).toBe(MAX_RESULTS);
    expect(boundCount(5)).toBe(5);
  });
});

describe('webSearchConfigFromEnv', () => {
  it('reads brave/tavily keys and backend selection', () => {
    const cfg = webSearchConfigFromEnv({
      PI_BRAVE_API_KEY: 'bk',
      PI_TAVILY_API_KEY: 'tk',
      PI_WEB_SEARCH_BACKEND: 'brave',
    });
    expect(cfg).toMatchObject({ braveApiKey: 'bk', tavilyApiKey: 'tk', backend: 'brave' });
  });

  it('defaults backend to auto when unset', () => {
    expect(webSearchConfigFromEnv({}).backend).toBe('auto');
  });
});

describe('resolveSearchBackends', () => {
  it('DDG-only when no keys', () => {
    const chain = resolveSearchBackends({});
    expect(chain.map((b) => b.name)).toEqual(['duckduckgo']);
  });

  it('Brave primary + DDG floor in auto mode with a key', () => {
    const chain = resolveSearchBackends({ braveApiKey: 'k', backend: 'auto' });
    expect(chain.map((b) => b.name)).toEqual(['brave', 'duckduckgo']);
  });

  it('honours an explicit duckduckgo selection even when a Brave key exists', () => {
    const chain = resolveSearchBackends({ braveApiKey: 'k', backend: 'duckduckgo' });
    expect(chain.map((b) => b.name)).toEqual(['duckduckgo']);
  });
});

function fakeBackend(name: string, impl: () => Promise<SearchResult[]>): SearchBackend {
  return { name, search: impl };
}

describe('runWebSearch fallback', () => {
  const req = { count: 5 };
  const hit: SearchResult = { title: 'X', url: 'https://x', snippet: 's' };

  it('falls back to the next backend when the primary throws', async () => {
    const primary = fakeBackend('brave', async () => {
      throw new Error('402 payment required');
    });
    const floor = fakeBackend('duckduckgo', async () => [hit]);
    const outcome = await runWebSearch([primary, floor], 'q', req);
    expect(outcome.backend).toBe('duckduckgo');
    expect(outcome.results).toEqual([hit]);
    expect(outcome.note).toContain('brave failed');
  });

  it('falls back when the primary returns empty', async () => {
    const primary = fakeBackend('brave', async () => []);
    const floor = fakeBackend('duckduckgo', async () => [hit]);
    const outcome = await runWebSearch([primary, floor], 'q', req);
    expect(outcome.backend).toBe('duckduckgo');
    expect(outcome.results).toHaveLength(1);
  });

  it('never throws — returns empty with a note when all backends fail', async () => {
    const a = fakeBackend('brave', async () => {
      throw new Error('boom');
    });
    const b = fakeBackend('duckduckgo', async () => {
      throw new Error('bam');
    });
    const outcome = await runWebSearch([a, b], 'q', req);
    expect(outcome.results).toEqual([]);
    expect(outcome.note).toContain('duckduckgo failed');
  });
});

describe('duckDuckGoBackend with injected fetch', () => {
  it('POSTs the query as a form and parses the served results page', async () => {
    let seen: { method?: string; body?: unknown } = {};
    const backend = duckDuckGoBackend({
      fetchImpl: async (_url, init) => {
        seen = { method: init?.method, body: init?.body };
        return new Response(ddgCurrent, { status: 200 });
      },
    });
    const results = await backend.search('example', { count: 10 });
    expect(results).toHaveLength(3);
    expect(seen.method).toBe('POST'); // GET is what triggers DDG's anti-bot page
    expect(String(seen.body)).toContain('q=example');
  });

  it('falls back from a challenged html endpoint to the lite endpoint', async () => {
    const backend = duckDuckGoBackend({
      fetchImpl: async (url) =>
        String(url).includes('/html/')
          ? new Response('blocked', { status: 403 })
          : new Response(ddgLite, { status: 200 }),
    });
    const results = await backend.search('example', { count: 10 });
    expect(results).toHaveLength(2); // served by the lite fallback
  });

  it('throws (so the caller can note it) when every endpoint is challenged', async () => {
    const backend = duckDuckGoBackend({
      fetchImpl: async () => new Response(ddgChallenge, { status: 200 }),
    });
    await expect(backend.search('example', { count: 10 })).rejects.toThrow(/rate-limit/i);
  });

  it('returns [] (no throw) when a clean page genuinely has no results', async () => {
    const backend = duckDuckGoBackend({
      fetchImpl: async () => new Response(ddgEmpty, { status: 200 }),
    });
    expect(await backend.search('example', { count: 10 })).toEqual([]);
  });
});
