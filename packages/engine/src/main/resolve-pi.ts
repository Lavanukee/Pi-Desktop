/**
 * pi binary resolution. Order (first hit wins):
 *   1. explicit `binPath` option
 *   2. `PI_BIN` env var (E2E tests point this at tools/mock-pi)
 *   3. the bundled @mariozechner/pi-coding-agent/dist/cli.js located under
 *      `appRoot` (walking up through node_modules), run with the current
 *      executable — under Electron that is `process.execPath` +
 *      ELECTRON_RUN_AS_NODE=1 (no separate Node needed), otherwise plain node
 *   4. bare `pi` on PATH
 *
 * The bundled path is located with a filesystem walk rather than module
 * resolution: pi's `exports` map exposes neither `./dist/cli.js` nor
 * `./package.json`, so require.resolve/import.meta.resolve cannot reach the
 * CLI entry. The walk also matches where a packaged Electron app unpacks the
 * dependency (asarUnpack → <appRoot>/node_modules/...).
 *
 * Everything host-dependent is injectable so resolution is unit-testable in
 * plain Node without Electron or a real install.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PiSpawnPlan {
  command: string;
  /** Args to prepend before pi's own args (e.g. the cli.js path). */
  argsPrefix: string[];
  /** Extra env vars required by this plan (e.g. ELECTRON_RUN_AS_NODE). */
  env: Record<string, string>;
  source: 'binPath' | 'env' | 'bundled' | 'path';
}

export interface ResolvePiOptions {
  /** Explicit path to a pi executable (highest priority). */
  binPath?: string;
  /** Root used to locate the bundled pi package (e.g. Electron app path). */
  appRoot?: string;
  env?: Record<string, string | undefined>;
  /** `process.execPath` equivalent; used for the bundled plan. */
  execPath?: string;
  /** Whether execPath is an Electron binary (needs ELECTRON_RUN_AS_NODE). */
  isElectron?: boolean;
  /** Override the bundled-CLI locator entirely (tests). */
  locateBundledCli?: (appRoot: string) => string | undefined;
  /** Filesystem probe used by the default locator (tests). */
  fileExists?: (candidate: string) => boolean;
}

const BUNDLED_CLI_SEGMENTS = ['@mariozechner', 'pi-coding-agent', 'dist', 'cli.js'];

/** Walk from appRoot upward looking for node_modules/<pi>/dist/cli.js. */
export function locateBundledPiCli(
  appRoot: string,
  fileExists: (candidate: string) => boolean = fs.existsSync,
): string | undefined {
  let dir = path.resolve(appRoot);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...BUNDLED_CLI_SEGMENTS);
    if (fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolvePiSpawn(options: ResolvePiOptions = {}): PiSpawnPlan {
  const env = options.env ?? process.env;

  if (options.binPath !== undefined && options.binPath !== '') {
    return { command: options.binPath, argsPrefix: [], env: {}, source: 'binPath' };
  }

  const envBin = env.PI_BIN;
  if (envBin !== undefined && envBin !== '') {
    return { command: envBin, argsPrefix: [], env: {}, source: 'env' };
  }

  if (options.appRoot !== undefined && options.appRoot !== '') {
    const locate =
      options.locateBundledCli ??
      ((root: string) => locateBundledPiCli(root, options.fileExists ?? fs.existsSync));
    const cliPath = locate(options.appRoot);
    if (cliPath !== undefined) {
      const execPath = options.execPath ?? process.execPath;
      const isElectron = options.isElectron ?? Boolean(process.versions.electron);
      return {
        command: isElectron ? execPath : (options.execPath ?? 'node'),
        argsPrefix: [cliPath],
        env: isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        source: 'bundled',
      };
    }
  }

  return { command: 'pi', argsPrefix: [], env: {}, source: 'path' };
}
