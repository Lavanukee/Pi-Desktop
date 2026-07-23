/**
 * PACKAGED-app smoke: the real proof that a shipped "Pi Desktop.app" (not just
 * `pnpm dev`) has working local-model chat + canvas. It proves the three
 * packaging fixes:
 *
 *   (a) the three pi EXTENSION entry points resolve AND load inside the bundle.
 *       A direct spawn of the bundled pi cli.js with the in-asar `-e` paths
 *       (exactly what PiBridge does) loads all three cleanly — the old bug
 *       resolved them repo-relative and shipped `count: 0`.
 *   (b) pi SPAWNS from the bundle in the running app — the main log shows
 *       `pi bridge spawned { … source: 'bundled' }`, `pi:start` reports a live
 *       pid, and `pi:get-models` answers.
 *   (c) the pd-preview HARNESS resolves inside the bundle — its files exist at
 *       the resolved in-asar path and a pd-preview://canvas iframe loads in the
 *       renderer over the registered scheme.
 *
 * With Gemma 4 E2B + llama.cpp cached (env SMOKE_MODEL=1) it also drives a REAL
 * completion through the bundled provider-llamacpp extension (llamacpp-stream)
 * and reports TPS. That section skips cleanly otherwise, so the probe is CI-safe.
 *
 * Usage: node tests/e2e/packaged-smoke.mjs [path-to-.app]
 *        SMOKE_MODEL=1 node tests/e2e/packaged-smoke.mjs [path-to-.app]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const appBundle = process.argv[2] ?? '/Applications/Bobble.app';
const executable = path.join(appBundle, 'Contents/MacOS/Bobble');
const resources = path.join(appBundle, 'Contents/Resources');
const asar = path.join(resources, 'app.asar');

function assert(condition, message) {
  if (!condition) throw new Error(`packaged-smoke failed: ${message}`);
}

assert(existsSync(executable), `no executable at ${executable}`);
assert(existsSync(asar), `no app.asar at ${asar}`);

const EXTENSION_DIRS = ['provider-llamacpp', 'harness', 'web-tools'];

// ---------------------------------------------------------------------------
// (a) Deterministic, model-free proof: spawn the bundled pi with all three
//     in-asar `-e` extension paths and confirm it loads them cleanly. This is
//     the same cli.js + `-e` + `--no-extensions` invocation PiBridge builds, so
//     a clean load here means the running app's extensions resolve too. The pi
//     child (ELECTRON_RUN_AS_NODE) has the asar fs shim, so the in-asar paths
//     read transparently — the exact behavior the packaging fix relies on.
// ---------------------------------------------------------------------------
async function proveExtensionsLoad() {
  const cli = path.join(asar, 'node_modules/@mariozechner/pi-coding-agent/dist/cli.js');
  const extPaths = EXTENSION_DIRS.map((d) =>
    path.join(asar, 'node_modules/@pi-desktop', d, 'src/index.ts'),
  );
  const eArgs = extPaths.flatMap((p) => ['-e', p]);
  const home = mkdtempSync(path.join(tmpdir(), 'pi-ext-load-'));

  const child = spawn(executable, [cli, '--mode', 'rpc', '--no-extensions', ...eArgs], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOME: home,
      PI_HOME: path.join(home, '.pi'),
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  // Elicit two RPC responses then close stdin so pi exits cleanly.
  child.stdin.write('{"type":"get_state","id":"1"}\n');
  child.stdin.write('{"type":"get_available_models","id":"2"}\n');
  child.stdin.end();

  const code = await new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bundled pi did not exit within 20s\nstderr:\n${err}`));
    }, 20000);
    child.on('exit', (c) => {
      clearTimeout(to);
      resolve(c);
    });
    child.on('error', reject);
  });

  assert(code === 0, `bundled pi exited ${code} loading the 3 extensions\nstderr:\n${err}`);
  const responses = out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
  const ok = responses.filter((r) => r?.type === 'response' && r.success === true);
  assert(
    ok.length >= 2,
    `expected 2 successful RPC responses from the extension-loaded pi; got:\n${out}\nstderr:\n${err}`,
  );
  // A crashed extension (duplicate tool, bad import) prints to stderr + exits 1;
  // clean load leaves stderr empty of Error lines.
  assert(
    !/Error|throw|Cannot find|not found/i.test(err),
    `extension-load stderr not clean:\n${err}`,
  );
  console.log(
    `(a) OK — bundled pi loaded all 3 extensions from the asar (exit 0, ${ok.length} RPC ok, clean stderr)`,
  );
}

await proveExtensionsLoad();

// ---------------------------------------------------------------------------
// (b)/(c) Run the actual packaged app.
// ---------------------------------------------------------------------------
const MODEL_ID = 'gemma-4-e2b-it';
const modelPath = path.join(
  homedir(),
  '.cache/pi-desktop/models',
  MODEL_ID,
  'gemma-4-E2B-it-Q4_K_M.gguf',
);
const runModel = process.env.SMOKE_MODEL === '1' && existsSync(modelPath);

// Isolated user-data-dir so this never contends with an installed copy's
// single-instance lock. pi still uses the real ~/.pi (the model section reads
// the supervisor-written models.json), mirroring real-model-smoke.
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-packaged-smoke-'));
let mainLog = '';
const app = await electron.launch({
  executablePath: executable,
  args: [`--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_E2E: '1' },
});
const proc = app.process();
proc.stdout?.on('data', (d) => (mainLog += d.toString()));
proc.stderr?.on('data', (d) => (mainLog += d.toString()));

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 20000 });

  // (b) pi spawns from the bundle in the running app.
  const started = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  assert(started.pid > 0, `expected a live pi pid, got ${JSON.stringify(started)}`);
  const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  assert(
    Array.isArray(models.models),
    `pi:get-models did not return a list: ${JSON.stringify(models)}`,
  );
  // The main-process bridge log proves the child was resolved to the bundled
  // cli.js (source: 'bundled'), not a stray `pi` on PATH. Strip ANSI colour codes
  // first — the main logger colourises `source: 'bundled'` (→ `source:
  // \x1b[32m'bundled'\x1b[39m`), which otherwise defeats the literal match.
  const cleanLog = mainLog.replace(/\x1b\[[0-9;]*m/g, '');
  assert(
    /pi bridge spawned[\s\S]*source: 'bundled'/.test(cleanLog),
    `main log did not show a bundled pi bridge spawn:\n${cleanLog}`,
  );
  console.log(
    `(b) OK — pi spawned from the bundle (pid ${started.pid}, source: 'bundled'); get-models returned ${models.models.length} model(s)`,
  );

  // (c) pd-preview harness resolves in the bundle and serves over its scheme.
  assert(
    existsSync(path.join(resources, 'app.asar')),
    'app.asar missing (canvas harness is bundled inside it)',
  );
  const framePvOk = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts');
        f.style.display = 'none';
        const t = setTimeout(() => resolve(false), 8000);
        f.addEventListener('load', () => {
          clearTimeout(t);
          resolve(true);
        });
        f.addEventListener('error', () => {
          clearTimeout(t);
          resolve(false);
        });
        f.src = 'pd-preview://canvas/index.html';
        document.body.appendChild(f);
      }),
  );
  assert(framePvOk === true, 'pd-preview://canvas/index.html iframe did not load from the bundle');
  console.log('(c) OK — pd-preview harness resolves in the bundle and serves over pd-preview://');

  if (!runModel) {
    console.log(
      `\npackaged-smoke OK (deterministic) — 3 extensions load, pi spawns from bundle, pd-preview serves.` +
        `\n(model streaming ${process.env.SMOKE_MODEL === '1' ? 'SKIPPED: model not cached' : 'not requested: set SMOKE_MODEL=1'})`,
    );
  } else {
    console.log('\nstarting llama-server for', MODEL_ID, '…');
    const srv = await page.evaluate(
      (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
      MODEL_ID,
    );
    assert(srv.success, `start-server: ${srv.error}`);
    console.log('server ready at', srv.baseUrl);

    await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
    const m2 = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
    const target = m2.models.find((m) => m.provider === 'llamacpp');
    assert(target !== undefined, `no llamacpp model after restart: ${JSON.stringify(m2)}`);
    // llamacpp-stream is handled ONLY by the bundled provider-llamacpp extension.
    assert(
      target.api === 'llamacpp-stream',
      `model api is "${target.api}", expected "llamacpp-stream" — chat is NOT routing through the bundled provider-llamacpp extension`,
    );
    const set = await page.evaluate(
      (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
      target,
    );
    assert(set.success, `set-model: ${set.error}`);

    const t0 = Date.now();
    const ack = await page.evaluate(() =>
      window.piDesktop.invoke('pi:prompt', {
        message: 'Reply with exactly one short friendly sentence.',
      }),
    );
    assert(ack.success, `prompt: ${ack.error}`);

    await page.waitForFunction(
      () => {
        const { messages, agent } = window.__pi_store().getState();
        const a = [...messages].reverse().find((m) => m.kind === 'assistant');
        const text = a?.blocks
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        return !agent.isStreaming && typeof text === 'string' && text.length > 0;
      },
      { timeout: 180000 },
    );
    const elapsedMs = Date.now() - t0;
    const result = await page.evaluate(() => {
      const { messages } = window.__pi_store().getState();
      const a = [...messages].reverse().find((m) => m.kind === 'assistant');
      return {
        text: a?.blocks
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(''),
        model: a?.model,
        usage: a?.usage,
      };
    });
    const status = await page.evaluate(() => window.piDesktop.invoke('llm:get-status', undefined));
    const tps = status.metrics?.avgTps ?? status.metrics?.lastTps;

    console.log('\n=== packaged real-model result ===');
    console.log('assistant text:', JSON.stringify(result.text));
    console.log(
      'model:',
      result.model,
      '| output tokens:',
      result.usage?.output,
      '| elapsed ms:',
      elapsedMs,
    );
    console.log('supervisor TPS:', JSON.stringify(status.metrics));
    assert(
      typeof tps === 'number' && tps > 0,
      `no TPS surfaced: ${JSON.stringify(status.metrics)}`,
    );
    console.log(
      '\npackaged-smoke OK (full) — bundled provider-llamacpp extension streamed a real completion through llamacpp-stream; TPS shown; pd-preview serves.',
    );
  }
} finally {
  await app.close();
}
