/**
 * On-disk cache locations for the uv runtime this package bootstraps.
 *
 * Self-contained by design: W6 owns its uv binary independently of
 * @pi-desktop/inference (which caches llama.cpp binaries under the same root).
 * Sharing the root — `~/.cache/pi-desktop` — means one `rm -rf` wipes both, and
 * the layout is namespaced (`uv/<version>`) so they never collide. The root is
 * overridable via `PI_DESKTOP_CACHE_DIR` so tests point it at a scratch dir.
 *
 * Plain Node only; imports nothing electron-specific.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of the Pi Desktop download cache (`~/.cache/pi-desktop` by default). */
export function cacheRoot(): string {
  const override = process.env.PI_DESKTOP_CACHE_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.cache', 'pi-desktop');
}

/** Directory for a specific pinned uv release, e.g. `.../uv/0.11.28`. */
export function uvDir(version: string): string {
  return join(cacheRoot(), 'uv', version);
}
