import { describe, expect, it } from 'vitest';
import { genWorkerCandidates, resolveGenWorkerScript } from './worker-path.js';

/*
 * Every image generation failed because gen-service resolved worker.py from
 * `import.meta.url`, which — once bundled into the Electron main — points at
 * apps/desktop/dist-electron, so `..` gave apps/desktop/python/worker.py.
 * Measured: "gen worker exited (code 2) … can't open file
 * '/Users/jedd/Desktop/OSS-harness/apps/desktop/python/worker.py'".
 */
describe('gen worker path', () => {
  const appPath = '/repo/apps/desktop';

  it('finds the package copy in a dev checkout', () => {
    const hit = '/repo/packages/gen-service/python/worker.py';
    expect(resolveGenWorkerScript({ appPath }, (p) => p === hit)).toBe(hit);
  });

  it('prefers the packaged extraResource when present', () => {
    const res = '/Applications/Bobble.app/Contents/Resources';
    const got = resolveGenWorkerScript({ appPath, resourcesPath: res }, () => true);
    expect(got).toBe(`${res}/gen-worker/worker.py`);
  });

  it('never returns the wrong apps/desktop/python path', () => {
    for (const c of genWorkerCandidates({ appPath })) {
      expect(c).not.toBe('/repo/apps/desktop/python/worker.py');
    }
  });

  /* Undefined lets gen-service fall back to its own resolution, which keeps a
   * standalone embedder working. Handing over a path we KNOW is wrong is the
   * thing that must not happen. */
  it('returns undefined when nothing exists, rather than guessing', () => {
    expect(resolveGenWorkerScript({ appPath }, () => false)).toBeUndefined();
  });
});
