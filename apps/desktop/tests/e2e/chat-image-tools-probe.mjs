/**
 * chat-image-tools-probe — proves the chat's `generate_image` / `edit_image`
 * tools work against the REAL engine in the REAL app, and that their results
 * render INLINE in the chat transcript.
 *
 * Three stages, each independently reported so a partial run still yields real
 * evidence:
 *
 *   A. BRIDGE + ENGINE. Read the socket/token the main process published, speak
 *      the bridge protocol directly, and run a real generation. Proves the env
 *      reaches a child, the socket is alive, the engine runs, and a PNG lands on
 *      disk. Then edit that PNG, proving the Mage-Flow-Edit path (or reporting
 *      its refusal cleanly if the edit weights aren't installed).
 *   B. INLINE RENDER. Feed the tool call + result through the app's OWN chat
 *      store the way the pi event-router does, then assert the transcript shows
 *      a ThreadImage whose <img> ACTUALLY DECODED (naturalWidth > 0) — i.e. the
 *      pd-file scheme served it and the CSP allowed it. Screenshot.
 *   C. FULL CHAT. Type a plain-English request into the real composer and let
 *      the real local model decide to call the tool. Screenshot.
 *
 * Requires a built app (`pnpm build`) and the gen3d image weights installed.
 * Env:
 *   OUT          screenshot dir (default <tmp>/chat-image-tools)
 *   SKIP_CHAT=1  stop after stage B (skip driving the local LLM)
 *   CHAT_MODEL   model id to pin for stage C (default qwen3.5-4b-mtp)
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(tmpdir(), 'chat-image-tools');
const SKIP_CHAT = process.env.SKIP_CHAT === '1';
const CHAT_MODEL = process.env.CHAT_MODEL ?? 'qwen3.5-4b-mtp';
mkdirSync(OUT, { recursive: true });

if (!existsSync(path.join(appRoot, 'dist-electron/main.js'))) {
  console.error('probe: app is not built — run `pnpm build` first');
  process.exit(2);
}

// A scratch HOME so the probe never pollutes the real session list, but the REAL
// caches so the chat model and the image weights are actually found.
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-img-home-')));
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    version: 1,
    theme: { flavor: 'bobble', mode: 'light' },
    permissionMode: 'bypass',
    effort: 'medium',
    enginePreference: 'llamacpp',
    modelSelection: { mode: 'model', modelId: CHAT_MODEL },
    effortMode: 'manual',
  }),
);
writeFileSync(path.join(home, '.pi', 'desktop', 'onboarding.json'), JSON.stringify({ done: true }));

const realCache = path.join(homedir(), '.cache', 'pi-desktop');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-img-udd-'))}`],
  env: {
    ...process.env,
    HOME: home,
    PI_E2E: '1',
    // Real weights: the chat models + llama.cpp binaries, and the gen3d engine.
    PI_DESKTOP_CACHE_DIR: realCache,
    GEN3D_CACHE_DIR: path.join(realCache, 'gen3d'),
  },
});

const results = [];
const record = (stage, ok, detail) => {
  results.push({ stage, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}\n      ${detail}`);
};

/** Speak the gen3d bridge protocol: one JSON line in, one JSON line out. */
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

let page;
const shot = async (name) => {
  await page.waitForTimeout(400);
  const p = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: p });
  console.log(`      shot: ${p}`);
  return p;
};

