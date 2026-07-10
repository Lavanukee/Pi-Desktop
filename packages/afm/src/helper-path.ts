/**
 * Resolve + build the `pi-afm` Swift binary.
 *
 * This package stays electron-free, so it does NOT import the desktop app's
 * `app-paths.ts`. Instead the packaged location is injected: the app resolves
 * the binary via `resolveBundledPackageAsset('afm', 'swift/.build/release/pi-afm')`
 * (extraResources / asarUnpack) and passes it in as `helperPath`, or sets
 * `PI_AFM_HELPER_PATH`. With neither, we fall back to the dev build output.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HELPER_BINARY = 'pi-afm';

/** Absolute path to this package's root (…/packages/afm), derived from src/. */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // …/packages/afm/src
  return path.resolve(here, '..');
}

/** The SwiftPM package directory (…/packages/afm/swift). */
export function swiftDir(): string {
  return path.join(packageRoot(), 'swift');
}

/** Default dev-build output path of the compiled helper. */
export function devHelperPath(): string {
  return path.join(swiftDir(), '.build', 'release', HELPER_BINARY);
}

/**
 * Resolve the helper binary path, in priority order:
 *   1. an explicit override (packaged app passes the bundle-relative path),
 *   2. `PI_AFM_HELPER_PATH`,
 *   3. the dev `swift build -c release` output.
 */
export function helperPath(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const fromEnv = process.env.PI_AFM_HELPER_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return devHelperPath();
}

/**
 * Build the Swift helper via SwiftPM (`swift build -c release`) and return the
 * resulting binary path. Used by the `build:swift` npm script's programmatic
 * counterpart and by first-run bootstrap; no full Xcode required.
 */
export async function buildHelper(options?: { readonly cwd?: string }): Promise<string> {
  const cwd = options?.cwd ?? swiftDir();
  await execFileAsync('swift', ['build', '-c', 'release'], { cwd, maxBuffer: 32 * 1024 * 1024 });
  return path.join(cwd, '.build', 'release', HELPER_BINARY);
}
