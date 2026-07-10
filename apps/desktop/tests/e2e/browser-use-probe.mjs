/**
 * Browser-use E2E: drives the REAL canvas browser through the browser-agent
 * socket bridge exactly as the pi-child extension would, and asserts the virtual
 * cursor actually moved.
 *
 * We preset PI_BROWSER_AGENT_SOCK/_TOKEN so both the app's bridge and this probe
 * agree on the socket, then act as the extension's socket client:
 *   1. ensureTab   → the renderer opens/mounts a real WebContentsView agent tab.
 *   2. navigate    → a data: page with a link, an input, a button, and text.
 *   3. evaluate    → the REAL perception script → assert indexed elements.
 *   4. type        → into the input by index (live typing).
 *   5. clickElement→ the button by index → its onclick reads the typed value.
 *   6. read        → the article text.
 *   7. assert the injected #pi-agent-cursor overlay exists and MOVED off-screen.
 *
 * Run `pnpm build` first.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`browser-use-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

// The real perception script (Node strips its types on import).
const { perceptionScript } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/browser-use/src/perception.ts')).href
);

// A page with everything the tools touch. Inline handler proves a real click.
const PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<title>PIBUA</title><h1>Browser Use E2E</h1>' +
      '<a href="https://example.com/next">Next page</a>' +
      '<input type="text" id="q" placeholder="Search query" />' +
      "<button id=\"go\" onclick=\"document.getElementById('out').textContent='CLICKED:'+document.getElementById('q').value\">Run</button>" +
      '<div id="out">idle</div>' +
      '<main><p>This is the readable article body for extraction.</p></main>',
  );

// Preset the bridge socket so the probe and the app agree on it.
const sockPath = path.join(tmpdir(), `pi-bua-e2e-${process.pid}.sock`);
const token = 'e2e-token';

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
    PI_BROWSER_AGENT_SOCK: sockPath,
    PI_BROWSER_AGENT_TOKEN: token,
  },
});

/** Minimal line-delimited JSON-RPC client to the bridge socket. */
function connect(socketPath, retries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', (err) => {
        if (left <= 0) return reject(err);
        setTimeout(() => attempt(left - 1), 150);
      });
    };
    attempt(retries);
  });
}

function makeRpc(socket) {
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'bridge error'));
    }
  });
  return (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc ${method} timed out`));
      }, 25000);
      timer.unref?.();
      socket.write(`${JSON.stringify({ id, token, method, params })}\n`);
    });
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 10000 });

  const socket = await connect(sockPath);
  const rpc = makeRpc(socket);

  // (1) ensureTab — renderer opens + mounts the real agent browser tab.
  const tab = await rpc('ensureTab');
  assert(tab && typeof tab.tabId === 'string', 'ensureTab returned a tab id');

  // (2) navigate to the fixture page.
  const nav = await rpc('navigate', { url: PAGE });
  assert(nav && nav.title === 'PIBUA', `navigate loaded the page (title=${nav?.title})`);

  // (3) snapshot via the REAL perception script → indexed elements.
  const snap = await rpc('evaluate', { script: perceptionScript(60) });
  assert(
    snap && Array.isArray(snap.elements) && snap.elements.length >= 3,
    'snapshot has elements',
  );
  const link = snap.elements.find((e) => e.role === 'link');
  const input = snap.elements.find((e) => e.editable);
  const button = snap.elements.find((e) => e.role === 'button');
  assert(link && /Next page/.test(link.name), 'snapshot found the link with its name');
  assert(input && /Search query/.test(input.name), 'snapshot found the input field');
  assert(button && /Run/.test(button.name), 'snapshot found the button');
  assert(typeof button.bbox.x === 'number', 'elements carry a bbox');

  // (4) type into the input by index (live typing).
  const typed = await rpc('type', { index: input.index, text: 'hello', submit: false });
  assert(typed?.found, 'type resolved the field');
  const inputVal = await rpc('evaluate', {
    script: "(function(){return document.getElementById('q').value;})()",
  });
  assert(inputVal === 'hello', `input value reflects typing (got "${inputVal}")`);

  // (5) click the button by index → its onclick reads the typed value.
  const clicked = await rpc('clickElement', { index: button.index, mode: 'dom' });
  assert(clicked?.found, 'clickElement resolved the button');
  const out = await rpc('evaluate', {
    script: "(function(){return document.getElementById('out').textContent;})()",
  });
  assert(out === 'CLICKED:hello', `button click fired its handler (got "${out}")`);

  // (6) read the article text.
  const read = await rpc('evaluate', {
    script: "(function(){return document.querySelector('main').innerText;})()",
  });
  assert(/readable article body/.test(read), 'read extracted the article text');

  // (7) coordinate click at a known point → the virtual cursor tracks it exactly.
  await rpc('click', { x: 220, y: 160 });
  const cursorLeft = await rpc('evaluate', {
    script:
      "(function(){var c=document.getElementById('pi-agent-cursor');return c?c.style.left:null;})()",
  });
  assert(cursorLeft !== null, 'the virtual cursor overlay was injected into the page');
  assert(
    cursorLeft === '220px',
    `the virtual cursor moved to the click point (left=${cursorLeft})`,
  );

  socket.end();
  console.log(
    `browser-use-probe OK — drove a live page over the socket bridge: navigated (PIBUA), ` +
      `snapshot returned ${snap.elements.length} indexed elements, typed "hello" into the field, ` +
      `clicked the button by index (handler saw "${out}"), read the article, and the virtual ` +
      `cursor moved to the commanded point (left=${cursorLeft}).`,
  );
} finally {
  await app.close();
}