try {
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });

  // ---- Stage A: the bridge env the pi child would read -------------------
  const env = await app.evaluate(() => ({
    sock: process.env.PI_DESKTOP_GEN3D_SOCK,
    token: process.env.PI_DESKTOP_GEN3D_TOKEN,
  }));
  record(
    'A1 bridge env published before any pi spawn',
    typeof env.sock === 'string' && env.sock.length > 0 && (env.token ?? '').length > 16,
    `sock=${env.sock} token=${(env.token ?? '').slice(0, 8)}…`,
  );
  if (!env.sock) throw new Error('no bridge socket — nothing further can be verified');

  // An unauthorized call must be refused, not served.
  const unauth = await bridgeCall(
    env.sock,
    'wrong-token',
    'generate_image',
    { prompt: 'x' },
    10_000,
  );
  record(
    'A2 bridge rejects a bad token',
    unauth.ok === false && unauth.error === 'unauthorized',
    JSON.stringify(unauth),
  );

  // The real thing: generate an image through the real engine.
  console.log('\n  … running a REAL generation (first call also loads the model; be patient)');
  const t0 = Date.now();
  const gen = await bridgeCall(env.sock, env.token, 'generate_image', {
    prompt: 'a red bicycle leaning against a white wall, soft daylight, photographic',
  });
  const genSecs = Math.round((Date.now() - t0) / 1000);
  const genOk = gen.ok === true && typeof gen.path === 'string' && existsSync(gen.path);
  record(
    'A3 generate_image produced a real PNG',
    genOk,
    genOk
      ? `${gen.path} (${Math.round(statSync(gen.path).size / 1024)} KB, ${genSecs}s)`
      : `${JSON.stringify(gen)} after ${genSecs}s`,
  );

  // The edit path, on the image we just made.
  let edit = { ok: false, error: 'skipped (no source image)' };
  let editSecs = 0;
  if (genOk) {
    console.log('  … running a REAL edit');
    const t1 = Date.now();
    edit = await bridgeCall(env.sock, env.token, 'edit_image', {
      imagePath: gen.path,
      instruction: 'make the bicycle bright yellow',
    });
    editSecs = Math.round((Date.now() - t1) / 1000);
  }
  const editOk = edit.ok === true && typeof edit.path === 'string' && existsSync(edit.path);
  record(
    'A4 edit_image produced a real PNG',
    editOk,
    editOk
      ? `${edit.path} (${Math.round(statSync(edit.path).size / 1024)} KB, ${editSecs}s)`
      : `NOT VERIFIED AS SUCCESS — engine said: ${JSON.stringify(edit)}`,
  );

  // ---- Stage B: does it RENDER INLINE in the chat? -----------------------
  // Feed the tool call + its result through the app's own store exactly as the
  // pi event-router does for a real tool call.
  if (genOk) {
    const pdUrl = (p) => `pd-file://f${p.split('/').map(encodeURIComponent).join('/')}`;
    await page.evaluate(
      ({ genPath, genUrl, editPath, editUrl, hasEdit }) => {
        const store = window.__pi_store();
        const s = store.getState();
        const now = Date.now();
        const blocks = [
          { type: 'text', text: 'Here is the image you asked for.' },
          {
            type: 'toolCall',
            id: 'probe-gen',
            name: 'generate_image',
            arguments: { prompt: 'a red bicycle' },
          },
        ];
        if (hasEdit) {
          blocks.push({
            type: 'toolCall',
            id: 'probe-edit',
            name: 'edit_image',
            arguments: { image_path: genPath, instruction: 'make the bicycle bright yellow' },
          });
        }
        s.setMessagesExternal([
          {
            kind: 'user',
            id: 'probe-u',
            text: 'make me a picture of a red bicycle',
            timestamp: now,
          },
          { kind: 'assistant', id: 'probe-a', blocks, timestamp: now + 1 },
          {
            kind: 'toolResult',
            id: 'tr-probe-a-probe-gen',
            toolCallId: 'probe-gen',
            assistantId: 'probe-a',
            toolName: 'generate_image',
            text: `${genUrl}\nGenerated image saved at ${genPath}`,
            isError: false,
            timestamp: now + 2,
          },
          ...(hasEdit
            ? [
                {
                  kind: 'toolResult',
                  id: 'tr-probe-a-probe-edit',
                  toolCallId: 'probe-edit',
                  assistantId: 'probe-a',
                  toolName: 'edit_image',
                  text: `${editUrl}\nEdited image saved at ${editPath}`,
                  isError: false,
                  timestamp: now + 3,
                },
              ]
            : []),
        ]);
      },
      {
        genPath: gen.path,
        genUrl: pdUrl(gen.path),
        editPath: editOk ? edit.path : '',
        editUrl: editOk ? pdUrl(edit.path) : '',
        hasEdit: editOk,
      },
    );

    await page.waitForSelector('[data-testid="thread-image"]', { timeout: 15_000 });
    // The decisive check: the browser DECODED the bytes. A broken src leaves
    // naturalWidth at 0, so this cannot pass on a URL that merely looks right.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="thread-image"] img')].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      { timeout: 20_000 },
    );
    const imgs = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="thread-image"] img')].map((i) => ({
        src: i.getAttribute('src'),
        w: i.naturalWidth,
        h: i.naturalHeight,
      })),
    );
    record(
      'B1 image renders INLINE in the chat transcript and decodes',
      imgs.length >= 1 && imgs.every((i) => i.w > 0 && (i.src ?? '').startsWith('pd-file://')),
      imgs.map((i) => `${i.w}x${i.h} ${i.src?.slice(0, 70)}…`).join(' | '),
    );
    record(
      'B2 the EDITED image also renders inline',
      editOk && imgs.length >= 2,
      editOk ? `${imgs.length} inline images` : 'edit not available — see A4',
    );

    // The tool rows must read as pictures, not as a file edit.
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter(
          (e) =>
            e.children.length === 0 &&
            /^(Generated|Edited) an image$/.test(e.textContent?.trim() ?? ''),
        )
        .map((e) => e.textContent.trim()),
    );
    record(
      'B3 tool rows read "Generated/Edited an image"',
      labels.includes('Generated an image') && (!editOk || labels.includes('Edited an image')),
      JSON.stringify(labels),
    );
    await shot('B-inline-images');

    // Click through to the fullscreen lightbox — the interaction jedd cares about.
    await page.click('[data-testid="thread-image"]');
    await page.waitForSelector('[data-testid="image-lightbox"]', { timeout: 5_000 });
    await shot('B-lightbox');
    await page.keyboard.press('Escape');
  }
} catch (err) {
  console.error(`\nprobe error: ${err?.stack ?? err}`);
  if (page) {
    try {
      await shot('error');
    } catch {}
  }
  results.push({ stage: 'probe', ok: false, detail: String(err?.message ?? err) });
} finally {
  await app.close();
}

