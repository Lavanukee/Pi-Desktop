import { describe, expect, it, vi } from 'vitest';
import {
  COMFY_MODEL_PACKS,
  COMFY_MODEL_SUBDIRS,
  COMFY_PACKS,
  COMFY_PYTHON_VERSION,
  COMFY_RUNTIME_PACK,
  type ComfyChildProcess,
  type ComfyFsOps,
  type ComfyInstallEvent,
  ComfyInstallManager,
  type ComfyInstallProbe,
  type ComfyInstallState,
  type ComfyPackLicense,
  type ConsentStore,
  comfyLayout,
  DISK_FOOTPRINT,
  detectInstallState,
  downloadProgressEvent,
  emitExtraModelPathsYaml,
  GPL_CONSENT_DISCLOSURE,
  getPack,
  installComfyuiArgs,
  modelDownloadArgs,
  packGateCleared,
  planInstall,
  TORCH_NIGHTLY_INDEX,
  torchInstallArgs,
  totalInstallGB,
  uvPipInstallArgs,
  uvProgressEvent,
  venvArgs,
} from './comfy-install';

// ── pack catalog + disk-footprint data ───────────────────────────────────────

describe('pack catalog', () => {
  it('runtime pack is first and unlocks nothing on its own', () => {
    expect(COMFY_PACKS[0]).toBe(COMFY_RUNTIME_PACK);
    expect(COMFY_RUNTIME_PACK.kind).toBe('runtime');
    expect(COMFY_RUNTIME_PACK.unlocks).toEqual([]);
  });

  it('every model pack matches a gen-service catalog id, has a source + a target subdir', () => {
    for (const pack of COMFY_MODEL_PACKS) {
      expect(pack.kind).toBe('model');
      expect(pack.unlocks).toContain(pack.id); // id === catalog id
      expect(pack.source).toBeTypeOf('string');
      expect(COMFY_MODEL_SUBDIRS).toContain(pack.targetSubdir);
    }
  });

  it('non-commercial packs are the ones that must gate (LTX-2 Community / Stability)', () => {
    const gated = COMFY_MODEL_PACKS.filter((p) => !p.commercialUse).map((p) => p.id);
    expect(gated).toEqual(
      expect.arrayContaining(['ltx-video-2b-distilled', 'ltx-2', 'stable-audio-open']),
    );
    // ACE-Step + FLUX GGUF are apache → no gate.
    expect(gated).not.toContain('ace-step');
    expect(gated).not.toContain('flux1-dev-gguf');
  });

  it('excludes the remote-only ltx-2-22b (runsLocally:false) from local packs', () => {
    expect(getPack('ltx-2-22b')).toBeUndefined();
  });

  it('models the §4 disk-footprint table, flagging non-ComfyUI rows', () => {
    const runtime = DISK_FOOTPRINT.find((r) => r.component.includes('base runtime'));
    expect(runtime).toMatchObject({ sizeGB: 6, honesty: 'projected', viaComfy: true });
    // trellis2-mlx + mflux weights appear but are NOT fetched by this manager.
    const notComfy = DISK_FOOTPRINT.filter((r) => !r.viaComfy).map((r) => r.component);
    expect(notComfy.some((c) => c.includes('trellis2-mlx'))).toBe(true);
    expect(notComfy.some((c) => c.includes('mflux'))).toBe(true);
  });

  it('totalInstallGB sums pack sizes and ignores unknown ids', () => {
    expect(totalInstallGB(['comfyui-runtime', 'ace-step'])).toBe(13); // 6 + 7
    expect(totalInstallGB(['nope'])).toBe(0);
  });

  it('discloses GPL-3.0 upstream + separate program in the consent copy', () => {
    expect(GPL_CONSENT_DISCLOSURE).toMatch(/GPL-3\.0/);
    expect(GPL_CONSENT_DISCLOSURE).toMatch(/upstream/i);
    expect(GPL_CONSENT_DISCLOSURE).toMatch(/localhost/i);
  });
});

// ── layout + yaml emission ───────────────────────────────────────────────────

describe('comfyLayout', () => {
  it('derives every canonical sub-path under the install root', () => {
    const l = comfyLayout('/data/comfyui');
    expect(l).toMatchObject({
      root: '/data/comfyui',
      venvPython: '/data/comfyui/venv/bin/python',
      comfyMain: '/data/comfyui/ComfyUI/main.py',
      sharedModelsDir: '/data/comfyui/shared-models',
      extraModelPathsYaml: '/data/comfyui/extra_model_paths.yaml',
    });
  });
});

