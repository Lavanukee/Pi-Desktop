import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWorkerUvArgs,
  DEFAULT_PYTHON_VERSION,
  GEN_WORKER_PATH_ENV,
  MFLUX_PIN,
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
