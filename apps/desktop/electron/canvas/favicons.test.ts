/**
 * The favicon fetcher's job is to be safe and quiet: first-party requests only,
 * images only, and a `null` for anything it cannot use — because the card it
 * feeds already draws a letter chip and must never show a broken image.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFaviconCache, faviconHost, siteFavicon } from './favicons';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearFaviconCache();
});
beforeEach(() => clearFaviconCache());

/** A fetch that answers `ok` for the listed paths and 404s everything else. */
function fakeFetch(
  ok: Record<string, { type: string; body: Uint8Array }>,
): { calls: string[]; fn: typeof fetch } {
  const calls: string[] = [];
  const fn = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = ok[new URL(url).pathname];
    if (hit === undefined) return { ok: false, status: 404, headers: new Headers() } as Response;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': hit.type }),
      arrayBuffer: async () => hit.body.buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fn };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('which sites it will even ask', () => {
  it('takes a bare domain or a full URL', () => {
    expect(faviconHost('cnn.com')).toBe('cnn.com');
    expect(faviconHost('https://www.CNN.com/2026/story')).toBe('www.cnn.com');
  });

  it('refuses anything that is not a public http(s) site', () => {
    // A dotless name is an intranet host or localhost; credentials in a URL and
    // non-web schemes are not things a decoration should be reaching for.
    for (const bad of ['localhost', 'file:///etc/passwd', 'https://u:p@evil.test', '', '   ']) {
      expect(faviconHost(bad)).toBeUndefined();
    }
  });
});

describe('fetching', () => {
  it('takes the site’s own /favicon.ico as a data URI', async () => {
    const { fn, calls } = fakeFetch({ '/favicon.ico': { type: 'image/x-icon', body: PNG } });
    globalThis.fetch = fn;
    const uri = await siteFavicon('https://cnn.com/anything');
    expect(uri).toBe(`data:image/x-icon;base64,${Buffer.from(PNG).toString('base64')}`);
    // FIRST-PARTY: the request went to the site itself, never an icon aggregator.
    expect(calls).toEqual(['https://cnn.com/favicon.ico']);
  });

  it('falls through to the other well-known paths', async () => {
    const { fn, calls } = fakeFetch({ '/apple-touch-icon.png': { type: 'image/png', body: PNG } });
    globalThis.fetch = fn;
    expect(await siteFavicon('example.test')).toContain('data:image/png;base64,');
    expect(calls).toHaveLength(3);
  });

  it('REJECTS an html error page served as /favicon.ico', async () => {
    // Extremely common, and rendering it is a broken-image icon in the card.
    const { fn } = fakeFetch({ '/favicon.ico': { type: 'text/html', body: PNG } });
    globalThis.fetch = fn;
    expect(await siteFavicon('example.test')).toBeNull();
  });

  it('returns null when the site has nothing, and never throws when fetch does', async () => {
    globalThis.fetch = fakeFetch({}).fn;
    expect(await siteFavicon('nothing.test')).toBeNull();
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    clearFaviconCache();
    await expect(siteFavicon('offline.test')).resolves.toBeNull();
  });
});

describe('asking once', () => {
  it('caches a hit, so eight results on one domain are one request', async () => {
    const { fn, calls } = fakeFetch({ '/favicon.ico': { type: 'image/png', body: PNG } });
    globalThis.fetch = fn;
    const all = await Promise.all(
      Array.from({ length: 8 }, () => siteFavicon('https://cnn.com/x')),
    );
    expect(new Set(all).size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('caches a MISS too — a site with no icon is not retried on every render', async () => {
    const { fn, calls } = fakeFetch({});
    globalThis.fetch = fn;
    await siteFavicon('nothing.test');
    await siteFavicon('nothing.test');
    expect(calls).toHaveLength(3); // the three candidate paths, once
  });
});
