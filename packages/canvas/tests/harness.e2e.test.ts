// @vitest-environment node
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const harnessUrl = new URL('../harness/index.html', import.meta.url).href;

interface HarnessWindow {
  __count?: number;
  __msgs?: Array<{ type: string; seq?: number }>;
}

/** Recursively find candidate Chromium executables under a directory. */
function findExecutables(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findExecutables(full, depth - 1, out);
    } else if (
      entry.name === 'chrome-headless-shell' ||
      entry.name === 'headless_shell' ||
      entry.name === 'Chromium'
    ) {
      out.push(full);
    }
  }
}

/** Launch Chromium, falling back to any headless shell in the playwright cache. */
async function launch(): Promise<Browser | null> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    // ignore; try explicit executables discovered below
  }
  const cache = path.join(homedir(), 'Library/Caches/ms-playwright');
  const candidates: string[] = [];
  findExecutables(cache, 4, candidates);
  // Newest build (highest revision in the path) first.
  candidates.sort().reverse();
  for (const executablePath of candidates) {
    try {
      return await chromium.launch({ headless: true, executablePath });
    } catch {
      // try next
    }
  }
  return null;
}

const interactiveHtml = (heading: string) => `
  <h1 id="t">${heading}</h1>
  <input id="n" type="text" />
  <div id="c">0</div>
  <script>
    if (!window.__started) {
      window.__started = true;
      window.__count = 0;
      setInterval(function () {
        window.__count++;
        var c = document.getElementById('c');
        if (c) c.textContent = String(window.__count);
      }, 25);
    }
  </script>`;

let browser: Browser | null = null;

beforeAll(async () => {
  browser = await launch();
});

afterAll(async () => {
  await browser?.close();
});

describe('pd-preview harness (real Chromium)', () => {
  it('keeps an input value + a running counter alive across a streaming patch (no reload)', async (ctx) => {
    if (!browser) {
      ctx.skip();
      return;
    }
    const page: Page = await browser.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as HarnessWindow;
      w.__msgs = [];
      window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { channel?: string; type: string; seq?: number };
        if (data && data.channel === 'pd-canvas') w.__msgs?.push(data);
      });
    });

    await page.goto(harnessUrl);
    // Harness announces `ready` (to window.parent === window for a top-level page).
    await page.waitForFunction(() =>
      (window as unknown as HarnessWindow).__msgs?.some((m) => m.type === 'ready'),
    );

    // Stream in the first interactive snapshot.
    await page.evaluate((html) => {
      window.postMessage({ channel: 'pd-canvas', type: 'patch', seq: 1, html }, '*');
    }, interactiveHtml('One'));
    await page.waitForFunction(() =>
      (window as unknown as HarnessWindow).__msgs?.some((m) => m.type === 'applied' && m.seq === 1),
    );

    // The user interacts: type into the input, and let the counter tick.
    await page.focus('#n');
    await page.type('#n', 'hello');
    expect(await page.inputValue('#n')).toBe('hello');
    await page.waitForFunction(() => ((window as unknown as HarnessWindow).__count ?? 0) > 2);
    const before = await page.evaluate(() => (window as unknown as HarnessWindow).__count ?? 0);

    // Stream a patch that rewrites surrounding markup (heading changes).
    await page.evaluate((html) => {
      window.postMessage({ channel: 'pd-canvas', type: 'patch', seq: 2, html }, '*');
    }, interactiveHtml('Two — changed'));
    await page.waitForFunction(() =>
      (window as unknown as HarnessWindow).__msgs?.some((m) => m.type === 'applied' && m.seq === 2),
    );

    // Patch applied…
    expect(await page.textContent('#t')).toContain('Two');
    // …input value survived (no reload)…
    expect(await page.inputValue('#n')).toBe('hello');
    // …focus survived…
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('n');
    // …and the setInterval kept running across the patch (state, not restarted).
    await page.waitForFunction(
      (prev) => ((window as unknown as HarnessWindow).__count ?? 0) > (prev as number),
      before,
    );
    const after = await page.evaluate(() => (window as unknown as HarnessWindow).__count ?? 0);
    expect(after).toBeGreaterThan(before);

    await page.close();
  });
});
