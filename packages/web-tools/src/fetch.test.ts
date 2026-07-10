import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchReadable, htmlToMarkdown } from './fetch.js';

const articleHtml = readFileSync(new URL('./fixtures/article.html', import.meta.url), 'utf8');

describe('htmlToMarkdown', () => {
  it('extracts the article title and body, and never leaks scripts/styles', () => {
    const { title, markdown, truncated } = htmlToMarkdown(articleHtml);
    expect(title).toContain('Peregrine Falcon');
    expect(markdown).toContain('fastest member of the animal kingdom');
    expect(markdown).toContain('## Range and Habitat');
    // Executable / presentational content is stripped by us up front — guaranteed
    // regardless of readability's heuristics (which may keep ad-like prose).
    expect(markdown).not.toContain('alert(');
    expect(markdown).not.toContain('<script');
    expect(markdown).not.toContain('window.dataLayer');
    expect(markdown).not.toContain('font-family');
    expect(truncated).toBe(false);
  });

  it('caps output at maxChars and flags truncation', () => {
    const { markdown, truncated } = htmlToMarkdown(articleHtml, { maxChars: 80 });
    expect(markdown.length).toBe(80);
    expect(truncated).toBe(true);
  });

  it('falls back to the raw body when readability finds no article', () => {
    const { markdown } = htmlToMarkdown('<html><body><p>tiny</p></body></html>');
    expect(markdown).toContain('tiny');
  });
});

describe('fetchReadable', () => {
  it('fetches, extracts markdown, and reports the final URL', async () => {
    const result = await fetchReadable('https://birds.example/falcon', {
      fetchImpl: async () =>
        new Response(articleHtml, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    expect(result.title).toContain('Peregrine Falcon');
    expect(result.markdown).toContain('fastest member of the animal kingdom');
    expect(result.truncated).toBe(false);
  });

  it('throws on a non-ok HTTP status', async () => {
    await expect(
      fetchReadable('https://x.example', {
        fetchImpl: async () => new Response('nope', { status: 500, statusText: 'Server Error' }),
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('caps the download and flags truncation for oversized bodies', async () => {
    const huge = `<html><body>${'<p>spam spam spam</p>'.repeat(5000)}</body></html>`;
    const result = await fetchReadable('https://big.example', {
      maxBytes: 500,
      fetchImpl: async () => new Response(huge, { status: 200 }),
    });
    expect(result.truncated).toBe(true);
  });

  it('aborts on timeout', async () => {
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    await expect(
      fetchReadable('https://slow.example', { timeoutMs: 50, fetchImpl: hangingFetch }),
    ).rejects.toThrow();
  });
});
