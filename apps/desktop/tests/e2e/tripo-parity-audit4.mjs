/**
 * Parity audit pass 4 — the questions passes 1-3 left open or could not see.
 *
 *  1. FOCUS RING, targeted. Passes 1-3 tabbed blindly and happened to land on
 *     .pd-project-chip / .pd-menu-trigger. This walks the WHOLE tab order of
 *     both surfaces and reports every control still resolving Chromium's
 *     `outline: auto` instead of the app's `solid 2px`.
 *  2. CODEX SQUIRCLE. base.css gates `corner-shape: superellipse(1.5)` on an
 *     enumerated list of .pd-* primitives. Pass 1 could not tell whether this
 *     Chromium supports the property at all, so the gap was unverifiable.
 *     CSS.supports answers it, and the resolved cornerShape per surface says
 *     whether the studio is inside or outside the signature.
 *  3. ESCAPE. The studio's own handler closes menus then `modal`. This checks
 *     every dismissable layer actually dismisses, including the full-viewport
 *     state-machine editor (`graphOpen`), which is not a `modal`.
 *  4. REDUCED MOTION, honestly emulated (Playwright's own media emulation, not
 *     a CSS-file grep): what still animates or auto-plays under `reduce`.
 *  5. ACCENT DENSITY on the panels the earlier passes never reached — the
 *     Image panel is the busiest surface in the studio.
 *  6. CONTRAST of the viewport stats overlay, which is painted straight onto
 *     the 3D canvas with no surface behind it.
 *
 * Usage: AUDIT_OUT=/tmp/audit node apps/desktop/tests/e2e/tripo-parity-audit4.mjs
 */
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
const OUT = process.env.AUDIT_OUT ?? path.join(tmpdir(), 'tripo-audit4');
mkdirSync(OUT, { recursive: true });

