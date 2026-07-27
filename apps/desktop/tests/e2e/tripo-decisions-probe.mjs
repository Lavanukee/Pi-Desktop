/**
 * Bobble 3D studio — the D1..D12 design decisions, MEASURED in the running app.
 *
 * UI-AUDIT.md's "What still needs a design decision" section listed twelve open
 * calls. They are decided now (see "Decisions implemented" at the foot of that
 * file) and this probe is the evidence: it drives the built app and reports a
 * number per decision rather than asserting that some CSS text exists.
 *
 * Every section prints `PASS`/`FAIL` plus the measurement behind it, and the
 * whole run writes `decisions.json` so a before/after diff is a `diff` away.
 *
 *   pnpm --filter @pi-desktop/desktop build      # the probe loads dist
 *   DECISIONS_OUT=/tmp/dec node apps/desktop/tests/e2e/tripo-decisions-probe.mjs
 *   DECISIONS_BASELINE=1 …   record only, never fail (used for the BEFORE run)
 *
 * D1 (worker progress) and D12 (a source comment) have no DOM surface; they are
 * covered by packages/gen3d-engine/python/tests/test_cubepart_progress.py and by
 * the data.ts header respectively.
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
const OUT = process.env.DECISIONS_OUT ?? path.join(tmpdir(), 'tripo-decisions');
const BASELINE = process.env.DECISIONS_BASELINE === '1';
mkdirSync(OUT, { recursive: true });

const THEMES = [
  ['bobble', 'dark'],
  ['bobble', 'light'],
  ['claude', 'dark'],
  ['claude', 'light'],
  ['codex', 'dark'],
  ['codex', 'light'],
];

const out = { verdicts: {} };
const failures = [];
const check = (id, ok, detail) => {
  out.verdicts[id] = { ok, detail };
  if (!ok) failures.push(`${id}: ${detail}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

const heroTs = readFileSync(path.join(appRoot, 'src/tripo/assets/hero-glb.ts'), 'utf8');
const heroB64 = (heroTs.match(/HERO_MESH_GLB_B64 =\s*'([^']+)'/) ?? [])[1];
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-dec-home-')));

// A cache dir where exactly ONE model reads as installed. Both halves matter:
// TRELLIS-2 installed is what un-disables "Make 3D" on the Image panel (D4 is
// about two LIVE accent CTAs, and a disabled button paints its disabled grey),
// and everything else missing keeps the download panel populated for D5/D6.
const gen3dCache = realpathSync(mkdtempSync(path.join(tmpdir(), 'gen3d-partial-')));
mkdirSync(path.join(gen3dCache, 'installed'), { recursive: true });
writeFileSync(path.join(gen3dCache, 'installed', 'trellis2.json'), '{"ok":true}');
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-dec-udd-'))}`],
  env: {
    ...process.env,
    HOME: home,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
    PI_DESKTOP_TRIPO: '1',
    // Deterministic "nothing installed" state: the download panel is one of the
    // surfaces under measurement (D5/D6).
    GEN3D_PY_DIR: '/nonexistent-gen3d-py-dir',
    GEN3D_CACHE_DIR: gen3dCache,
  },
});

let page;
const shot = async (n) => {
  await page.waitForTimeout(280);
  await page.screenshot({ path: path.join(OUT, `${n}.png`) });
};
const setTheme = async (f, m) => {
  await page.evaluate(
    ([flavor, mode]) => {
      document.documentElement.setAttribute('data-flavor', flavor);
      document.documentElement.setAttribute('data-mode', mode);
    },
    [f, m],
  );
  await page.waitForTimeout(140);
};

/** WCAG 2.x relative-luminance contrast, evaluated in the page.
 * Parses both `rgb()` and the `color(srgb r g b)` form Chromium uses when a
 * declaration resolves through color-mix(). */
