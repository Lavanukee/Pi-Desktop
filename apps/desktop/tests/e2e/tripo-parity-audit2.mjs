/** Parity audit pass 2 — focus rings, clipping, accent density, scrollbars. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');
const OUT = process.env.AUDIT_OUT;
mkdirSync(OUT, { recursive: true });

const heroTs = readFileSync(path.join(appRoot, 'src/tripo/assets/hero-glb.ts'), 'utf8');
const heroB64 = (heroTs.match(/HERO_MESH_GLB_B64 =\s*'([^']+)'/) ?? [])[1];
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-audit2-home-')));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-audit2-udd-'))}`],
  env: {
    ...process.env,
    HOME: home,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
    GEN3D_PY_DIR: '/nonexistent',
    GEN3D_CACHE_DIR: realpathSync(mkdtempSync(path.join(tmpdir(), 'gen3d-empty-'))),
  },
});
const out = {};
let page;
try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-flavor', 'bobble');
    document.documentElement.setAttribute('data-mode', 'dark');
  });

  // ── FOCUS RING: tab through the app's controls, record the outline ────────
  const focusProbe = async (label) => {
    const seen = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (el === null || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          cls: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
          outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
          outlineOffset: cs.outlineOffset,
          boxShadow: cs.boxShadow.slice(0, 60),
        };
      });
      if (info !== null) seen.push(info);
    }
    out[label] = seen;
  };
  await page.click('body');
  await focusProbe('focusChat');

  // ── into the studio ──────────────────────────────────────────────────────
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.click('.tp-viewport');
  await focusProbe('focusStudio');

  // ── ACCENT DENSITY: how many elements are filled with the accent? ─────────
  const accentCount = async (label) => {
    out[label] = await page.evaluate(() => {
      const accent = getComputedStyle(document.documentElement)
        .getPropertyValue('--pd-accent-primary')
        .trim();
      // Resolve the token to rgb by painting it on a probe element.
      const probe = document.createElement('div');
      probe.style.backgroundColor = accent;
      document.body.appendChild(probe);
      const target = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const hits = [];
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.backgroundColor !== target) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue; // ignore dots/knobs
        hits.push({
          cls: typeof el.className === 'string' ? el.className.slice(0, 34) : '',
          text: (el.textContent ?? '').trim().slice(0, 26),
          area: Math.round(r.width * r.height),
        });
      }
      return { accent: target, count: hits.length, hits };
    });
  };
  await accentCount('accentEmpty');

  // load a model, then re-count on the animate stage (the busiest panel)
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'm.glb', { type: 'model/gltf-binary' }));
    document
      .querySelector('[data-testid="tp-root"]')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, heroB64);
  await page
    .waitForSelector('[data-testid="tp-canvas-host"][data-tp-canvas-ready="1"]', { timeout: 30000 })
    .catch(() => {});
  const ok = page.locator('[data-testid="tp-help-ok"]');
  if (await ok.count()) await ok.click().catch(() => {});
  await page.waitForTimeout(600);
  await accentCount('accentLoaded');

  await page.click('[data-testid="tp-rail-animate"]');
  await page.waitForTimeout(900);
  await accentCount('accentAnimate');

  // ── CLIPPING: does the sticky footer CTA cover the scroll content? ────────
  out.clip = await page.evaluate(() => {
    const probe = (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const cs = getComputedStyle(el);
      return {
        sel,
        clientH: el.clientHeight,
        scrollH: el.scrollHeight,
        paddingBottom: cs.paddingBottom,
        overflowY: cs.overflowY,
        scrollbarWidth: cs.scrollbarWidth,
        scrollbarColor: cs.scrollbarColor,
      };
    };
    // Is the last motion card visually behind the sticky CTA?
    const cards = [...document.querySelectorAll('.tp-anim-card')];
    const last = cards.at(-1);
    const footer = document.querySelector('.tp-panel-foot, .tp-stage-foot, [data-testid="tp-open-graph"]');
    return {
      panelScroll: probe('.tp-panel-scroll') ?? probe('.tp-gen-scroll') ?? probe('.tp-stage-scroll'),
      allScrollers: [...document.querySelectorAll('.tp *')]
        .filter((e) => {
          const cs = getComputedStyle(e);
          return (
            (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight
          );
        })
        .map((e) => ({
          cls: typeof e.className === 'string' ? e.className.slice(0, 40) : '',
          clientH: e.clientHeight,
          scrollH: e.scrollHeight,
          padBottom: getComputedStyle(e).paddingBottom,
          scrollbarWidth: getComputedStyle(e).scrollbarWidth,
          scrollbarColor: getComputedStyle(e).scrollbarColor,
        })),
      lastCardBottom: last === undefined ? null : Math.round(last.getBoundingClientRect().bottom),
      footerTop: footer === null ? null : Math.round(footer.getBoundingClientRect().top),
    };
  });

  // ── the app's own scroller, for comparison ───────────────────────────────
  await page.click('[data-testid="tp-back"]');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10000 });
  out.appScrollers = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter((e) => {
        const cs = getComputedStyle(e);
        return cs.overflowY === 'auto' || cs.overflowY === 'scroll';
      })
      .slice(0, 8)
      .map((e) => ({
        cls: typeof e.className === 'string' ? e.className.slice(0, 40) : '',
        scrollbarWidth: getComputedStyle(e).scrollbarWidth,
        scrollbarColor: getComputedStyle(e).scrollbarColor,
      })),
  );

  writeFileSync(path.join(OUT, 'audit2.json'), JSON.stringify(out, null, 2));
  console.log('audit2 written');
} catch (e) {
  console.error('audit2 ERROR', e.message);
  writeFileSync(path.join(OUT, 'audit2.json'), JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  await app.close();
}
