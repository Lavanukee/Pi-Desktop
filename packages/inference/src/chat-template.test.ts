import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatTemplatePath,
  ensureChatTemplate,
  extractChatTemplate,
  repoSlug,
} from './chat-template.js';

const REPO = 'google/gemma-4-E2B-it';

interface FakeInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

interface FakeResponseSpec {
  readonly ok?: boolean;
  readonly status?: number;
  readonly body?: string;
  readonly json?: unknown;
  readonly etag?: string;
}

function fakeResponse(spec: FakeResponseSpec): Response {
  const headers = new Map<string, string>();
  if (spec.etag !== undefined) headers.set('etag', spec.etag);
  return {
    ok: spec.ok ?? true,
    status: spec.status ?? 200,
    text: async () => spec.body ?? '',
    json: async () => spec.json,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
  } as unknown as Response;
}

interface RecordedCall {
  readonly url: string;
  readonly method?: string;
  readonly auth?: string;
}

/** A mock fetch that records calls and drives responses from a handler. */
function mockFetch(handler: (url: string, init: FakeInit) => FakeResponseSpec) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: FakeInit) => {
    const url = String(input);
    const i = init ?? {};
    calls.push({ url, method: i.method, auth: i.headers?.authorization });
    return fakeResponse(handler(url, i));
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls, raw: fn };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-chat-tpl-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('repoSlug / chatTemplatePath', () => {
  it('slugs a repo id filesystem-safely', () => {
    expect(repoSlug('google/gemma-4-E2B-it')).toBe('google--gemma-4-E2B-it');
    expect(chatTemplatePath('google/gemma-4-E2B-it', '/cache')).toBe(
      '/cache/google--gemma-4-E2B-it.jinja',
    );
  });
});

describe('extractChatTemplate', () => {
  it('reads the plain-string form', () => {
    expect(extractChatTemplate({ chat_template: 'PLAIN' })).toBe('PLAIN');
  });
  it('prefers the `default` entry in the array form', () => {
    expect(
      extractChatTemplate({
        chat_template: [
          { name: 'tool_use', template: 'TOOL' },
          { name: 'default', template: 'DEFAULT' },
        ],
      }),
    ).toBe('DEFAULT');
  });
  it('falls back to the first array entry with a string template', () => {
    expect(extractChatTemplate({ chat_template: [{ name: 'x', template: 'FIRST' }] })).toBe(
      'FIRST',
    );
  });
  it('returns undefined for missing/invalid shapes', () => {
    expect(extractChatTemplate({})).toBeUndefined();
    expect(extractChatTemplate(null)).toBeUndefined();
    expect(extractChatTemplate({ chat_template: 123 })).toBeUndefined();
  });
});

describe('ensureChatTemplate', () => {
  it('fetches chat_template.jinja, caches it, and records provenance', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: '{{ jinja tpl }}', etag: '"abc"' }));
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl });

    expect(r.source).toBe('jinja');
    expect(r.refreshed).toBe(true);
    expect(r.cached).toBe(false);
    expect(r.etag).toBe('abc'); // normalised: quotes stripped, lowercased
    expect(r.path).toBe(chatTemplatePath(REPO, dir));
    expect(await readFile(r.path, 'utf8')).toBe('{{ jinja tpl }}');
    expect(calls).toHaveLength(1);
  });

  it('sends the HF bearer token for gated base repos', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: 'x' }));
    await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, hfToken: 'hf_SECRET' });
    expect(calls[0]?.auth).toBe('Bearer hf_SECRET');
  });

  it('serves a fresh cache without any network on the second call', async () => {
    const now = () => 1_000_000;
    const { fetchImpl, calls } = mockFetch(() => ({ body: 'tpl', etag: '"e1"' }));
    await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now });
    const r2 = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now });
    expect(calls).toHaveLength(1); // second served from disk
    expect(r2.cached).toBe(true);
    expect(r2.refreshed).toBe(false);
    expect(r2.source).toBe('cache');
  });

  it('re-checks a stale cache via HEAD and keeps it when the ETag is unchanged', async () => {
    let t = 0;
    const now = () => t;
    const { fetchImpl, calls } = mockFetch((_url, init) =>
      init.method === 'HEAD' ? { etag: '"e1"' } : { body: 'tpl', etag: '"e1"' },
    );
    await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 100 });
    t = 10_000; // now stale
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 100 });
    expect(r.cached).toBe(true);
    expect(r.refreshed).toBe(false);
    // one GET (first) + one HEAD (second); no second body download.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.method === 'HEAD')).toBe(true);
  });

  it('re-downloads the body when the remote ETag changed', async () => {
    let t = 0;
    const now = () => t;
    let gets = 0;
    const { fetchImpl } = mockFetch((_url, init) => {
      if (init.method === 'HEAD') return { etag: '"NEW"' };
      gets += 1;
      return gets === 1 ? { body: 'old', etag: '"OLD"' } : { body: 'new', etag: '"NEW"' };
    });
    const first = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 10 });
    expect(await readFile(first.path, 'utf8')).toBe('old');
    t = 1000; // stale
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 10 });
    expect(r.refreshed).toBe(true);
    expect(await readFile(r.path, 'utf8')).toBe('new');
  });

  it('falls back to tokenizer_config.json when chat_template.jinja is 404', async () => {
    const { fetchImpl } = mockFetch((url) =>
      url.endsWith('chat_template.jinja')
        ? { ok: false, status: 404 }
        : { json: { chat_template: 'FROM_CONFIG' }, etag: '"c1"' },
    );
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl });
    expect(r.source).toBe('tokenizer_config');
    expect(await readFile(r.path, 'utf8')).toBe('FROM_CONFIG');
  });

  it('returns the stale cached body when a refresh fetch fails (resilient)', async () => {
    let t = 0;
    const now = () => t;
    let fail = false;
    const { fetchImpl } = mockFetch(() => {
      if (fail) throw new Error('network down');
      return { body: 'cached-body', etag: '"e1"' };
    });
    await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 10 });
    t = 1000; // stale
    fail = true; // both HEAD and GET now throw
    const r = await ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl, now, maxAgeMs: 10 });
    expect(r.cached).toBe(true);
    expect(r.refreshed).toBe(false);
    expect(await readFile(r.path, 'utf8')).toBe('cached-body');
  });

  it('throws when gated + no token + nothing cached', async () => {
    const { fetchImpl } = mockFetch(() => ({ ok: false, status: 401 }));
    await expect(ensureChatTemplate(REPO, { cacheDir: dir, fetchImpl })).rejects.toThrow();
  });
});
