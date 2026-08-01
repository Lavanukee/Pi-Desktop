/**
 * Where `worker.py` actually is, from inside the bundled Electron main.
 *
 * gen-service resolves it from `import.meta.url` (`packageRoot()` in
 * gen-service/src/worker-command.ts), which is correct when that package runs as
 * itself and WRONG here: it is bundled into apps/desktop/dist-electron, so
 * `..` yields `apps/desktop/python/worker.py`. Which does not exist, so every
 * image generation died:
 *
 *   gen worker exited (code 2) … can't open file
 *   '/Users/jedd/Desktop/OSS-harness/apps/desktop/python/worker.py'
 *
 * That is not a quiet degrade. The model asked to annotate a screenshot watched
 * `generate_image` fail and fell back to drawing on a blank canvas — a plausible
 * artefact produced by a broken tool, which is the hardest kind of failure to
 * see from the outside.
 *
 * So the path is resolved HERE, where the layout is known, against real
 * candidates, and the failure is loud rather than a spawn that cannot start.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/** Candidate locations, most-specific first. */
export function genWorkerCandidates(deps: {
  /** `process.resourcesPath` in a packaged app; undefined in dev. */
  readonly resourcesPath?: string | undefined;
  /** `app.getAppPath()` — the asar root packaged, the app dir in dev. */
  readonly appPath: string;
}): string[] {
  const out: string[] = [];
  if (deps.resourcesPath !== undefined && deps.resourcesPath.length > 0) {
    // Packaged: shipped as an extraResource next to the asar.
    out.push(path.join(deps.resourcesPath, 'gen-worker', 'worker.py'));
  }
  // Dev: apps/desktop → ../../packages/gen-service/python/worker.py. Also the
  // sibling form for a checkout laid out differently.
  out.push(
    path.join(deps.appPath, '..', '..', 'packages', 'gen-service', 'python', 'worker.py'),
    path.join(deps.appPath, '..', 'packages', 'gen-service', 'python', 'worker.py'),
    path.join(deps.appPath, 'node_modules', '@pi-desktop', 'gen-service', 'python', 'worker.py'),
  );
  return out.map((p) => path.normalize(p));
}

/**
 * The first candidate that exists, or `undefined`.
 *
 * Returning undefined is deliberate: the caller leaves `workerScript` unset and
 * gen-service falls back to its own resolution, which at least keeps a
 * standalone (non-Electron) embedder working. What must not happen is silently
 * handing over a path we already know is wrong.
 */
export function resolveGenWorkerScript(
  deps: { resourcesPath?: string | undefined; appPath: string },
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  return genWorkerCandidates(deps).find(exists);
}