describe('emitExtraModelPathsYaml', () => {
  it('emits a ComfyUI extra_model_paths.yaml pointing at the shared dirs', () => {
    const yaml = emitExtraModelPathsYaml(comfyLayout('/data/comfyui'));
    expect(yaml).toContain('pi_desktop:');
    expect(yaml).toContain('base_path: /data/comfyui/shared-models');
    expect(yaml).toContain('is_default: true');
    expect(yaml).toContain('custom_nodes: /data/comfyui/shared-custom-nodes');
    // Every declared model subdir is mapped.
    for (const subdir of COMFY_MODEL_SUBDIRS) {
      expect(yaml).toContain(`  ${subdir}: ${subdir}`);
    }
    expect(yaml.endsWith('\n')).toBe(true);
  });

  it('is deterministic (same layout → identical bytes)', () => {
    const a = emitExtraModelPathsYaml(comfyLayout('/x'));
    const b = emitExtraModelPathsYaml(comfyLayout('/x'));
    expect(a).toBe(b);
  });
});

// ── per-model gate check ─────────────────────────────────────────────────────

describe('packGateCleared', () => {
  const flux = getPack('flux1-dev-gguf');
  const ltx = getPack('ltx-2');

  it('un-gated (commercial) packs are always cleared', () => {
    expect(flux).toBeDefined();
    if (flux !== undefined) expect(packGateCleared(flux, [])).toBe(true);
  });

  it('gated packs need their exact license accepted', () => {
    expect(ltx).toBeDefined();
    if (ltx === undefined) return;
    expect(packGateCleared(ltx, [])).toBe(false);
    expect(packGateCleared(ltx, ['stability-community'])).toBe(false); // wrong license
    expect(packGateCleared(ltx, ['ltx-2-community'])).toBe(true);
  });
});

// ── install-state detection: installed vs needs-download ─────────────────────

describe('detectInstallState', () => {
  const baseProbe: ComfyInstallProbe = {
    consentGiven: true,
    comfyMainExists: true,
    venvPythonExists: true,
    configExists: true,
    installedPackIds: [],
  };

  it('reports consent-required until consent is given (blocks everything)', () => {
    const s = detectInstallState({ ...baseProbe, consentGiven: false });
    expect(s.runtime).toBe('consent-required');
  });

  it('reports runtime-missing when consent is given but the base is absent', () => {
    expect(detectInstallState({ ...baseProbe, comfyMainExists: false }).runtime).toBe(
      'runtime-missing',
    );
    expect(detectInstallState({ ...baseProbe, venvPythonExists: false }).runtime).toBe(
      'runtime-missing',
    );
  });

  it('reports runtime-ready when venv + ComfyUI are present', () => {
    expect(detectInstallState(baseProbe).runtime).toBe('runtime-ready');
  });

  it('marks each pack installed / gated / cleared from the probe + accepted EULAs', () => {
    const s = detectInstallState({ ...baseProbe, installedPackIds: ['ace-step'] }, [
      'ltx-2-community',
    ]);
    const byId = new Map(s.packs.map((p) => [p.id, p]));
    expect(byId.get('ace-step')).toMatchObject({ installed: true, gated: false, cleared: true });
    expect(byId.get('ltx-2')).toMatchObject({ installed: false, gated: true, cleared: true });
    expect(byId.get('stable-audio-open')).toMatchObject({ gated: true, cleared: false });
  });
});

// ── step sequencing ──────────────────────────────────────────────────────────

