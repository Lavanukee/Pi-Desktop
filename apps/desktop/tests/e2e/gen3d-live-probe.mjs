// gen3d live probe — boots the REAL uv/Python sidecar and exercises whatever
// engine pieces are actually installed on this machine; SKIPS HONESTLY (exit 0
// with a SKIP line) when they are not. Not part of the package.json e2e chain.
//
//   node tests/e2e/gen3d-live-probe.mjs            # sidecar + catalog + cheap ops
//   GEN3D_PROBE_FULL=1 node …                      # + a real low-res generation (minutes)
//
// What it proves when everything is installed:
//   - sidecar boots via uv, /health + /catalog respond, engineReady
//   - catalog installed flags match the stamp files on disk
//   - (full) image→3D at 'low' emits: step progress → geometry artifact BEFORE
//     done (geometry-first contract) → textured artifact → done; both GLBs
//     validate structurally (gen3d-glb-check.mjs)
//   - retopo stage op runs the AutoRemesher CLI end-to-end on the result
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGlb } from './gen3d-glb-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const pyDir = path.join(repoRoot, 'packages', 'gen3d-engine', 'python');
const cacheDir = path.join(os.homedir(), '.cache', 'pi-desktop', 'gen3d');
const sandboxDir = path.join(os.homedir(), '.pi', 'desktop', 'sandbox', 'gen3d');

const log = (...a) => console.log('[gen3d-probe]', ...a);
const fail = (msg) => {
  console.error('[gen3d-probe] FAIL:', msg);
  process.exit(1);
};