const CONTRAST_FN = `(fg, bg) => {
  const parse = (s) => {
    const srgb = s.match(/color\\(srgb\\s+([^)]+)\\)/);
    if (srgb !== null) return srgb[1].trim().split(/[\\s/]+/).slice(0,3).map((v) => Number.parseFloat(v) * 255);
    const m = s.match(/rgba?\\(([^)]+)\\)/);
    return m === null ? null : m[1].split(',').map(Number.parseFloat);
  };
  const lum = (c) => { const ch = (v) => { const s = v/255; return s <= 0.03928 ? s/12.92 : ((s+0.055)/1.055)**2.4; };
    return 0.2126*ch(c[0]) + 0.7152*ch(c[1]) + 0.0722*ch(c[2]); };
  const f = parse(fg), b = parse(bg); if (f === null || b === null) return null;
  const lf = lum(f), lb = lum(b);
  return Math.round(((Math.max(lf,lb)+0.05)/(Math.min(lf,lb)+0.05)) * 100) / 100;
}`;

try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 20000 });
  await setTheme('bobble', 'dark');

  // ── D3 · "3D Workspace" deleted ─────────────────────────────────────────
  const wsLabel = await page.locator('[data-testid="tp-workspace-label"]').count();
  out.d3 = {
    workspaceLabelNodes: wsLabel,
    topbarText: (await page.textContent('[data-testid="tp-topbar"]')).replace(/\s+/g, ' ').trim(),
  };
  check('D3', wsLabel === 0, `tp-workspace-label nodes = ${wsLabel} (want 0)`);

  // A real model, imported the way a user imports one — Send To, Export and the
  // stage panels are all gated on `loadedAssetId`.
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
  const helpOk = page.locator('[data-testid="tp-help-ok"]');
  if (await helpOk.count()) await helpOk.click().catch(() => {});
  await page.waitForTimeout(500);

  // ── D8 · menu density matches the app ───────────────────────────────────
  // Two menus on purpose: Send To is single-line rows (the row-height case) and
  // the AI Model menu is label+hint (the two-line case, which may exceed a row
  // but must still set body type).
  const menuMetrics = async (openSel, waitSel) => {
    await page.click(openSel);
    await page.waitForSelector(waitSel, { timeout: 6000 });
    // The popover opens with a 140ms scale(0.98) entrance; measuring inside it
    // reports 31px for a 32px row. Let it land.
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        appRowHeight: root.getPropertyValue('--pd-row-height').trim(),
        appBodyFont: root.getPropertyValue('--pd-font-size-body').trim(),
        items: [...document.querySelectorAll('.tp-popover-portal .tp-menu-item')].map((el) => {
          const cs = getComputedStyle(el);
          const label = el.querySelector('.tp-menu-item-label');
          return {
            text: (el.textContent ?? '').trim().slice(0, 22),
            height: Math.round(el.getBoundingClientRect().height),
            fontSize: cs.fontSize,
            labelFontSize: label === null ? null : getComputedStyle(label).fontSize,
            twoLine: el.querySelector('.tp-menu-item-hint') !== null,
          };
        }),
      };
    });
    return m;
  };
  const sendTo = await menuMetrics(
    '[data-testid="tp-sendto-btn"]',
    '.tp-popover-portal .tp-menu-item',
  );
  await shot('D8-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const aiMenu = await menuMetrics(
    '[data-testid="tp-genmodel-btn"]',
    '.tp-popover-portal .tp-menu-item',
  );
  await page.keyboard.press('Escape');
  out.d8 = { sendTo, aiModel: aiMenu };
  {
    const want = Number.parseFloat(sendTo.appRowHeight);
    const wantFont = sendTo.appBodyFont;
    const all = [...sendTo.items, ...aiMenu.items];
    const single = all.filter((i) => !i.twoLine);
    const ok =
      all.every((i) => (i.labelFontSize ?? i.fontSize) === wantFont) &&
      single.length > 0 &&
      single.every((i) => i.height === want);
    check(
      'D8',
      ok,
      `single-line menu rows ${[...new Set(single.map((i) => i.height))].join('/')}px @ ` +
        `${[...new Set(all.map((i) => i.labelFontSize ?? i.fontSize))].join('/')} ` +
        `vs app ${sendTo.appRowHeight} / ${wantFont}`,
    );
  }

  // ── D7 · Segmented is a radiogroup with roving tabindex + arrow keys ─────
  // The Model panel's "Resolution" control is a Segmented; drive it by keyboard.
  const segSel = '[data-testid="tp-resolution"]';
  await page.waitForSelector(segSel, { timeout: 8000 });
  const segBefore = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const kids = [...el.children];
    const cs = getComputedStyle(el);
    return {
      groupRole: el.getAttribute('role'),
      itemRoles: kids.map((k) => k.getAttribute('role')),
      ariaChecked: kids.map((k) => k.getAttribute('aria-checked')),
      ariaSelected: kids.map((k) => k.getAttribute('aria-selected')),
      tabIndex: kids.map((k) => k.tabIndex),
      active: kids.map((k) => k.dataset.active),
      labels: kids.map((k) => (k.textContent ?? '').trim()),
      geometry: {
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height),
        radius: cs.borderTopLeftRadius,
        itemHeight: Math.round(kids[0].getBoundingClientRect().height),
        itemFont: getComputedStyle(kids[0]).fontSize,
      },
    };
  }, segSel);
  // Keyboard: focus the checked option, then ArrowRight / ArrowLeft / Home / End.
  const keyWalk = async (key) => {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const kids = [...el.children];
      const idx = kids.findIndex((k) => k.dataset.active === 'true');
      return {
        activeIndex: idx,
        focusedIndex: kids.indexOf(document.activeElement),
        label: (kids[idx]?.textContent ?? '').trim(),
      };
    }, segSel);
  };
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const checked = [...el.children].find((k) => k.dataset.active === 'true') ?? el.children[0];
    checked.focus();
  }, segSel);
  const kb = {
    start: await keyWalk('Shift'), // no-op key: records the starting position
    arrowRight: await keyWalk('ArrowRight'),
    arrowRight2: await keyWalk('ArrowRight'),
    arrowLeft: await keyWalk('ArrowLeft'),
    home: await keyWalk('Home'),
    end: await keyWalk('End'),
    arrowDown: await keyWalk('ArrowDown'),
  };
  out.d7 = { ...segBefore, keyboard: kb };
  {
    const rolesOk =
      segBefore.groupRole === 'radiogroup' && segBefore.itemRoles.every((r) => r === 'radio');
    const ariaOk = segBefore.ariaChecked.filter((v) => v === 'true').length === 1;
    const rovingOk =
      segBefore.tabIndex.filter((t) => t === 0).length === 1 &&
      segBefore.tabIndex.filter((t) => t === -1).length === segBefore.tabIndex.length - 1;
    // Arrow keys WRAP (the ARIA radio-group pattern), so every expectation is
    // modulo the option count.
    const n = segBefore.labels.length;
    const moved =
      kb.arrowRight.activeIndex === (kb.start.activeIndex + 1) % n &&
      kb.arrowRight2.activeIndex === (kb.arrowRight.activeIndex + 1) % n &&
      kb.arrowLeft.activeIndex === (kb.arrowRight2.activeIndex + n - 1) % n &&
      kb.home.activeIndex === 0 &&
      kb.end.activeIndex === n - 1 &&
      kb.arrowDown.activeIndex === 0 && // wraps forward off the end
      // selection follows focus: the DOM focus rides the roving tab stop
      kb.end.focusedIndex === n - 1;
    check(
      'D7',
      rolesOk && ariaOk && rovingOk && moved,
      `role=${segBefore.groupRole}/${segBefore.itemRoles[0]} aria-checked=${segBefore.ariaChecked.join(',')} ` +
        `tabindex=${segBefore.tabIndex.join(',')} keys start@${kb.start.activeIndex}→R${kb.arrowRight.activeIndex}` +
        `→R${kb.arrowRight2.activeIndex}→L${kb.arrowLeft.activeIndex} Home@${kb.home.activeIndex} End@${kb.end.activeIndex} Down@${kb.arrowDown.activeIndex}`,
    );
  }

  // ── D9 · static info rows are not bordered cards ────────────────────────
  await page.click('[data-testid="tp-rail-segment"]');
  await page.waitForTimeout(300);
  out.d9 = await page.evaluate(() => {
    const styleOf = (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const cs = getComputedStyle(el);
      return {
        border: `${cs.borderTopStyle} ${cs.borderTopWidth} ${cs.borderTopColor}`,
        background: cs.backgroundColor,
        radius: cs.borderTopLeftRadius,
        padding: `${cs.paddingTop} ${cs.paddingRight}`,
        text: (el.textContent ?? '').trim().slice(0, 30),
      };
    };
    return {
      staticEngineRow: styleOf('[data-testid="tp-engine-row"]'),
      // the genuinely clickable card the static row was imitating
      clickableCard: styleOf('.tp-needs-model'),
    };
  });
  {
    const s = out.d9.staticEngineRow;
    const c = out.d9.clickableCard;
    const ok =
      s !== null &&
      Number.parseFloat(s.border.split(' ')[1]) === 0 &&
      s.background === 'rgba(0, 0, 0, 0)' &&
      (c === null || c.background !== s.background || c.border !== s.border);
    check(
      'D9',
      ok,
      `static row border="${s?.border}" bg="${s?.background}" vs card "${c?.border}"`,
    );
  }
  await shot('D9-stage-panel');

  // ── D10 · float-toolbar grouping ────────────────────────────────────────
  out.d10 = await page.evaluate(() => {
    const bar = document.querySelector('.tp-float-tools');
    if (bar === null) return null;
    return {
      groups: [...bar.querySelectorAll(':scope > .tp-float-group')].map((g) => ({
        buttons: [...g.querySelectorAll('.tp-float-btn')].map(
          (b) => b.dataset.testid ?? b.getAttribute('data-testid') ?? '?',
        ),
      })),
      // Anything that is not inside a group is an orphan pill.
      orphans: [...bar.children]
        .filter((c) => !c.classList.contains('tp-float-group'))
        .flatMap((c) =>
          [...c.querySelectorAll('.tp-float-btn'), ...(c.matches('.tp-float-btn') ? [c] : [])].map(
            (b) => b.getAttribute('data-testid') ?? '?',
          ),
        ),
    };
  });
  check(
    'D10',
    out.d10 !== null && out.d10.orphans.length === 0 && out.d10.groups.length === 2,
    `${out.d10?.groups.length} groups [${out.d10?.groups.map((g) => g.buttons.join('+')).join('] [')}], orphans=[${out.d10?.orphans.join(',')}]`,
  );

  // ── D5 + D6 · the download panel ────────────────────────────────────────
  await page.click('[data-testid="tp-rail-model"]');
  await page.click('[data-testid="tp-generate-btn"]');
  await page.waitForSelector('[data-testid="tp-download-panel"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="tp-dlcard-trellis2"]', { timeout: 10000 });
  // Park the pointer off every control: the panel replaces the button that
  // opened it, so a resting cursor otherwise reports a :hover background.
  await page.mouse.move(1560, 12);
  await page.waitForTimeout(400);
  const dl = await page.evaluate(() => {
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--pd-accent-primary')
      .trim();
    const probe = document.createElement('div');
    probe.style.backgroundColor = accent;
    document.body.appendChild(probe);
    const accentRgb = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const info = (el) => {
      if (el === null) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? '').trim().slice(0, 32),
        background: cs.backgroundColor,
        accentFilled: cs.backgroundColor === accentRgb,
        color: cs.color,
        height: Math.round(r.height),
        width: Math.round(r.width),
        area: Math.round(r.width * r.height),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      };
    };
    return {
      accentRgb,
      downloadAll: info(document.querySelector('[data-testid="tp-download-all"]')),
      // per-card Download buttons only (not the panel, back or close)
      cardButtons: [...document.querySelectorAll('.tp-dlcard button[data-testid^="tp-download-"]')]
        .filter((b) => b.getAttribute('data-testid') !== 'tp-download-all')
        .map(info),
      loopsInCards: document.querySelectorAll('.tp-dlcard svg.cl').length,
      loopWrappersInCards: document.querySelectorAll('.tp-dlcard .tp-dlcard-loop').length,
      cards: document.querySelectorAll('.tp-dlcard').length,
    };
  });
  out.d5 = {
    downloadAll: dl.downloadAll,
    cardButtons: dl.cardButtons.slice(0, 3),
    accentRgb: dl.accentRgb,
  };
  out.d6 = { loopsInCards: dl.loopsInCards, cards: dl.cards };
  {
    const a = dl.downloadAll;
    const b = dl.cardButtons[0];
    // Demoted on every axis that carries visual weight and is independent of
    // how long the two labels happen to be: tier (accent fill), height, and
    // type size. Raw AREA is recorded in decisions.json for the before/after
    // diff but is not asserted against the card button — "Download all · 65.9
    // GB" is simply a longer string than "Download · 17.5 GB", so an area
    // comparison would be measuring the copy, not the hierarchy.
    const ok =
      a !== null &&
      b !== null &&
      !a.accentFilled &&
      b.accentFilled &&
      a.height <= b.height &&
      Number.parseFloat(a.fontSize) <= Number.parseFloat(b.fontSize);
    check(
      'D5',
      ok,
      `"Download all" accentFilled=${a?.accentFilled} ${a?.width}×${a?.height}=${a?.area}px² @${a?.fontSize} vs ` +
        `per-card accentFilled=${b?.accentFilled} ${b?.width}×${b?.height}=${b?.area}px² @${b?.fontSize}`,
    );
  }
  check(
    'D6',
    dl.loopsInCards === 0 && dl.cards > 0,
    `capability loops inside download cards = ${dl.loopsInCards} across ${dl.cards} cards (want 0)`,
  );
  await shot('D5-download-panel');
  await page.click('[data-testid="tp-download-back"]');

  // ── D4 · one accent-filled control per panel, on the Image panel ─────────
  // Deliver a real `gen3d:job` image artifact from the MAIN process, exactly as
  // the engine does, so the panel reaches its post-generation state without a
  // 25-second Mage-Flow run.
  const samplePng = path.join(appRoot, 'src/tripo/assets/anim-previews/idle.jpg');
  await app.evaluate(({ BrowserWindow }, imgPath) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('pi-desktop:event', {
        channel: 'gen3d:job',
        payload: {
          jobId: 'decisions-probe-image',
          stage: 'image',
          message: 'Generated image',
          stagePercent: 100,
          overallPercent: 100,
          artifact: { kind: 'image', path: imgPath, label: 'Generated image' },
          done: true,
        },
      });
    }
  }, samplePng);
  await page.click('[data-testid="tp-rail-image"]');
  await page.waitForSelector('[data-testid="tp-image-make3d"]', { timeout: 10000 });
  await page.mouse.move(1560, 12);
  await page.waitForTimeout(400);
  out.d4 = await page.evaluate(() => {
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--pd-accent-primary')
      .trim();
    const probe = document.createElement('div');
    probe.style.backgroundColor = accent;
    document.body.appendChild(probe);
    const accentRgb = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const panel = document.querySelector('[data-testid="tp-panel-image"]') ?? document.body;
    const hits = [];
    for (const el of panel.querySelectorAll('*')) {
      if (getComputedStyle(el).backgroundColor !== accentRgb) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      hits.push({
        testid: el.getAttribute('data-testid'),
        cls: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
        text: (el.textContent ?? '').trim().slice(0, 22),
        area: Math.round(r.width * r.height),
      });
    }
    const m = document.querySelector('[data-testid="tp-image-make3d"]');
    const g = document.querySelector('[data-testid="tp-image-generate-btn"]');
    const styleOf = (el) =>
      el === null
        ? null
        : {
            cls: el.className,
            background: getComputedStyle(el).backgroundColor,
            color: getComputedStyle(el).color,
            accentFilled: getComputedStyle(el).backgroundColor === accentRgb,
          };
    return {
      accentFilledInPanel: hits.sort((a, b) => b.area - a.area),
      count: hits.length,
      make3d: styleOf(m),
      generateImage: styleOf(g),
    };
  });
  check(
    'D4',
    out.d4.count === 1 &&
      out.d4.generateImage?.accentFilled === true &&
      out.d4.make3d?.accentFilled === false,
    `accent-filled controls on the Image panel = ${out.d4.count} ` +
      `(Generate Image=${out.d4.generateImage?.accentFilled}, Make 3D=${out.d4.make3d?.accentFilled})`,
  );
  await shot('D4-image-panel');

  // ── D11 · semantic class names, testids untouched ────────────────────────
  // Walk every panel so the sweep sees every button these classes ever paint.
  const RAILS = ['image', 'model', 'segment', 'retopo', 'texture', 'animate'];
  const legacy = { 'tp-generate-btn': 0, 'tp-retry-btn': 0, 'tp-upload-btn': 0 };
  const semantic = {};
  const testids = new Set();
  const smallText = new Map();
  for (const rail of RAILS) {
    await page.click(`[data-testid="tp-rail-${rail}"]`);
    await page.waitForTimeout(280);
    const seen = await page.evaluate(() => {
      const legacyHits = {};
      for (const c of ['tp-generate-btn', 'tp-retry-btn', 'tp-upload-btn'])
        legacyHits[c] = document.querySelectorAll(`.${c}`).length;
      const sem = {};
      for (const c of ['tp-btn-primary', 'tp-btn-tonal', 'tp-btn-quiet'])
        sem[c] = document.querySelectorAll(`.${c}`).length;
      const ids = [...document.querySelectorAll('[data-testid^="tp-"]')].map((e) =>
        e.getAttribute('data-testid'),
      );
      // sub-11px, text-bearing, in the studio
      const small = [];
      for (const el of document.querySelectorAll('[class*="tp-"], [class*="cl-"]')) {
        const txt = (el.textContent ?? '').trim();
        if (txt.length === 0 || el.children.length > 0) continue;
        const cs = getComputedStyle(el);
        const px = Number.parseFloat(cs.fontSize);
        if (px >= 11) continue;
        small.push({
          cls: typeof el.className === 'string' ? el.className.slice(0, 40) : el.tagName,
          text: txt.slice(0, 18),
          px,
        });
      }
      return { legacyHits, sem, ids, small };
    });
    for (const [k, v] of Object.entries(seen.legacyHits)) legacy[k] += v;
    for (const [k, v] of Object.entries(seen.sem)) semantic[k] = (semantic[k] ?? 0) + v;
    for (const id of seen.ids) testids.add(id);
    for (const s of seen.small) smallText.set(`${s.cls}|${s.text}`, s);
  }
  out.d11 = { legacyClassNodes: legacy, semanticClassNodes: semantic, testidCount: testids.size };
  {
    const total = Object.values(legacy).reduce((a, b) => a + b, 0);
    const semTotal = Object.values(semantic).reduce((a, b) => a + b, 0);
    check(
      'D11',
      total === 0 && semTotal > 0,
      `legacy class nodes ${JSON.stringify(legacy)} → semantic ${JSON.stringify(semantic)}`,
    );
  }

  // ── D2 · type floor + the two WCAG failures ─────────────────────────────
  // (a) the source rule: nothing in tripo.css may declare below 11px.
  const css = readFileSync(path.join(appRoot, 'src/tripo/tripo.css'), 'utf8');
  const declared = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) =>
    Number.parseFloat(m[1]),
  );
  const belowFloorDeclared = declared.filter((n) => n < 11);
  // (b) what the running app actually renders, swept over every panel above.
  out.d2 = {
    declaredBelow11: belowFloorDeclared.sort((a, b) => a - b),
    declaredTotal: declared.length,
    renderedBelow11: [...smallText.values()].sort((a, b) => a.px - b.px),
  };
  check(
    'D2-floor',
    belowFloorDeclared.length === 0 && out.d2.renderedBelow11.length === 0,
    `tripo.css declares ${belowFloorDeclared.length} sub-11px sizes [${belowFloorDeclared.join(',')}]; ` +
      `app renders ${out.d2.renderedBelow11.length} sub-11px text nodes`,
  );

  // (c) the gizmo axis balls, across all six flavors.
  await page.click('[data-testid="tp-rail-model"]');
  const axis = {};
  for (const [f, m] of THEMES) {
    await setTheme(f, m);
    axis[`${f}-${m}`] = await page.evaluate((fnSrc) => {
      // biome-ignore lint/security/noGlobalEval: probe-local helper, source is this file
      const contrast = eval(fnSrc);
      const rows = {};
      for (const ax of ['x', 'y', 'z']) {
        const el = document.querySelector(`.tp-axball-${ax}`);
        if (el === null) continue;
        const cs = getComputedStyle(el);
        rows[ax] = {
          fontSize: Number.parseFloat(cs.fontSize),
          color: cs.color,
          background: cs.backgroundColor,
          ratio: contrast(cs.color, cs.backgroundColor),
        };
      }
      return rows;
    }, CONTRAST_FN);
  }
  out.d2axis = axis;
  {
    const worst = Object.entries(axis).flatMap(([theme, rows]) =>
      Object.entries(rows).map(([ax, r]) => ({ theme, ax, ...r })),
    );
    const failing = worst.filter((r) => r.ratio === null || r.ratio < 4.5);
    const minPx = Math.min(...worst.map((r) => r.fontSize));
    check(
      'D2-axis',
      failing.length === 0 && minPx >= 11,
      `axis balls: ${minPx}px, worst contrast ${Math.min(...worst.map((r) => r.ratio ?? 0))}:1, ` +
        `${failing.length} below 4.5:1 [${failing.map((r) => `${r.theme}/${r.ax}=${r.ratio}`).join(' ')}]`,
    );
  }

  // ── theme sweep screenshots (3 flavors × light/dark) ─────────────────────
  for (const [f, m] of THEMES) {
    await setTheme(f, m);
    await shot(`T-${f}-${m}`);
  }
  // …and the download panel in both modes, since D5/D6 live there.
  await page.click('[data-testid="tp-rail-segment"]');
  await page.click('[data-testid="tp-segment-btn"]');
  await page.waitForSelector('[data-testid="tp-download-panel"]', { timeout: 10000 });
  for (const [f, m] of [
    ['bobble', 'dark'],
    ['bobble', 'light'],
    ['codex', 'light'],
  ]) {
    await setTheme(f, m);
    await shot(`TD-download-${f}-${m}`);
  }
  await setTheme('bobble', 'dark');

  writeFileSync(path.join(OUT, 'decisions.json'), JSON.stringify(out, null, 2));
  console.log(`\ndecisions.json + screenshots → ${OUT}`);
  if (failures.length > 0 && !BASELINE) {
    console.error(`\ntripo-decisions-probe FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else if (failures.length > 0) {
    console.log(`\n(baseline mode: ${failures.length} not-yet-implemented decisions recorded)`);
  } else {
    console.log('\ntripo-decisions-probe PASSED — every decision measured in the running app.');
  }
} catch (e) {
  console.error('tripo-decisions-probe ERROR', e.stack ?? e.message);
  writeFileSync(path.join(OUT, 'decisions.json'), JSON.stringify(out, null, 2));
  await page?.screenshot({ path: path.join(OUT, 'ZZ-error.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
}