describe('planInstall', () => {
  const ready: ComfyInstallState = {
    runtime: 'runtime-ready',
    packs: COMFY_MODEL_PACKS.map((p) => ({
      id: p.id,
      installed: false,
      gated: !p.commercialUse,
      cleared: true,
    })),
    configWritten: true,
  };

  it('a fresh machine plans consent → venv → comfyui → torch → (packs) → config', () => {
    const fresh: ComfyInstallState = {
      runtime: 'consent-required',
      packs: ready.packs,
      configWritten: false,
    };
    const kinds = planInstall(fresh, ['ace-step']).map((s) => s.kind);
    expect(kinds).toEqual([
      'consent',
      'create-venv',
      'install-comfyui',
      'install-torch',
      'download-pack',
      'write-config',
    ]);
  });

  it('skips the runtime bring-up once the base is ready, keeping only new packs', () => {
    const steps = planInstall(ready, ['ace-step', 'ltx-2']);
    expect(steps.map((s) => s.kind)).toEqual(['download-pack', 'download-pack', 'write-config']);
    expect(steps.filter((s) => s.kind === 'download-pack').map((s) => s.packId)).toEqual([
      'ace-step',
      'ltx-2',
    ]);
  });

  it('does not re-download an already-installed pack', () => {
    const withAce: ComfyInstallState = {
      ...ready,
      packs: ready.packs.map((p) => (p.id === 'ace-step' ? { ...p, installed: true } : p)),
    };
    const steps = planInstall(withAce, ['ace-step']);
    // ace-step already present + config already written → nothing to do.
    expect(steps).toEqual([]);
  });

  it('flags gated download steps and ignores the runtime pack id / unknown ids', () => {
    const steps = planInstall(ready, ['comfyui-runtime', 'nope', 'ltx-2']);
    expect(steps.map((s) => s.kind)).toEqual(['download-pack', 'write-config']);
    expect(steps[0]).toMatchObject({ packId: 'ltx-2', gated: true });
  });

  it('re-writes config even with no work when the yaml is missing', () => {
    const steps = planInstall({ ...ready, configWritten: false }, []);
    expect(steps.map((s) => s.kind)).toEqual(['write-config']);
  });

  it('returns [] (fully installed) when nothing needs doing', () => {
    expect(planInstall(ready, [])).toEqual([]);
  });
});

// ── progress-event mapping ───────────────────────────────────────────────────

describe('downloadProgressEvent', () => {
  it('computes a clamped [0,1] ratio when a byte total is known', () => {
    expect(downloadProgressEvent('download-pack', 'ace-step', 50, 200)).toMatchObject({
      kind: 'progress',
      packId: 'ace-step',
      receivedBytes: 50,
      totalBytes: 200,
      ratio: 0.25,
    });
    // Over-report clamps to 1.
    expect(downloadProgressEvent('download-pack', 'x', 300, 200).ratio).toBe(1);
  });

  it('omits the ratio when the total is unknown (chunked / no content-length)', () => {
    const ev = downloadProgressEvent('download-pack', 'ace-step', 50, null);
    expect(ev.ratio).toBeUndefined();
    expect(ev.totalBytes).toBeUndefined();
  });
});

describe('uvProgressEvent', () => {
  it('surfaces uv/pip lifecycle lines as advisory detail progress', () => {
    expect(uvProgressEvent('install-torch', 'Downloading torch (250 MB)')).toMatchObject({
      kind: 'progress',
      step: 'install-torch',
      detail: 'Downloading torch (250 MB)',
    });
    expect(uvProgressEvent('install-comfyui', '  Installed 42 packages ')?.detail).toBe(
      'Installed 42 packages',
    );
  });

  it('returns null for noise lines that carry no signal', () => {
    expect(uvProgressEvent('install-torch', '')).toBeNull();
    expect(uvProgressEvent('install-torch', 'some unrelated chatter')).toBeNull();
  });
});

// ── uv / pip argv builders ───────────────────────────────────────────────────

describe('uv argv builders', () => {
  it('venvArgs creates the env with the pinned python', () => {
    expect(venvArgs(COMFY_PYTHON_VERSION, '/r/venv')).toEqual([
      'venv',
      '--python',
      COMFY_PYTHON_VERSION,
      '/r/venv',
    ]);
  });

  it('uvPipInstallArgs targets the venv python and threads --pre + index-url', () => {
    expect(uvPipInstallArgs('/r/venv/bin/python', ['comfyui'])).toEqual([
      'pip',
      'install',
      '--python',
      '/r/venv/bin/python',
      'comfyui',
    ]);
    expect(uvPipInstallArgs('/p', ['torch'], { pre: true, indexUrl: 'https://idx' })).toEqual([
      'pip',
      'install',
      '--python',
      '/p',
      '--pre',
      'torch',
      '--index-url',
      'https://idx',
    ]);
  });

  it('torchInstallArgs drives the MPS nightly install ourselves (--pre + nightly index)', () => {
    const args = torchInstallArgs('/p');
    expect(args).toContain('--pre');
    expect(args).toContain('torch');
    expect(args).toContain('torchvision');
    expect(args).toContain('torchaudio');
    expect(args[args.indexOf('--index-url') + 1]).toBe(TORCH_NIGHTLY_INDEX);
  });

  it('installComfyuiArgs skips torch (we drive it) and targets the ComfyUI dir', () => {
    const args = installComfyuiArgs('/r/ComfyUI');
    expect(args).toContain('--skip-torch-or-directml');
    expect(args).toContain('/r/ComfyUI');
  });

  it('modelDownloadArgs points comfy at the source + shared dest', () => {
    expect(modelDownloadArgs('org/repo', '/r/shared-models/checkpoints')).toEqual([
      'run',
      'comfy',
      'model',
      'download',
      '--url',
      'org/repo',
      '--relative-path',
      '/r/shared-models/checkpoints',
    ]);
  });
});