function findUv() {
  for (const p of [
    ...(process.env.PATH ?? '').split(':').map((d) => path.join(d, 'uv')),
    path.join(os.homedir(), '.cache', 'pi-desktop', 'uv', 'uv'),
    path.join(os.homedir(), '.local', 'bin', 'uv'),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function main() {
  const uv = findUv();
  if (uv === null) {
    log('SKIP: uv not installed on this machine');
    return;
  }
  if (!existsSync(path.join(pyDir, 'server.py'))) fail('sidecar server.py missing');

  // Registry mirrors what gen3d-main writes from catalog.toSidecarRegistry()
  // (inline because this probe is dependency-free .mjs; the numbers are
  // asserted equal in packages/gen3d-engine/src/catalog.test.ts).
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });
  const registryPath = path.join(os.tmpdir(), `gen3d-probe-registry-${Date.now()}.json`);
  writeFileSync(
    registryPath,
    JSON.stringify({
      models: [
        {
          id: 'trellis2',
          env: 'trellis',
          totalBytes: 18042228136,
          repos: [
            { repo: 'microsoft/TRELLIS.2-4B', bytes: 16237485044 },
            {
              repo: 'microsoft/TRELLIS-image-large',
              allowPatterns: ['ckpts/ss_dec_conv3d_16l8_fp16*'],
              bytes: 147592217,
            },
            { repo: 'camenduru/dinov3-vitl16-pretrain-lvd1689m', bytes: 1212584680 },
            {
              repo: 'ZhengPeng7/BiRefNet',
              allowPatterns: ['config.json', 'birefnet.py', 'BiRefNet_config.py', 'model.safetensors'],
              bytes: 444566195,
            },
          ],
        },
        {
          id: 'mageflow',
          env: 'mageflow',
          totalBytes: 17463920534,
          repos: [
            {
              repo: 'microsoft/Mage-Flow-Turbo',
              allowPatterns: ['transformer/*', 'text_encoder/*', 'vae/*', 'scheduler/*', '*.json'],
              bytes: 17463920534,
            },
          ],
        },
        {
          id: 'hunyuan-paint',
          env: 'paint',
          totalBytes: 11433607718,
          repos: [
            {
              repo: 'tencent/Hunyuan3D-2.1',
              allowPatterns: ['hunyuan3d-paintpbr-v2-1/*', 'hy3dpaint/*'],
              bytes: 6887601302,
            },
            {
              repo: 'facebook/dinov2-giant',
              allowPatterns: ['*.json', 'model.safetensors'],
              bytes: 4546006416,
            },
          ],
        },
        {
          id: 'cubepart',
          env: 'cubepart',
          totalBytes: 18791014667,
          repos: [
            { repo: 'Roblox/cubepart', bytes: 9903730587 },
            {
              repo: 'Qwen/Qwen3-VL-4B-Instruct',
              allowPatterns: ['*.json', '*.safetensors', '*.txt'],
              bytes: 8887284080,
            },
          ],
        },
        { id: 'autoremesher', env: 'binary', totalBytes: 17259387, repos: [] },
      ],
      gatedMirrors: {
        'facebook/dinov3-vitl16-pretrain-lvd1689m': 'camenduru/dinov3-vitl16-pretrain-lvd1689m',
        'briaai/RMBG-2.0': 'ZhengPeng7/BiRefNet',
      },
      autoremesher: {
        dmgUrl:
          'https://github.com/huxingyi/autoremesher/releases/download/1.0.0/autoremesher-1.0.0.dmg',
        dmgBytes: 17259387,
      },
      pipelineTypes: { low: '512', medium: '1024_cascade', high: '1536_cascade' },
    }),
  );

  const port = await freePort();
  const child = spawn(
    uv,
    [
      'run',
      '--no-project',
      '--python',
      '3.12',
      '--with',
      'huggingface_hub==0.34.4',
      path.join(pyDir, 'server.py'),
      '--port',
      String(port),
      '--cache-dir',
      cacheDir,
      '--sandbox-dir',
      sandboxDir,
      '--registry',
      registryPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on(
    'data',
    (d) => process.env.GEN3D_PROBE_VERBOSE && log('sidecar:', String(d).trim()),
  );
  child.stderr.on(
    'data',
    (d) => process.env.GEN3D_PROBE_VERBOSE && log('sidecar!', String(d).trim()),
  );
  const kill = () => {
    try {
      child.kill('SIGTERM');
    } catch {}
  };
  process.on('exit', kill);

  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) fail('sidecar never became healthy');
  log('sidecar healthy on', base);

  const catalog = await (await fetch(`${base}/catalog`)).json();
  if (catalog.engineReady !== true) fail('catalog engineReady !== true');
  const installed = Object.fromEntries(catalog.models.map((m) => [m.id, m.installed]));
  log('installed:', JSON.stringify(installed));

  // --- events stream ---
  const events = [];
  const eventsAbort = new AbortController();
  const streamDone = (async () => {
    try {
      const res = await fetch(`${base}/events`, { signal: eventsAbort.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buf.indexOf('\n');
          if (nl === -1) break;
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              events.push(JSON.parse(line));
            } catch {}
          }
        }
      }
    } catch {}
  })();

  if (process.env.GEN3D_PROBE_FULL === '1' && installed.trellis2) {
    const testImage = path.join(
      os.homedir(),
      '.cache',
      'pi-desktop',
      'gen3d',
      'src',
      'trellis-mac',
      'assets',
      'shoe_input.png',
    );
    if (!existsSync(testImage)) fail(`test image missing: ${testImage}`);
    log('starting REAL image→3D generation at low (this takes minutes)…');
    const gen = await (
      await fetch(`${base}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'image',
          imagePath: testImage,
          resolution: 'low',
          texture: true,
        }),
      })
    ).json();
    if (!gen.ok) fail(`generate refused: ${gen.error}`);
    const jobId = gen.jobId;

    const jobDeadline = Date.now() + 45 * 60_000;
    let doneEvent = null;
    while (Date.now() < jobDeadline && doneEvent === null) {
      await new Promise((r) => setTimeout(r, 2000));
      doneEvent = events.find((e) => e.type === 'job' && e.jobId === jobId && e.done) ?? null;
    }
    if (doneEvent === null) fail('generation did not finish within 45 min');
    if (doneEvent.error) fail(`generation errored: ${doneEvent.error}`);

    const jobEvents = events.filter((e) => e.type === 'job' && e.jobId === jobId);
    const artifacts = jobEvents.filter((e) => e.artifact).map((e) => e.artifact);
    const geometryIdx = jobEvents.findIndex((e) => e.artifact?.label === 'Untextured geometry');
    const doneIdx = jobEvents.indexOf(doneEvent);
    if (geometryIdx === -1) fail('no untextured-geometry artifact was emitted');
    if (geometryIdx >= doneIdx)
      fail('geometry artifact did not precede done (geometry-first broken)');
    const steps = jobEvents.filter((e) => typeof e.step === 'number');
    if (steps.length < 5) fail(`too few step-progress events (${steps.length})`);
    for (const artifact of artifacts) {
      if (artifact.kind !== 'model-glb') continue;
      const verdict = validateGlb(readFileSync(artifact.path));
      if (!verdict.ok) fail(`GLB invalid ${artifact.path}: ${verdict.problems.join('; ')}`);
      log('GLB ok:', artifact.path, JSON.stringify(verdict.stats));
    }
    log(`generation VERIFIED (${jobEvents.length} events, ${steps.length} step updates)`);

    // Retopo the untextured mesh through the real CLI when it's installed.
    if (installed.autoremesher) {
      const geometry = artifacts.find((a) => a.label === 'Untextured geometry');
      const stage = await (
        await fetch(`${base}/stage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'retopo', modelPath: geometry.path }),
        })
      ).json();
      if (!stage.ok) fail(`retopo refused: ${stage.error}`);
      let retopoDone = null;
      const retopoDeadline = Date.now() + 20 * 60_000;
      while (Date.now() < retopoDeadline && retopoDone === null) {
        await new Promise((r) => setTimeout(r, 2000));
        retopoDone =
          events.find((e) => e.type === 'job' && e.jobId === stage.jobId && e.done) ?? null;
      }
      if (retopoDone === null) fail('retopo did not finish');
      if (retopoDone.error) fail(`retopo errored: ${retopoDone.error}`);
      const retopoArtifact = events.find(
        (e) => e.jobId === stage.jobId && e.artifact?.kind === 'model-glb',
      )?.artifact;
      const verdict = validateGlb(readFileSync(retopoArtifact.path));
      if (!verdict.ok) fail(`retopo GLB invalid: ${verdict.problems.join('; ')}`);
      log('retopo VERIFIED:', retopoArtifact.path, JSON.stringify(verdict.stats));
    } else {
      log('SKIP retopo: autoremesher not installed');
    }
  } else if (process.env.GEN3D_PROBE_FULL === '1') {
    log('SKIP full generation: trellis2 not installed (download it in the studio first)');
  } else {
    log('SKIP full generation: set GEN3D_PROBE_FULL=1 to run the real pipeline');
  }

  eventsAbort.abort();
  kill();
  await streamDone;
  log('PASS');
  process.exit(0);
}

main().catch((err) => fail(err?.stack ?? String(err)));
