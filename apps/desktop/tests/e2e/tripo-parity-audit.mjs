/**
 * UI PARITY AUDIT probe — captures the main chat UI and the Bobble 3D studio
 * side by side in the same window, and MEASURES computed styles of equivalent
 * controls in both surfaces so parity claims are numbers, not vibes.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = process.env.AUDIT_APP_ROOT;
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');
const OUT_DIR = process.env.AUDIT_OUT;
mkdirSync(OUT_DIR, { recursive: true });

const heroTs = readFileSync(path.join(appRoot, 'src/tripo/assets/hero-glb.ts'), 'utf8');
const heroB64 = (heroTs.match(/HERO_MESH_GLB_B64 =\s*'([^']+)'/) ?? [])[1];

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-audit-home-')));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-audit-udd-'))}`],
  env: {
    ...process.env,
    HOME: home,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
    GEN3D_PY_DIR: '/nonexistent-gen3d-py-dir',
    GEN3D_CACHE_DIR: realpathSync(mkdtempSync(path.join(tmpdir(), 'gen3d-empty-'))),
  },
});

let page;
const findings = {};
const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  console.log(`  shot: ${name}.png`);
};
const setTheme = async (flavor, mode) => {
  await page.evaluate(
    ([f, m]) => {
      document.documentElement.setAttribute('data-flavor', f);
      document.documentElement.setAttribute('data-mode', m);
    },
    [flavor, mode],
  );
  await page.waitForTimeout(150);
};

/** Computed geometry/type for the first match of each selector. */
const measure = async (specs) =>
  page.evaluate((list) => {
    const out = {};
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el === null) {
        out[sel] = null;
        continue;
      }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out[sel] = {
        h: Math.round(r.height * 10) / 10,
        w: Math.round(r.width * 10) / 10,
        radius: cs.borderTopLeftRadius,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        textTransform: cs.textTransform,
        padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        gap: cs.gap,
        color: cs.color,
        bg: cs.backgroundColor,
        border: cs.borderTopWidth + ' ' + cs.borderTopColor,
        transition: cs.transitionProperty + ' / ' + cs.transitionDuration,
        fontFamily: cs.fontFamily.slice(0, 42),
      };
    }
    return out;
  }, specs);

