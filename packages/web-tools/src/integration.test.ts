/**
 * REAL end-to-end integration tests (env-guarded so CI skips them).
 *
 * Run locally with:
 *   PI_DESKTOP_WEB_TOOLS_E2E=1 pnpm --filter @pi-desktop/web-tools test
 *
 * (a) live web_fetch against example.com + a live DuckDuckGo web_search;
 * (b) a real python_run that bootstraps uv (detecting an existing uv on PATH,
 *     else downloading the pinned binary) and executes small snippets, asserting
 *     stdout. First run may download a uv-managed CPython.
 */
import { describe, expect, it } from 'vitest';
import { fetchReadable } from './fetch.js';
import { uvPythonRuntime } from './python.js';
import { resolveSearchBackends, runWebSearch } from './search.js';
import { runSpotlightSearch, systemSpotlightRunner } from './spotlight.js';
import { ensureUv } from './uv.js';

const RUN = process.env.PI_DESKTOP_WEB_TOOLS_E2E === '1';
// spotlight_search is macOS-only and its own opt-in (real mdfind hits the live index).
const RUN_SPOTLIGHT = process.env.PI_SPOTLIGHT_E2E === '1' && process.platform === 'darwin';

describe.skipIf(!RUN)('web-tools live end-to-end', () => {
  it('web_fetch extracts markdown from example.com', async () => {
    const result = await fetchReadable('https://example.com/', { timeoutMs: 20_000 });
    console.log(`[E2E] fetch title=${JSON.stringify(result.title)} url=${result.url}`);
    console.log(`[E2E] fetch markdown (first 200): ${result.markdown.slice(0, 200)}`);
    expect(result.title).toContain('Example Domain');
    expect(result.markdown.toLowerCase()).toContain('domain is for use');
    expect(result.url).toContain('example.com');
  });

  it('web_search returns results via DuckDuckGo (or degrades gracefully)', async () => {
    const backends = resolveSearchBackends({ backend: 'duckduckgo' });
    const outcome = await runWebSearch(backends, 'example domain iana', { count: 5 });
    console.log(
      `[E2E] search backend=${outcome.backend} count=${outcome.results.length} note=${outcome.note ?? 'none'}`,
    );
    for (const r of outcome.results.slice(0, 3)) console.log(`[E2E]   - ${r.title} :: ${r.url}`);
    // DDG occasionally anti-bots; the contract is "never throw", so we assert the
    // shape rather than a hard count. When results come back, they must be valid.
    for (const r of outcome.results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(typeof r.title).toBe('string');
    }
  });

  it('python_run bootstraps uv and executes print(2+2) → 4', async () => {
    const install = await ensureUv();
    console.log(`[E2E] uv: source=${install.source} path=${install.uvPath}`);
    const runtime = uvPythonRuntime();
    const r = await runtime.run('print(2 + 2)', { timeoutMs: 120_000 });
    console.log(
      `[E2E] python stdout=${JSON.stringify(r.stdout)} exit=${r.exitCode} stderr=${r.stderr}`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('4');
  });

  it('python_run executes a small stdlib snippet', async () => {
    const runtime = uvPythonRuntime();
    const r = await runtime.run('import math\nprint(sum(range(10)), math.gcd(12, 18))', {
      timeoutMs: 120_000,
    });
    console.log(`[E2E] python stdout=${JSON.stringify(r.stdout)} exit=${r.exitCode}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('45 6');
  });
});

describe.skipIf(!RUN_SPOTLIGHT)('spotlight_search live end-to-end (macOS)', () => {
  it('finds apps under /System/Library/CoreServices via a real mdfind', async () => {
    const outcome = await runSpotlightSearch(systemSpotlightRunner(), {
      query: '',
      scope: '/System/Library/CoreServices',
      kind: 'app',
      limit: 5,
    });
    console.log(
      `[E2E] spotlight count=${outcome.count} truncated=${outcome.truncated} note=${outcome.note ?? 'none'}`,
    );
    for (const h of outcome.hits.slice(0, 3)) console.log(`[E2E]   - ${h.name} :: ${h.path}`);
    expect(outcome.error).toBeUndefined();
    expect(outcome.hits.length).toBeGreaterThan(0);
    for (const h of outcome.hits) {
      expect(h.path.startsWith('/')).toBe(true);
      expect(h.name.length).toBeGreaterThan(0);
    }
  });
});
