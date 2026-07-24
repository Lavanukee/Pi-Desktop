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

/**
 * On macOS, resolve the packaged app's **Helper** executable for `execPath`
 * (`…/Contents/MacOS/<App>` → `…/Contents/Frameworks/<App> Helper.app/Contents/
 * MacOS/<App> Helper`), or undefined when there is no such helper (dev runs,
 * other platforms, an unexpected layout).
 *
 * WHY (jedd: "each pi instance spawning a new application in the dock"): running
 * the CLI through the app's MAIN executable makes LaunchServices register the
 * child as an APPLICATION — it inherits the bundle's CFBundleIdentifier, gets its
 * own ASN, and takes a DOCK TILE, one per pi instance. Verified live: the pi
 * child came back as `LSDisplayName="pi"`, `CFBundleIdentifier=
 * "app.pidesktop.desktop"`, `LSASN=0x0-0x4146142`, listed alongside the real app.
 * Electron's Helper bundle sets `LSUIElement=true`, so the identical Node runtime
 * launched through it is never registered and never takes a tile. This is purely
 * about which binary hosts the process — the ELECTRON_RUN_AS_NODE runtime, args,
 * env and stdio are unchanged.
 */
export function macHelperExecPath(
  execPath: string,
  fileExists: (candidate: string) => boolean = fs.existsSync,
): string | undefined {
  // …/Contents/MacOS/<App>
  const macosDir = path.dirname(execPath);
  if (path.basename(macosDir) !== 'MacOS') return undefined;
  const contentsDir = path.dirname(macosDir);
  if (path.basename(contentsDir) !== 'Contents') return undefined;
  const appName = path.basename(execPath);
  const helper = path.join(
    contentsDir,
    'Frameworks',
    `${appName} Helper.app`,
    'Contents',
    'MacOS',
    `${appName} Helper`,
  );
  return fileExists(helper) ? helper : undefined;
}

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
      // Prefer the LSUIElement Helper binary so the child never takes a dock
      // tile (see macHelperExecPath). Falls back to execPath when absent.
      const host = isElectron
        ? (macHelperExecPath(execPath, options.fileExists ?? fs.existsSync) ?? execPath)
        : (options.execPath ?? 'node');
      return {
        command: host,
        argsPrefix: [cliPath],
        env: isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        source: 'bundled',
      };
    }
  }

  return { command: 'pi', argsPrefix: [], env: {}, source: 'path' };
}
