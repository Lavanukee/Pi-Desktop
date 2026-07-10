/**
 * Stable on-disk cache locations for downloaded llama.cpp binaries and GGUF
 * models. Everything lives under a single root so a user can wipe it in one
 * `rm -rf`. The root is overridable via `PI_DESKTOP_CACHE_DIR` — tests point it
 * at a scratch dir so they never touch the user's real cache.
 *
 * This module imports nothing electron-specific; `homedir()` is plain Node.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of the Pi Desktop download cache (`~/.cache/pi-desktop` by default). */
export function cacheRoot(): string {
  const override = process.env.PI_DESKTOP_CACHE_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.cache', 'pi-desktop');
}

/** Directory for a specific pinned llama.cpp release, e.g. `.../llamacpp/b9934`. */
export function llamacppDir(tag: string): string {
  return join(cacheRoot(), 'llamacpp', tag);
}

/** Directory holding downloaded GGUF model files. */
export function modelsDir(): string {
  return join(cacheRoot(), 'models');
}

/** Per-model subdirectory keyed by catalog id (files + siblings live together). */
export function modelDir(modelId: string): string {
  return join(modelsDir(), modelId);
}