// ---- Stage C: the real model, asked in plain English ---------------------
// A SEPARATE launch, deliberately WITHOUT PI_E2E: `ensureChatServerReady` is a
// no-op under the E2E flag (probes normally drive mock-pi), so the inference
// server would never start. Without it the app boots its model exactly as a
// user's would — and starting fresh also means the 15 GB image model is loaded
// on demand by the tool call rather than already resident, which is the real
// memory shape of this feature on a 24 GB machine.
if (!SKIP_CHAT) {
  console.log(`\n  … stage C: fresh app, real local model (${CHAT_MODEL}), plain-English request`);
  const homeC = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-img-home-c-')));
  mkdirSync(path.join(homeC, '.pi', 'desktop'), { recursive: true });
  writeFileSync(
    path.join(homeC, '.pi', 'desktop', 'settings.json'),
    JSON.stringify({
      version: 1,
      theme: { flavor: 'bobble', mode: 'light' },
      permissionMode: 'bypass',
      effort: 'medium',
      enginePreference: 'llamacpp',
      modelSelection: { mode: 'model', modelId: CHAT_MODEL },
      effortMode: 'manual',
    }),
  );
  writeFileSync(
    path.join(homeC, '.pi', 'desktop', 'onboarding.json'),
    JSON.stringify({
      version: 1,
      completedAt: new Date().toISOString(),
      choices: { source: 'neither', tutorial: false, permissionMode: 'bypass' },
    }),
  );

  const envC = {
    ...process.env,
    HOME: homeC,
    PI_DESKTOP_CACHE_DIR: realCache,
    GEN3D_CACHE_DIR: path.join(realCache, 'gen3d'),
  };
  // biome-ignore lint/performance/noDelete: the flag must be ABSENT, not empty.
  delete envC.PI_E2E;

  const appC = await electron.launch({
    executablePath: electronBinary,
    args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-img-udd-c-'))}`],
    env: envC,
  });
  try {
    const pc = await appC.firstWindow();
    await pc.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });
    await pc.click('[data-testid="composer-input"]');
    await pc.keyboard.type('Please generate an image of a red bicycle.');
    await pc.keyboard.press('Enter');

    let called = false;
    let inlineShown = false;
    const deadline = Date.now() + 12 * 60_000;
    while (Date.now() < deadline) {
      const state = await pc.evaluate(() => ({
        // The chain row is the DOM evidence the tool ran (no store hook here).
        labels: [...document.querySelectorAll('*')]
          .filter((e) => e.children.length === 0)
          .map((e) => e.textContent?.trim() ?? '')
          .filter((t) => /^(Generating|Generated) an image$/.test(t)),
        inline: [...document.querySelectorAll('[data-testid="thread-image"] img')].filter(
          (i) => i.complete && i.naturalWidth > 0,
        ).length,
      }));
      if (state.labels.length > 0) called = true;
      if (state.inline > 0) {
        inlineShown = true;
        break;
      }
      await pc.waitForTimeout(3000);
    }
    await pc.waitForTimeout(500);
    const chatShot = path.join(OUT, 'C-chat-driven.png');
    await pc.screenshot({ path: chatShot });
    console.log(`      shot: ${chatShot}`);
    record(
      'C1 the model called generate_image from a plain request',
      called,
      called ? 'an image tool row appeared in the transcript' : 'the model never called the tool',
    );
    record(
      'C2 the chat-driven image rendered inline',
      inlineShown,
      inlineShown ? `see ${chatShot}` : 'no inline image appeared within the deadline',
    );
  } catch (err) {
    console.error(`stage C error: ${err?.stack ?? err}`);
    results.push({ stage: 'C (chat-driven)', ok: false, detail: String(err?.message ?? err) });
  } finally {
    await appC.close();
  }
} else {
  console.log('\n  (stage C skipped: SKIP_CHAT=1)');
}

console.log('\n================ SUMMARY ================');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.stage}`);
console.log(`shots in ${OUT}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