// ── the manager: end-to-end step sequencing with fakes (no real spawn/network) ─

/** A fake child that succeeds (exit 0) after emitting an optional stdout line. */
function fakeChild(exitCode = 0, stdoutLine?: string): ComfyChildProcess {
  const stdoutCbs: ((c: string) => void)[] = [];
  const child: ComfyChildProcess = {
    stdout: { on: (_e, cb) => stdoutCbs.push(cb) },
    stderr: { on: () => {} },
    on: (event, cb) => {
      if (event === 'exit') {
        setTimeout(() => {
          if (stdoutLine !== undefined) for (const c of stdoutCbs) c(stdoutLine);
          (cb as (code: number | null, signal: string | null) => void)(exitCode, null);
        }, 0);
      }
    },
  };
  return child;
}

interface FakeWorld {
  files: Set<string>;
  dirs: Map<string, string[]>;
  consent: boolean;
}

function makeManager(world: FakeWorld, overrides: { failStep?: string } = {}) {
  const events: ComfyInstallEvent[] = [];
  const spawned: { command: string; args: readonly string[] }[] = [];

  const fs: ComfyFsOps = {
    exists: async (p) => world.files.has(p),
    mkdirp: async (p) => {
      if (!world.dirs.has(p)) world.dirs.set(p, []);
    },
    writeFile: async (p) => {
      world.files.add(p);
    },
  };
  const consentStore: ConsentStore = {
    hasConsent: async () => world.consent,
    setConsent: async () => {
      world.consent = true;
    },
  };
  const spawn = (command: string, args: readonly string[]) => {
    spawned.push({ command, args });
    const fail = overrides.failStep !== undefined && args.join(' ').includes(overrides.failStep);
    // The manager itself writes the pack marker (via fs.writeFile) after a
    // successful download, so a re-probe sees it installed — the fake spawn just
    // reports success/failure.
    return fakeChild(fail ? 1 : 0, 'Installed 1 package');
  };

  const manager = new ComfyInstallManager({
    root: '/r',
    uvPath: '/bin/uv',
    spawn,
    fs,
    consentStore,
    emit: (e) => events.push(e),
  });
  return { manager, events, spawned, world };
}

