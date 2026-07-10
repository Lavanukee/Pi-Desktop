import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  boundCount,
  duckDuckGoBackend,
  MAX_RESULTS,
  parseBraveJson,
  parseDuckDuckGoHtml,
  parseTavilyJson,
  resolveSearchBackends,
  runWebSearch,
  type SearchBackend,
  type SearchResult,
  webSearchConfigFromEnv,
} from './search.js';

const ddgHtml = readFileSync(new URL('./fixtures/duckduckgo.html', import.meta.url), 'utf8');
const ddgEmpty = readFileSync(new URL('./fixtures/duckduckgo-empty.html', import.meta.url), 'utf8');
const braveJson = JSON.parse(
  readFileSync(new URL('./fixtures/brave.json', import.meta.url), 'utf8'),
) as unknown;

describe('parseDuckDuckGoHtml', () => {
  it('extracts title/url/snippet and decodes the uddg redirect, skipping ad rows', () => {
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

  it('respects the count bound', () => {
    expect(parseDuckDuckGoHtml(ddgHtml, 1)).toHaveLength(1);
  });

  it('returns [] on an anti-bot / no-results page', () => {
    expect(parseDuckDuckGoHtml(ddgEmpty, 10)).toEqual([]);
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
  it('parses a served fixture', async () => {
    const backend = duckDuckGoBackend({
      fetchImpl: async () => new Response(ddgHtml, { status: 200 }),
    });
    const results = await backend.search('example', { count: 10 });
    expect(results).toHaveLength(3);
  });

  it('returns [] (no throw) on a non-200 anti-bot response', async () => {
    const backend = duckDuckGoBackend({
      fetchImpl: async () => new Response('blocked', { status: 403 }),
    });
    expect(await backend.search('example', { count: 10 })).toEqual([]);
  });
});
