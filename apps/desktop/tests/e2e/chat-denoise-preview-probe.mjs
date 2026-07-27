/**
 * chat-denoise-preview-probe — proves the live denoising placeholder is showing
 * the MODEL'S OWN intermediate frames, in the real app, during a real
 * generation, and that it holds still while it does it.
 *
 * The claims this probe has to defend are all about MOTION, which a single
 * end-state screenshot cannot see. Two of them exist because jedd caught the
 * first cut failing them by eye:
 *
 *   A. the card grows out of its top-left corner AT THE START, once — not on
 *      the last denoising step;
 *   B. nothing jumps when a new frame lands: the image box must occupy exactly
 *      the same rectangle before, during and after every swap;
 *   C. the frames are real and VISIBLY DIFFERENT FROM EACH OTHER;
 *   D. the tween keeps moving in the ~1.3 s gaps between real frames.
 *
 * So the measurement is an in-page rAF recorder that runs for the WHOLE
 * generation — installed before the card exists — sampling the plate's
 * clip-path and the frame element's bounding rect on every animation frame.
 * A jump of one pixel for one frame shows up in that record; it would not show
 * up in any number of screenshots. The screenshots are for jedd's eyes; the
 * assertions are on the record.
 *
 * Requires a built app (`pnpm build`) and the gen3d image weights installed.
 * Env:
 *   OUT        screenshot dir (default <tmp>/chat-denoise-preview)
 *   MODES      comma list of theme modes to run (default "light,dark")
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(tmpdir(), 'chat-denoise-preview');
const MODES = (process.env.MODES ?? 'light,dark').split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });

if (!existsSync(path.join(appRoot, 'dist-electron/main.js'))) {
  console.error('probe: app is not built — run `pnpm build` first');
  process.exit(2);
}

const results = [];
const record = (stage, ok, detail) => {
  results.push({ stage, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}\n      ${detail}`);
};

/** One JSON line in, one JSON line out — the gen3d bridge protocol. */
function bridgeCall(sock, token, method, params, timeoutMs = 15 * 60_000) {
  return new Promise((resolve) => {
    const socket = net.connect(sock);
    let buf = '';
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, error: `probe timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );
    socket.on('connect', () => {
      socket.setEncoding('utf8');
      socket.write(`${JSON.stringify({ id: 1, token, method, params })}\n`);
    });
    socket.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        done(JSON.parse(buf.slice(0, nl)));
      } catch {
        done({ ok: false, error: 'unparseable reply' });
      }
    });
    socket.on('error', (e) => done({ ok: false, error: String(e) }));
  });
}

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-dn-home-')));
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(path.join(home, '.pi', 'desktop', 'onboarding.json'), JSON.stringify({ done: true }));
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    version: 1,
    theme: { flavor: 'bobble', mode: 'dark' },
    permissionMode: 'bypass',
    effort: 'medium',
    enginePreference: 'llamacpp',
    effortMode: 'manual',
  }),
);
const realCache = path.join(homedir(), '.cache', 'pi-desktop');

/** The recorder, installed in the page before the card exists. It waits for the
 * plate to appear and then samples on every animation frame until stopped. */
const RECORDER = `
window.__dn = { t0: null, samples: [], stop: false };
(function install() {
  const tick = () => {
    if (window.__dn.stop) return;
    const plate = document.querySelector('.pd-denoise-plate');
    if (plate !== null) {
      if (window.__dn.t0 === null) window.__dn.t0 = performance.now();
      const img = document.querySelector('[data-testid="denoise-frame"]');
      const pr = plate.getBoundingClientRect();
      const ir = img === null ? null : img.getBoundingClientRect();
      window.__dn.samples.push({
        t: Math.round(performance.now() - window.__dn.t0),
        clip: getComputedStyle(plate).clipPath,
        plate: [Math.round(pr.x * 100) / 100, Math.round(pr.y * 100) / 100,
                Math.round(pr.width * 100) / 100, Math.round(pr.height * 100) / 100],
        img: ir === null ? null : [Math.round(ir.x * 100) / 100, Math.round(ir.y * 100) / 100,
                Math.round(ir.width * 100) / 100, Math.round(ir.height * 100) / 100],
        src: img === null ? null : (img.getAttribute('src') ?? '').slice(-24),
        resolve: Number.parseFloat(
          getComputedStyle(document.querySelector('[data-testid="thread-image-placeholder"]') ?? plate)
            .getPropertyValue('--pd-dn-resolve') || '0'),
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;

/** `inset(0px 61.68% 61.68% 0px round 10px)` → the right/bottom insets.
 * Chromium reports PERCENT mid-animation and px at rest, so both units must be
 * accepted — matching only `px` reads every sample as zero and calls a working
 * animation broken. */
function insetOf(clip) {
  const m = /inset\(([^)]*)\)/.exec(clip ?? '');
  if (m === null) return null;
  const box = (m[1].match(/-?[\d.]+(?:px|%)/g) ?? []).map(Number.parseFloat);
  if (box.length < 3) return null;
  const pct = /%/.test(m[1]);
  // At rest the inset is `0px`; mid-animation it is a percentage. Either way a
  // non-zero right/bottom means the card is not fully revealed.
  return { right: box[1], bottom: box[2], pct };
}

async function runMode(mode) {
  const tag = `${mode}`;
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-dn-udd-'))}`],
    env: {
      ...process.env,
      HOME: home,
      PI_E2E: '1',
      PI_DESKTOP_CACHE_DIR: realCache,
      GEN3D_CACHE_DIR: path.join(realCache, 'gen3d'),
    },
  });

  const shots = [];
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
    await page.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });

    // The theme file is read at boot, but the OS appearance can still win; pin
    // the mode on the root element so the card is provably rendered under the
    // tokens this run claims to be testing.
    const tokens = await page.evaluate((m) => {
      document.documentElement.setAttribute('data-mode', m);
      const cs = getComputedStyle(document.documentElement);
      return {
        mode: document.documentElement.getAttribute('data-mode'),
        flavor: document.documentElement.getAttribute('data-flavor'),
        bg: cs.getPropertyValue('--pd-bg-inset').trim(),
        accent: cs.getPropertyValue('--pd-accent-primary').trim(),
      };
    }, mode);
    record(
      `${tag} 0 rendered under the ${mode} tokens`,
      tokens.mode === mode && tokens.bg.length > 0,
      `flavor=${tokens.flavor} mode=${tokens.mode} --pd-bg-inset=${tokens.bg} --pd-accent-primary=${tokens.accent}`,
    );

    const env = await app.evaluate(() => ({
      sock: process.env.PI_DESKTOP_GEN3D_SOCK,
      token: process.env.PI_DESKTOP_GEN3D_TOKEN,
    }));
    if (!env.sock) throw new Error('no gen3d bridge socket');

    // Recorder FIRST — the entrance animation is the thing under test, so the
    // sampler has to be running before the card can possibly exist.
    await page.evaluate(RECORDER);

    // ---- Mount a RUNNING image tool call, exactly as the router would -------
    // Order matters: setMessagesExternal resets runningToolCalls (it is a
    // session load), so the call is marked running only after the messages land.
    await page.evaluate(() => {
      const s = window.__pi_store().getState();
      const now = Date.now();
      s.setMessagesExternal([
        { kind: 'user', id: 'dn-u', text: 'draw me a red bicycle', timestamp: now },
        {
          kind: 'assistant',
          id: 'dn-a',
          timestamp: now + 1,
          isStreaming: true,
          blocks: [
            { type: 'text', text: 'Making that now.' },
            {
              type: 'toolCall',
              id: 'dn-gen',
              name: 'generate_image',
              arguments: { prompt: 'a red bicycle leaning against a white wall' },
            },
          ],
        },
      ]);
      // `toolExecutionStart` lives on the event-router's SINK, not on the
      // store's own actions, so the running set is seeded directly — this is
      // the same field the sink writes, read by `chainRunningFlags`.
      window.__pi_store().setState({ runningToolCalls: ['dn-gen'] });
    });
    await page.waitForSelector('[data-testid="thread-image-placeholder"]', { timeout: 15_000 });

    const cardShot = async (name) => {
      const p = path.join(OUT, `${tag}-${name}.png`);
      // Re-queried per shot, never cached: the placeholder unmounts when the
      // tool settles and mounts again for the reduced-motion pass, so a held
      // handle goes stale exactly when the last evidence is being captured.
      const el = await page.$('.pd-denoise-plate');
      if (el === null) throw new Error(`no denoise card on screen for shot ${name}`);
      await el.screenshot({ path: p });
      shots.push(p);
      return p;
    };
    const fullShot = async (name) => {
      const p = path.join(OUT, `${tag}-${name}.png`);
      await page.screenshot({ path: p });
      shots.push(p);
      return p;
    };

    // Two shots inside the entrance window, for jedd's eyes. The assertion is
    // on the recorder below; these are so the growth is visible in the sequence.
    await cardShot('01-grow-a');
    await cardShot('01-grow-b');

    // ---- 1. Does it grow AT THE START? -------------------------------------
    await page.waitForTimeout(900);
    const entrance = await page.evaluate(() => window.__dn.samples.slice());
    const eIns = entrance.map((s) => ({ t: s.t, ...(insetOf(s.clip) ?? {}) }));
    const early = eIns.filter((s) => s.t <= 140 && (s.right ?? 0) > 5);
    const opened = eIns.filter((s) => s.t >= 500 && (s.right ?? 99) < 1);
    const midway = eIns.filter((s) => (s.right ?? 0) > 5 && (s.right ?? 0) < 95);
    const grewAtStart = early.length >= 1 && opened.length >= 1 && midway.length >= 4;
    record(
      `${tag} 1 the card grows from its top-left AT THE START (entrance, not finish)`,
      grewAtStart,
      eIns.length === 0
        ? 'no samples — the recorder never saw the card'
        : `${eIns.length} rAF samples: partly-open before 140ms=${early.length}, ` +
            `${midway.length} intermediate states, fully open by 500ms=${opened.length > 0}; ` +
            `first inset right=${eIns[0]?.right?.toFixed(0)}${eIns[0]?.pct ? '%' : 'px'}`,
    );

    // ---- 2. The idle texture, before any frame exists ----------------------
    const waiting = await page.getAttribute(
      '[data-testid="thread-image-placeholder"]',
      'data-phase',
    );
    await cardShot('02-idle');
    record(
      `${tag} 2 the waiting card shows an idle texture, not an empty box`,
      waiting === 'waiting',
      `data-phase=${waiting} (no frame has arrived yet)`,
    );

    // ---- 3. The real generation, recorded frame by frame -------------------
    console.log(`\n  … ${tag}: running a REAL generation, recording every animation frame`);
    const t0 = Date.now();
    const genPromise = bridgeCall(env.sock, env.token, 'generate_image', {
      prompt: 'a red bicycle leaning against a white wall, soft daylight, photographic',
    });

    const seen = new Map();
    const frameLog = [];
    let settled = null;
    genPromise.then((r) => {
      settled = r;
    });
    while (settled === null && Date.now() - t0 < 6 * 60_000) {
      const cur = await page.evaluate(() => {
        const img = document.querySelector('[data-testid="denoise-frame"]');
        return img?.getAttribute('src') ?? null;
      });
      if (cur !== null && cur.length > 0 && !seen.has(cur)) {
        const at = Date.now() - t0;
        const n = seen.size;
        const p = await cardShot(`03-frame${n}`);
        seen.set(cur, { at, shot: p });
        frameLog.push({ n, atMs: at });
        console.log(`      frame ${n} at ${(at / 1000).toFixed(2)}s → ${path.basename(p)}`);
      }
      await page.waitForTimeout(120);
    }
    const gen = settled ?? (await genPromise);
    const run = await page.evaluate(() => {
      window.__dn.stop = true;
      return window.__dn.samples.slice();
    });

    record(
      `${tag} 3 real intermediate frames reached the card`,
      seen.size >= 2,
      `${seen.size} distinct frames; arrivals ${frameLog.map((f) => `${(f.atMs / 1000).toFixed(2)}s`).join(', ')}`,
    );

    // ---- 3b. Are those frames actually DIFFERENT pictures? -----------------
    // Decoded in-page onto a canvas and compared per-pixel. Distinct data URIs
    // would only prove distinct bytes; this proves the card is showing the
    // picture changing.
    const diffs = await page.evaluate(
      async (srcs) => {
        const load = (src) =>
          new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => rej(new Error('decode failed'));
            i.src = src;
          });
        const N = 64;
        const data = [];
        for (const src of srcs) {
          const img = await load(src);
          const c = document.createElement('canvas');
          c.width = N;
          c.height = N;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, N, N);
          data.push(ctx.getImageData(0, 0, N, N).data);
        }
        const out = [];
        for (let k = 1; k < data.length; k++) {
          const a = data[k - 1];
          const b = data[k];
          let sum = 0;
          for (let i = 0; i < a.length; i += 4) {
            sum +=
              Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          }
          out.push(sum / ((a.length / 4) * 3));
        }
        return out;
      },
      [...seen.keys()],
    );
    // A JPEG re-encode of the SAME picture lands under ~2 mean levels; a real
    // denoise step moves whole regions. 4 is comfortably above encoder noise and
    // well under what the measured steps produce.
    const distinct = diffs.filter((d) => d >= 4).length;
    record(
      `${tag} 3b consecutive frames are visibly different pictures`,
      diffs.length >= 1 && distinct >= Math.max(1, diffs.length - 1),
      `mean per-pixel difference between consecutive frames: ${diffs.map((d) => d.toFixed(1)).join(', ')} (0-255 scale)`,
    );

    // ---- 4. NOTHING JUMPS when a frame lands -------------------------------
    // The defect this replaces: a frame that mounted as a new element painted
    // once at the document origin before layout put it in the row, so every
    // step flashed across the window. If that happens even for a single
    // animation frame, the recorded rect changes — so the assertion is that the
    // rect is IDENTICAL in every sample of the whole run.
    const withImg = run.filter((s) => s.img !== null);
    const rects = new Map();
    for (const s of withImg) {
      const key = s.img.join(',');
      if (!rects.has(key)) rects.set(key, { first: s.t, last: s.t, n: 0 });
      const e = rects.get(key);
      e.last = s.t;
      e.n += 1;
    }
    // Sample the boundary directly too: the rect on the frames either side of
    // every source change.
    const swaps = [];
    for (let i = 1; i < withImg.length; i++) {
      if (withImg[i].src !== withImg[i - 1].src) {
        swaps.push({
          t: withImg[i].t,
          before: withImg[i - 1].img.join(','),
          after: withImg[i].img.join(','),
        });
      }
    }
    const jumped = swaps.filter((s) => s.before !== s.after);
    record(
      `${tag} 4 the image box never moves — no jump when a frame lands`,
      rects.size === 1 && jumped.length === 0 && swaps.length >= 2,
      `${withImg.length} recorded frames, ${swaps.length} source swaps, ` +
        `${rects.size} distinct rect(s): ${[...rects.keys()].join(' | ')}` +
        (jumped.length > 0
          ? ` — JUMPED at ${jumped.map((j) => `${j.t}ms ${j.before}→${j.after}`).join('; ')}`
          : ''),
    );

    // ---- 5. The entrance animation never replays ---------------------------
    // jedd's other report: the card kept collapsing back into its corner and
    // re-opening on later steps. After the entrance window the plate must stay
    // fully revealed for the rest of the run, every single sample.
    const afterEntrance = run.filter((s) => s.t > 900);
    const reopened = afterEntrance.filter((s) => (insetOf(s.clip)?.right ?? 0) > 0.5);
    record(
      `${tag} 5 the entrance animation runs ONCE and never replays mid-run`,
      afterEntrance.length > 100 && reopened.length === 0,
      `${afterEntrance.length} samples after the entrance window, ${reopened.length} of them partly closed` +
        (reopened.length > 0 ? ` (first at ${reopened[0].t}ms)` : ''),
    );

    // ---- 6. The tween keeps moving BETWEEN real frames ---------------------
    // With frames ~1.3 s apart, a card that only changes on arrivals is dead
    // for most of the run. Take the longest gap between source swaps and check
    // --pd-dn-resolve actually climbed across it.
    let worstGap = { span: 0, delta: 0 };
    for (let i = 1; i < swaps.length; i++) {
      const a = swaps[i - 1].t;
      const b = swaps[i].t;
      const inGap = run.filter((s) => s.t > a + 60 && s.t < b - 60);
      if (inGap.length < 3) continue;
      const delta = inGap[inGap.length - 1].resolve - inGap[0].resolve;
      if (b - a > worstGap.span) worstGap = { span: b - a, delta, samples: inGap.length };
    }
    record(
      `${tag} 6 the tween keeps resolving in the gaps between real frames`,
      worstGap.span > 0 && worstGap.delta > 0.002,
      `longest gap ${worstGap.span}ms (${worstGap.samples ?? 0} samples): --pd-dn-resolve moved +${worstGap.delta?.toFixed(4)}`,
    );

    // ---- 7. The finished image lands in the same box -----------------------
    const plateRect = run.length > 0 ? run[run.length - 1].plate : null;
    if (gen.ok === true && typeof gen.path === 'string') {
      await page.evaluate(
        ({ p, url }) => {
          // The tool settling, as the store sees it: the result row appended
          // and the call dropped from the running set. `upsertToolResult` is a
          // sink method, not a store action, so the same end state is written
          // through the thread the sink writes to.
          const st = window.__pi_store().getState();
          st.setMessagesExternal([
            ...st.messages,
            {
              kind: 'toolResult',
              id: 'tr-dn-a-dn-gen',
              toolCallId: 'dn-gen',
              assistantId: 'dn-a',
              toolName: 'generate_image',
              text: `${url}\nGenerated image saved at ${p}`,
              isError: false,
              timestamp: Date.now(),
            },
          ]);
          window.__pi_store().setState({ runningToolCalls: [] });
        },
        { p: gen.path, url: `pd-file://f${gen.path.split('/').map(encodeURIComponent).join('/')}` },
      );
      await page.waitForFunction(
        () => {
          const i = document.querySelector('[data-testid="thread-image"] img');
          return i !== null && i.complete && i.naturalWidth > 0;
        },
        { timeout: 20_000 },
      );
      await page.waitForTimeout(350);
      const finalRect = await page.evaluate(() => {
        const i = document.querySelector('[data-testid="thread-image"] img');
        const r = i.getBoundingClientRect();
        return [
          Math.round(r.x * 100) / 100,
          Math.round(r.y * 100) / 100,
          Math.round(r.width * 100) / 100,
          Math.round(r.height * 100) / 100,
        ];
      });
      const finalShot = await fullShot('04-final');
      const gone = await page.$('[data-testid="thread-image-placeholder"]');
      // The finished picture should land in the SAME rectangle the card held,
      // so the handover is a change of content and not of layout.
      const sameBox =
        plateRect !== null &&
        Math.abs(finalRect[2] - plateRect[2]) <= 2 &&
        Math.abs(finalRect[3] - plateRect[3]) <= 2;
      record(
        `${tag} 7 the finished image replaces the card in the same box`,
        gone === null && sameBox,
        `card ${plateRect?.slice(2).join('x')} → image ${finalRect.slice(2).join('x')} — ${finalShot}`,
      );
    } else {
      record(`${tag} 7 the finished image replaces the card`, false, JSON.stringify(gen));
    }

    // ---- 8. Reduced motion: the frames stay, the motion goes ---------------
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      const st = window.__pi_store().getState();
      st.setMessagesExternal([
        { kind: 'user', id: 'dn-u2', text: 'again', timestamp: Date.now() },
        {
          kind: 'assistant',
          id: 'dn-a2',
          timestamp: Date.now() + 1,
          isStreaming: true,
          blocks: [
            { type: 'toolCall', id: 'dn-gen2', name: 'generate_image', arguments: { prompt: 'x' } },
          ],
        },
      ]);
      window.__pi_store().setState({ runningToolCalls: ['dn-gen2'] });
    });
    await page.waitForSelector('[data-testid="thread-image-placeholder"]', { timeout: 10_000 });
    const rm = await page.evaluate(() => {
      const names = (sel) => {
        const el = document.querySelector(sel);
        return el === null ? 'missing' : getComputedStyle(el).animationName;
      };
      const plate = document.querySelector('.pd-denoise-plate');
      return {
        plate: names('.pd-denoise-plate'),
        weave: names('.pd-denoise-weave'),
        grain: names('.pd-denoise-grain'),
        settle: plate === null ? 'missing' : getComputedStyle(plate, '::after').animationName,
        // WAAPI animations are invisible to the media query, so the component
        // has to decline to start them; nothing running is the proof.
        waapi: document.querySelectorAll('.pd-denoise *').length
          ? [...document.querySelectorAll('.pd-denoise, .pd-denoise *')].reduce(
              (n, el) => n + el.getAnimations().length,
              0,
            )
          : -1,
      };
    });
    const allStill =
      rm.plate === 'none' &&
      rm.weave === 'none' &&
      rm.grain === 'none' &&
      rm.settle === 'none' &&
      rm.waapi === 0;
    await cardShot('05-reduced-motion');
    record(
      `${tag} 8 prefers-reduced-motion turns every animation off`,
      allStill,
      JSON.stringify(rm),
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  } catch (err) {
    console.error(`\n${tag} probe error: ${err?.stack ?? err}`);
    results.push({ stage: `${tag} probe`, ok: false, detail: String(err?.message ?? err) });
  } finally {
    await app.close();
  }
  return shots;
}

const allShots = [];
for (const mode of MODES) {
  // Strictly sequential: one heavy model job at a time on a 24 GB machine.
  allShots.push(...(await runMode(mode)));
}

console.log('\n================ SUMMARY ================');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.stage}`);
console.log(`\n${allShots.length} shots in ${OUT}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