const heroTs = readFileSync(path.join(appRoot, 'src/tripo/assets/hero-glb.ts'), 'utf8');
const heroB64 = (heroTs.match(/HERO_MESH_GLB_B64 =\s*'([^']+)'/) ?? [])[1];
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-audit4-home-')));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-audit4-udd-'))}`],
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
const shot = async (n) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `${n}.png`) });
  console.log(`  shot: ${n}.png`);
};
const setTheme = (f, m) =>
  page.evaluate(
    ([flavor, mode]) => {
      document.documentElement.setAttribute('data-flavor', flavor);
      document.documentElement.setAttribute('data-mode', mode);
    },
    [f, m],
  );

/** Tab `steps` times, recording the resolved focus ring of each landing. */
async function tabSweep(steps) {
  const seen = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        cls: typeof el.className === 'string' ? el.className.slice(0, 44) : String(el.tagName),
        outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
        offset: cs.outlineOffset,
      };
    });
    if (info !== null) seen.push(info);
  }
  // The UA ring is `auto`; the app's is `solid 2px <focus color>`.
  return { sampled: seen.length, uaDefault: seen.filter((s) => s.outline.startsWith('auto')) };
}

/** True hue of a resolved rgb() string, or null when it's effectively grey. */
const HUE_FN = `(rgb) => {
  const m = rgb.match(/rgba?\\(([^)]+)\\)/); if (m === null) return null;
  const [r,g,b,a='1'] = m[1].split(',').map(Number.parseFloat);
  if (Number.parseFloat(a) < 0.06) return null;
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
  if (mx - mn < 18) return null;
  let h; if (mx===r) h=((g-b)/(mx-mn))%6; else if (mx===g) h=(b-r)/(mx-mn)+2; else h=(r-g)/(mx-mn)+4;
  h = Math.round(h*60); return h < 0 ? h+360 : h;
}`;

try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 20000 });
  await setTheme('bobble', 'dark');

  // ── 1. FOCUS RING, whole tab order, both surfaces ──────────────────────
  await page.click('body');
  out.focusChat = await tabSweep(40);
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.click('.tp-viewport');
  out.focusStudio = await tabSweep(40);

  // ── 2. CODEX SQUIRCLE ──────────────────────────────────────────────────
  await setTheme('codex', 'dark');
  await page.waitForTimeout(200);
  out.squircle = await page.evaluate(() => {
    const shapeOf = (sel) => {
      const el = document.querySelector(sel);
      return el === null ? null : (getComputedStyle(el).cornerShape ?? '(property unknown)');
    };
    return {
      supported: CSS.supports('corner-shape', 'superellipse(1.5)'),
      // studio surfaces
      'tp-topbar': shapeOf('.tp-topbar'),
      'tp-generate-btn': shapeOf('.tp-generate-btn'),
      'tp-card': shapeOf('.tp-input-card'),
      'tp-segmented': shapeOf('.tp-segmented'),
      'tp-rail-item': shapeOf('.tp-rail-item'),
      'tp-dropzone': shapeOf('.tp-dropzone'),
    };
  });
  await shot('S1-codex-studio');
  await page.click('[data-testid="tp-back"]');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  out.squircleChat = await page.evaluate(() => ({
    'pd-btn': getComputedStyle(document.querySelector('.pd-btn')).cornerShape ?? '(unknown)',
    'pd-composer':
      getComputedStyle(document.querySelector('.pd-composer')).cornerShape ?? '(unknown)',
  }));
  await shot('S2-codex-chat');
  await setTheme('bobble', 'dark');

  // back into the studio with a model loaded, for the rest
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 20000 });
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

  // ── 3. ESCAPE dismisses every layer ────────────────────────────────────
  const escapes = {};
  // (a) a popover
  await page.click('[data-testid="tp-sendto-btn"]');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  escapes.popover = (await page.locator('[data-testid="tp-sendto-menu"]').count()) === 0;
  // (b) the export dialog
  await page.click('[data-testid="tp-export-btn"]');
  await page.waitForSelector('[data-testid="tp-export-dialog"]', { timeout: 6000 }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  escapes.exportDialog = (await page.locator('[data-testid="tp-export-dialog"]').count()) === 0;
  // (c) the viewer-help modal
  await page.click('[data-testid="tp-help-btn"]').catch(() => {});
  await page.waitForTimeout(400);
  const helpOpened = (await page.locator('[data-testid="tp-help-modal"]').count()) > 0;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  escapes.helpModal =
    helpOpened && (await page.locator('[data-testid="tp-help-modal"]').count()) === 0;
  // (d) the FULL-VIEWPORT state-machine editor (graphOpen — not a `modal`).
  // Its launcher is gated behind a real humanoid rig, so this only runs when a
  // rigged asset happens to be present; the pipeline probe covers the rigged
  // case end to end.
  await page.click('[data-testid="tp-rail-animate"]').catch(() => {});
  await page.waitForTimeout(500);
  const graphReachable = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="tp-open-graph"]');
    if (btn === null) return false;
    btn.click();
    return true;
  });
  if (graphReachable) {
    await page.waitForSelector('[data-testid="tp-blend-graph"]', { timeout: 6000 }).catch(() => {});
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    escapes.stateMachine = (await page.locator('[data-testid="tp-blend-graph"]').count()) === 0;
  } else {
    escapes.stateMachine = '(launcher gated behind a humanoid rig — see the pipeline probe)';
  }
  out.escape = escapes;

  // ── 4. REDUCED MOTION, actually emulated ───────────────────────────────
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  out.reducedMotion = await page.evaluate(() => {
    const still = [];
    // Not `.tp *` — popovers and hint bubbles portal to document.body.
    for (const el of document.querySelectorAll('[class*="tp-"], [class*="cl-"]')) {
      const cs = getComputedStyle(el);
      if (cs.animationName !== 'none' && cs.animationDuration !== '0s') {
        still.push({
          cls: typeof el.className === 'string' ? el.className.slice(0, 40) : el.tagName,
          animation: `${cs.animationName} ${cs.animationDuration}`,
        });
      }
    }
    return {
      stillAnimating: still.slice(0, 20),
      count: still.length,
      // Hover-previews are <video autoplay-on-hover>; `reduce` should stop them.
      videos: document.querySelectorAll('video.tp-anim-video').length,
    };
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ── 5. ACCENT DENSITY on the Image panel (the busiest surface) ─────────
  await page.click('[data-testid="tp-rail-image"]');
  await page.waitForTimeout(500);
  out.accentImagePanel = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--pd-accent-primary')
      .trim();
    document.body.appendChild(probe);
    const target = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const hits = [];
    for (const el of document.querySelectorAll('*')) {
      if (getComputedStyle(el).backgroundColor !== target) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      hits.push({
        cls: typeof el.className === 'string' ? el.className.slice(0, 34) : '',
        text: (el.textContent ?? '').trim().slice(0, 24),
        area: Math.round(r.width * r.height),
      });
    }
    return { count: hits.length, hits: hits.sort((a, b) => b.area - a.area) };
  });
  await shot('S3-image-panel');

  // ── 6. STATS OVERLAY CONTRAST (painted on the bare 3D canvas) ──────────
  await page.click('[data-testid="tp-rail-model"]');
  await page.waitForTimeout(400);
  out.statsOverlay = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tp-stats"]');
    if (el === null) return null;
    const cs = getComputedStyle(el);
    return {
      background: cs.backgroundColor,
      backdropFilter: cs.backdropFilter,
      color: cs.color,
      padding: cs.paddingTop,
      radius: cs.borderTopLeftRadius,
    };
  });

  // ── 7. TEXT CONTRAST + TYPE SCALE across all six themes ────────────────
  // WCAG 1.4.3: 4.5:1 for body text, 3:1 for >=18.66px bold or >=24px. The
  // studio renders type below the app's 12px caption floor, and small + faint
  // is where contrast actually bites.
  const contrast = {};
  for (const [f, m] of [
    ['bobble', 'dark'],
    ['bobble', 'light'],
    ['claude', 'dark'],
    ['claude', 'light'],
    ['codex', 'dark'],
    ['codex', 'light'],
  ]) {
    await setTheme(f, m);
    await page.waitForTimeout(180);
    contrast[`${f}-${m}`] = await page.evaluate(() => {
      const lum = (rgb) => {
        const m2 = rgb.match(/rgba?\(([^)]+)\)/);
        if (m2 === null) return null;
        const [r, g, b] = m2[1].split(',').map(Number.parseFloat);
        const ch = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      };
      /** Nearest ancestor with a non-transparent background. */
      const bgOf = (el) => {
        for (let n = el; n !== null; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const rows = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('[class*="tp-"]')) {
        const txt = (el.textContent ?? '').trim();
        if (txt.length === 0 || el.children.length > 0) continue;
        const cls = typeof el.className === 'string' ? el.className : '';
        if (cls === '' || seen.has(cls)) continue;
        seen.add(cls);
        const cs = getComputedStyle(el);
        const lf = lum(cs.color);
        const lb = lum(bgOf(el));
        if (lf === null || lb === null) continue;
        const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
        const px = Number.parseFloat(cs.fontSize);
        const large = px >= 24 || (px >= 18.66 && Number.parseInt(cs.fontWeight, 10) >= 700);
        rows.push({
          cls: cls.slice(0, 34),
          text: txt.slice(0, 22),
          px,
          ratio: Math.round(ratio * 100) / 100,
          need: large ? 3 : 4.5,
        });
      }
      return {
        belowFloor: rows.filter((r) => r.px < 12).length,
        failing: rows.filter((r) => r.ratio < r.need).sort((a, b) => a.ratio - b.ratio),
        sampled: rows.length,
      };
    });
  }
  out.contrast = contrast;

  // ── PURPLE HUNT across all six theme combinations ──────────────────────
  const purple = {};
  for (const [f, m] of [
    ['bobble', 'dark'],
    ['bobble', 'light'],
    ['claude', 'dark'],
    ['claude', 'light'],
    ['codex', 'dark'],
    ['codex', 'light'],
  ]) {
    await setTheme(f, m);
    await page.waitForTimeout(180);
    purple[`${f}-${m}`] = await page.evaluate((hueSrc) => {
      // biome-ignore lint/security/noGlobalEval: audit probe, source is this file
      const hueOf = eval(hueSrc);
      const hits = [];
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'fill', 'stroke']) {
          const h = hueOf(cs[prop] ?? '');
          if (h !== null && h >= 255 && h <= 320) {
            hits.push({
              cls: typeof el.className === 'string' ? el.className.slice(0, 40) : el.tagName,
              prop,
              value: cs[prop],
              hue: h,
            });
          }
        }
      }
      return hits.slice(0, 12);
    }, HUE_FN);
  }
  out.purple = purple;
  await setTheme('bobble', 'dark');

  writeFileSync(path.join(OUT, 'audit4.json'), JSON.stringify(out, null, 2));
  console.log(`audit4 written → ${path.join(OUT, 'audit4.json')}`);
  console.log(
    `focus: chat ${out.focusChat.uaDefault.length}/${out.focusChat.sampled} UA rings, studio ${out.focusStudio.uaDefault.length}/${out.focusStudio.sampled}`,
  );
  console.log(`corner-shape supported: ${out.squircle.supported}`);
  console.log(`escape: ${JSON.stringify(out.escape)}`);
  console.log(`reduced-motion: ${out.reducedMotion.count} still animating`);
  console.log(`accent on Image panel: ${out.accentImagePanel.count}`);
  console.log(
    `purple hits: ${Object.entries(purple)
      .map(([k, v]) => `${k}=${v.length}`)
      .join(' ')}`,
  );
  console.log(
    `contrast failures: ${Object.entries(contrast)
      .map(([k, v]) => `${k}=${v.failing.length}/${v.sampled}`)
      .join(' ')}  (sub-12px labels: ${contrast['bobble-dark']?.belowFloor})`,
  );
} catch (e) {
  console.error('audit4 ERROR', e.stack ?? e.message);
  writeFileSync(path.join(OUT, 'audit4.json'), JSON.stringify(out, null, 2));
  await page?.screenshot({ path: path.join(OUT, 'ZZ-audit4-error.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
}