describe('ComfyInstallManager.run', () => {
  it('refuses to install (emits consent-required) before GPL consent', async () => {
    const world: FakeWorld = { files: new Set(), dirs: new Map(), consent: false };
    const { manager, events } = makeManager(world);
    await expect(manager.run(['ace-step'])).rejects.toThrow(/consent/i);
    expect(events.some((e) => e.kind === 'consent-required')).toBe(true);
  });

  it('blocks a gated pack whose EULA was not accepted (nothing fetched)', async () => {
    const world: FakeWorld = {
      files: new Set(['/r/ComfyUI/main.py', '/r/venv/bin/python', '/r/extra_model_paths.yaml']),
      dirs: new Map(),
      consent: true,
    };
    const { manager, events, spawned } = makeManager(world);
    await expect(manager.run(['ltx-2'], [])).rejects.toThrow(/license not accepted/);
    const blocked = events.find((e) => e.kind === 'blocked');
    expect(blocked).toMatchObject({ kind: 'blocked', packId: 'ltx-2', license: 'ltx-2-community' });
    // No download spawn happened.
    expect(spawned.some((s) => s.args.includes('download'))).toBe(false);
  });

  it('drives the full bring-up in order on a consented, empty machine', async () => {
    const world: FakeWorld = { files: new Set(), dirs: new Map(), consent: true };
    const { manager, events, spawned, world: w } = makeManager(world);
    const state = await manager.run(['ace-step']);

    // Step-start order proves the sequencing.
    const startOrder = events
      .filter(
        (e): e is Extract<ComfyInstallEvent, { kind: 'step-start' }> => e.kind === 'step-start',
      )
      .map((e) => e.step);
    expect(startOrder).toEqual([
      'create-venv',
      'install-comfyui',
      'install-torch',
      'download-pack',
      'write-config',
    ]);
    // venv → uv venv; torch → the nightly install; both spawned via the bundled uv.
    expect(spawned[0]).toMatchObject({
      command: '/bin/uv',
      args: expect.arrayContaining(['venv']),
    });
    expect(spawned.some((s) => s.args.includes('--pre') && s.args.includes('torch'))).toBe(true);
    // The yaml was written + the pack is now seen as installed.
    expect(w.files.has('/r/extra_model_paths.yaml')).toBe(true);
    expect(state.packs.find((p) => p.id === 'ace-step')?.installed).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done', installedPackIds: ['ace-step'] });
  });

  it('installs a gated pack once its EULA is accepted, via byte-progress streaming', async () => {
    const world: FakeWorld = {
      files: new Set(['/r/ComfyUI/main.py', '/r/venv/bin/python', '/r/extra_model_paths.yaml']),
      dirs: new Map(),
      consent: true,
    };
    const events: ComfyInstallEvent[] = [];
    const download = vi.fn(
      async (_src: string, _dest: string, onBytes: (r: number, t: number | null) => void) => {
        onBytes(512, 1024);
        world.dirs.set('/r/shared-models/checkpoints', ['ltx.safetensors']);
      },
    );
    const manager = new ComfyInstallManager({
      root: '/r',
      uvPath: '/bin/uv',
      spawn: () => fakeChild(0),
      fs: {
        exists: async (p) => world.files.has(p),
        mkdirp: async (p) => {
          world.dirs.set(p, world.dirs.get(p) ?? []);
        },
        writeFile: async (p) => {
          world.files.add(p);
        },
      },
      consentStore: { hasConsent: async () => true, setConsent: async () => {} },
      download,
      emit: (e) => events.push(e),
    });

    await manager.run(['ltx-2'], ['ltx-2-community']);
    expect(download).toHaveBeenCalledOnce();
    const progress = events.find((e) => e.kind === 'progress' && e.packId === 'ltx-2');
    expect(progress).toMatchObject({ ratio: 0.5, receivedBytes: 512, totalBytes: 1024 });
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('surfaces a failing step as an error event and rejects', async () => {
    const world: FakeWorld = { files: new Set(), dirs: new Map(), consent: true };
    const { manager, events } = makeManager(world, { failStep: 'venv' });
    await expect(manager.run([])).rejects.toThrow(/exited 1/);
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });

  it('is idempotent — a fully-installed base plans no steps and completes', async () => {
    const world: FakeWorld = {
      files: new Set([
        '/r/ComfyUI/main.py',
        '/r/venv/bin/python',
        '/r/extra_model_paths.yaml',
        '/r/.pi-packs/ace-step.installed', // manifest marker ⇒ ace-step installed
      ]),
      dirs: new Map(),
      consent: true,
    };
    const { manager, events, spawned } = makeManager(world);
    await manager.run(['ace-step']);
    expect(spawned).toEqual([]); // nothing spawned
    expect(events.some((e) => e.kind === 'step-start')).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('probe() exposes the extra_model_paths.yaml path for the supervisor', async () => {
    const world: FakeWorld = { files: new Set(), dirs: new Map(), consent: true };
    const { manager } = makeManager(world);
    expect(manager.paths.extraModelPathsYaml).toBe('/r/extra_model_paths.yaml');
  });
});

// ── keep the exported license-type union honest ──────────────────────────────

describe('type surface', () => {
  it('accepted-license values line up with the gated packs', () => {
    const licenses: ComfyPackLicense[] = COMFY_MODEL_PACKS.filter((p) => !p.commercialUse).map(
      (p) => p.license,
    );
    expect(new Set(licenses)).toEqual(new Set(['ltx-2-community', 'stability-community']));
  });
});