try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await setTheme('bobble', 'dark');

  // ─────────────── MAIN CHAT UI (the parity reference) ───────────────
  await shot('A01-chat-empty-dark');

  // A real turn so the thread/activity chain is on screen.
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('look around the repo');
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=Done — hello.txt now greets the world.', { timeout: 20000 });
  await shot('A02-chat-thread-dark');

  findings.chat = await measure([
    '.pd-topbar',
    '.pd-btn',
    '.pd-composer',
    '.pd-sidebar',
    '.pd-sidebar-row',
    '.pd-sidebar-row-label',
    '.pd-sidebar-section-label',
    '.pd-chain-summary-text',
    '.pd-msg-bubble',
  ]);

  // Sidebar section label typography (the "Modalities"/"Projects" caps rows).
  findings.chatSidebarLabels = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.pd-sidebar-row-label, .pd-sidebar-heading, .pd-sidebar-section')) {
      const cs = getComputedStyle(el);
      out.push({
        cls: el.className,
        text: (el.textContent ?? '').slice(0, 24),
        fontSize: cs.fontSize,
        weight: cs.fontWeight,
        transform: cs.textTransform,
        tracking: cs.letterSpacing,
        color: cs.color,
      });
    }
    return out.slice(0, 12);
  });

  // Open a menu in the main app for menu-geometry parity.
  const menuTrigger = page.locator('[data-testid="model-picker-btn"], [data-testid="composer-plus"]').first();
  if (await menuTrigger.count()) {
    await menuTrigger.click().catch(() => {});
    await page.waitForTimeout(400);
    findings.chatMenu = await measure(['.pd-menu', '.pd-menu-item', '.pd-menu-item-label']);
    await shot('A03-chat-menu-dark');
    await page.keyboard.press('Escape');
  }

  // Settings dialog — the app's canonical panel/dialog/form surface.
  const settingsBtn = page.locator('[data-testid="open-settings"], [data-testid="settings-btn"]').first();
  if (await settingsBtn.count()) {
    await settingsBtn.click().catch(() => {});
    await page.waitForTimeout(600);
    findings.chatDialog = await measure([
      '.pd-dialog',
      '.pd-dialog-title',
      '.pd-input',
      '.pd-select',
      '.pd-switch',
      '.pd-field-label',
      '.pd-settings-section-title',
    ]);
    await shot('A04-chat-settings-dark');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  await setTheme('bobble', 'light');
  await shot('A05-chat-thread-light');
  await setTheme('bobble', 'dark');

  // ─────────────── ENTER THE 3D STUDIO via the sidebar ───────────────
  const modality3d = page.locator('[data-testid="modality-3d"]');
  if (!(await modality3d.count())) {
    const hdr = page.locator('[data-testid="modality-header"], text=Modalities').first();
    await hdr.click().catch(() => {});
    await page.waitForTimeout(300);
  }
  await modality3d.click();
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 20000 });
  await page.waitForTimeout
    ? await page.waitForTimeout(700)
    : null;
  await shot('B01-studio-empty-dark');

  findings.studio = await measure([
    '.tp-topbar',
    '.tp-back-btn',
    '.tp-pill-btn',
    '.tp-export-cta',
    '.tp-rail',
    '.tp-rail-item',
    '.tp-rail-label',
    '.tp-panel',
    '.tp-panel-title',
    '.tp-section-label',
    '.tp-primary-btn',
    '.tp-segmented',
    '.tp-segment',
    '.tp-toggle',
    '.tp-card',
    '.tp-input',
    '.tp-textarea',
    '.tp-select',
    '.tp-dropzone',
    '.tp-empty-state',
    '.tp-right',
    '.tp-viewport',
  ]);

  // Every distinct label-ish class in the studio, with its type treatment.
  findings.studioLabels = await page.evaluate(() => {
    const seen = new Map();
    for (const el of document.querySelectorAll('[class*="tp-"]')) {
      const txt = (el.textContent ?? '').trim();
      if (txt.length === 0 || txt.length > 30 || el.children.length > 0) continue;
      const cls = el.className;
      if (typeof cls !== 'string' || seen.has(cls)) continue;
      const cs = getComputedStyle(el);
      seen.set(cls, {
        cls,
        text: txt.slice(0, 24),
        fontSize: cs.fontSize,
        weight: cs.fontWeight,
        transform: cs.textTransform,
        tracking: cs.letterSpacing,
        color: cs.color,
      });
    }
    return [...seen.values()].slice(0, 40);
  });

  // The empty state (what a first-run user actually sees).
  const emptyText = await page
    .textContent('[data-testid="tp-empty-state"]')
    .catch(() => '(no empty state)');
  findings.emptyStateText = emptyText;

  // Text tab / generation options.
  await page.click('[data-testid="tp-input-tab-text"]').catch(() => {});
  await shot('B02-studio-textgen-dark');

  // The download panel (the app's "engine missing" state).
  await page.click('[data-testid="tp-generate-btn"]').catch(() => {});
  await page.waitForSelector('[data-testid="tp-download-panel"]', { timeout: 10000 }).catch(() => {});
  await page.waitForSelector('[data-testid="tp-dlcard-trellis2"]', { timeout: 10000 }).catch(() => {});
  await shot('B03-studio-download-panel-dark');
  findings.studioDownload = await measure([
    '.tp-download-panel',
    '.tp-dlcard',
    '.tp-dl-title',
    '.tp-dl-btn',
  ]);
  await page.click('[data-testid="tp-download-back"]').catch(() => {});

  // Import a GLB → the loaded-model chrome (gizmo, render modes, assets).
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'dropped-model.glb', { type: 'model/gltf-binary' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document
      .querySelector('[data-testid="tp-root"]')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, heroB64);
  await page
    .waitForSelector('[data-testid="tp-canvas-host"][data-tp-canvas-ready="1"]', { timeout: 30000 })
    .catch(() => {});
  const helpOk = page.locator('[data-testid="tp-help-ok"]');
  if (await helpOk.count()) await helpOk.click().catch(() => {});
  await page.waitForTimeout(1200);
  await shot('B04-studio-loaded-dark');

  findings.studioLoaded = await measure([
    '.tp-gizmo',
    '.tp-viewport-toolbar',
    '.tp-rmode',
    '.tp-asset-card',
    '.tp-asset-preview',
    '.tp-stat-row',
  ]);

  // Studio menus / popovers.
  await page.click('[data-testid="tp-sendto-btn"]').catch(() => {});
  await page.waitForTimeout(400);
  findings.studioMenu = await measure(['.tp-popover', '.tp-menu-item', '.tp-menu-item-label']);
  await shot('B05-studio-sendto-menu-dark');
  await page.keyboard.press('Escape');

  // Export dialog (the studio's modal — parity against .pd-dialog).
  await page.click('[data-testid="tp-export-btn"]').catch(() => {});
  await page.waitForSelector('[data-testid="tp-export-dialog"]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  findings.studioDialog = await measure([
    '.tp-modal',
    '.tp-modal-card',
    '.tp-modal-title',
    '.tp-dialog',
    '.tp-field-label',
    '.tp-select-btn',
  ]);
  await shot('B06-studio-export-dialog-dark');
  await page.click('[data-testid="tp-export-close"]').catch(() => {});
  await page.keyboard.press('Escape');

  // Stage panels.
  for (const rail of ['segment', 'retopo', 'texture', 'animate']) {
    await page.click(`[data-testid="tp-rail-${rail}"]`).catch(() => {});
    await page.waitForTimeout(700);
    await shot(`B07-studio-stage-${rail}-dark`);
  }

  // Animate → the blend graph (full-viewport editor).
  await page.click('[data-testid="tp-motion-m-walk"]').catch(() => {});
  await page.click('[data-testid="tp-motion-m-run"]').catch(() => {});
  await page.click('[data-testid="tp-open-graph"]').catch(() => {});
  await page.waitForSelector('[data-testid="tp-blend-graph"]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  await shot('B08-studio-blend-graph-dark');
  await page.click('[data-testid="tp-graph-close"]').catch(() => {});

  // ─────────────── THEME SWEEP ───────────────
  await page.click('[data-testid="tp-rail-model"]').catch(() => {});
  await page.waitForTimeout(400);
  for (const [f, m] of [
    ['bobble', 'light'],
    ['claude', 'dark'],
    ['claude', 'light'],
    ['codex', 'dark'],
    ['codex', 'light'],
  ]) {
    await setTheme(f, m);
    await shot(`C-studio-${f}-${m}`);
  }

  // PURPLE HUNT: any element whose resolved color/bg/border lands in the
  // purple hue band (255-310deg) violates jedd's no-purple brief.
  await setTheme('bobble', 'dark');
  findings.purple = await page.evaluate(() => {
    const hueOf = (rgb) => {
      const m = rgb.match(/rgba?\(([^)]+)\)/);
      if (m === null) return null;
      const [r, g, b, a = '1'] = m[1].split(',').map((x) => Number.parseFloat(x));
      if (Number.parseFloat(a) < 0.06) return null;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx - mn < 18) return null; // near-grey: no meaningful hue
      let h;
      if (mx === r) h = ((g - b) / (mx - mn)) % 6;
      else if (mx === g) h = (b - r) / (mx - mn) + 2;
      else h = (r - g) / (mx - mn) + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
      return h;
    };
    const hits = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'fill', 'stroke']) {
        const h = hueOf(cs[prop] ?? '');
        if (h !== null && h >= 255 && h <= 320) {
          hits.push({
            tag: el.tagName,
            cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
            prop,
            value: cs[prop],
            hue: h,
          });
        }
      }
    }
    return hits.slice(0, 30);
  });

  // Scrollbar treatment: the studio's panels vs the app's .pd-scroll.
  findings.scroll = await page.evaluate(() => {
    const probe = (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const cs = getComputedStyle(el);
      return {
        overflowY: cs.overflowY,
        scrollbarWidth: cs.scrollbarWidth,
        scrollbarColor: cs.scrollbarColor,
        cls: typeof el.className === 'string' ? el.className : '',
      };
    };
    return {
      studioPanel: probe('.tp-panel-scroll') ?? probe('.tp-panel'),
      studioRight: probe('.tp-right-scroll') ?? probe('.tp-right'),
    };
  });

  writeFileSync(path.join(OUT_DIR, 'measurements.json'), JSON.stringify(findings, null, 2));
  console.log(`\nMEASUREMENTS → ${path.join(OUT_DIR, 'measurements.json')}`);
  console.log('audit-probe done');
} catch (e) {
  console.error('audit-probe ERROR:', e.message);
  try {
    await page?.screenshot({ path: path.join(OUT_DIR, 'ZZ-error.png') });
    writeFileSync(path.join(OUT_DIR, 'measurements.json'), JSON.stringify(findings, null, 2));
  } catch {}
  process.exitCode = 1;
} finally {
  await app.close();
}
