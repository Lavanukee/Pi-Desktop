import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  baseWorkerWith,
  buildWorkerUvArgs,
  DEFAULT_PYTHON_VERSION,
  GEN_WORKER_PATH_ENV,
  MFLUX_PIN,
  MLX_AUDIO_PIN,
  resolveWorkerScript,
} from './worker-command.ts';

describe('buildWorkerUvArgs', () => {
  it('builds `uv run --with mflux==<pin> python <worker>` by default', () => {
    const args = buildWorkerUvArgs({ workerScript: '/w/worker.py' });
    expect(args).toEqual([
      'run',
      '--no-project',
      '--python',
      DEFAULT_PYTHON_VERSION,
      '--with',
      `mflux==${MFLUX_PIN}`,
      'python',
      '/w/worker.py',
    ]);
  });

  it('pins mflux + python explicitly when asked', () => {
    const args = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      mfluxPin: '9.9.9',
      python: '3.13',
    });
    expect(args).toContain('mflux==9.9.9');
    expect(args[args.indexOf('--python') + 1]).toBe('3.13');
  });

  it('appends extra --with deps (a future modality backend) before python', () => {
    const args = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      extraWith: ['mlx-audio', 'soundfile'],
    });
    // Order: base mflux --with, then each extra --with, then `python <script>`.
    expect(args.slice(-6)).toEqual([
      '--with',
      'mlx-audio',
      '--with',
      'soundfile',
      'python',
      '/w/worker.py',
    ]);
  });

  it('uses the mlx-audio base for a TTS backend and does NOT force mflux', () => {
    const args = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend: 'mlx-audio' });
    expect(args).toContain(`mlx-audio==${MLX_AUDIO_PIN}`);
    expect(args.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(args.slice(0, 6)).toEqual([
      'run',
      '--no-project',
      '--python',
      DEFAULT_PYTHON_VERSION,
      '--with',
      `mlx-audio==${MLX_AUDIO_PIN}`,
    ]);
  });

  it('uses the 3D deps for triposr/trellis without dragging in mflux', () => {
    const triposr = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend: 'triposr' });
    expect(triposr.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(triposr).toContain('torch');

    const trellis = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend: 'trellis' });
    expect(trellis.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(trellis).toContain('trellis2-mlx');
  });

  it('keeps extraWith additive on a non-mflux backend (still no mflux)', () => {
    const args = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      backend: 'mlx-audio',
      extraWith: ['soundfile'],
    });
    expect(args.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(args.slice(-4)).toEqual(['--with', 'soundfile', 'python', '/w/worker.py']);
  });

  it('appends --serve AFTER the worker script for the persistent 3D path', () => {
    const args = buildWorkerUvArgs({
      workerScript: '/w/worker.py',
      backend: 'trellis',
      serveMode: true,
    });
    // `--serve` is a worker.py flag, so it must come after `python <script>`.
    expect(args.slice(-3)).toEqual(['python', '/w/worker.py', '--serve']);
    expect(args.some((a) => a.startsWith('mflux=='))).toBe(false);
    expect(args).toContain('trellis2-mlx');
  });

  it('omits --serve by default (process-per-job, unchanged)', () => {
    const args = buildWorkerUvArgs({ workerScript: '/w/worker.py' });
    expect(args).not.toContain('--serve');
    expect(args.slice(-2)).toEqual(['python', '/w/worker.py']);
  });

  it('adds no base --with for server/Node backends (not uv-worker driven)', () => {
    for (const backend of ['comfyui', 'hyperframes'] as const) {
      const args = buildWorkerUvArgs({ workerScript: '/w/worker.py', backend });
      expect(args).toEqual([
        'run',
        '--no-project',
        '--python',
        DEFAULT_PYTHON_VERSION,
        'python',
        '/w/worker.py',
      ]);
    }
  });
});

describe('baseWorkerWith', () => {
  it('maps each uv-worker backend to its base package(s)', () => {
    expect(baseWorkerWith('mflux')).toEqual([`mflux==${MFLUX_PIN}`]);
    expect(baseWorkerWith('mflux', '9.9.9')).toEqual(['mflux==9.9.9']);
    expect(baseWorkerWith('mlx-audio')).toEqual([`mlx-audio==${MLX_AUDIO_PIN}`]);
    expect(baseWorkerWith('triposr')).toContain('torch');
    expect(baseWorkerWith('trellis')).toContain('trellis2-mlx');
  });

  it('returns no base package for the persistent-server / Node backends', () => {
    expect(baseWorkerWith('comfyui')).toEqual([]);
    expect(baseWorkerWith('hyperframes')).toEqual([]);
  });
});

describe('resolveWorkerScript', () => {
  const prev = process.env[GEN_WORKER_PATH_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[GEN_WORKER_PATH_ENV];
    else process.env[GEN_WORKER_PATH_ENV] = prev;
  });

  it('honours an explicit override first', () => {
    expect(resolveWorkerScript('/explicit/worker.py')).toBe('/explicit/worker.py');
  });

  it('falls back to the env var', () => {
    delete process.env[GEN_WORKER_PATH_ENV];
    process.env[GEN_WORKER_PATH_ENV] = '/env/worker.py';
    expect(resolveWorkerScript()).toBe('/env/worker.py');
  });

  it('defaults to the bundled python/worker.py inside the package', () => {
    delete process.env[GEN_WORKER_PATH_ENV];
    const resolved = resolveWorkerScript();
    expect(resolved.endsWith(path.join('python', 'worker.py'))).toBe(true);
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});
