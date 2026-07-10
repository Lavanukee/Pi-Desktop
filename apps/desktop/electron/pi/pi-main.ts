/**
 * Main-process pi wiring: one PiBridge child per window (WebContents), every
 * bridge event multiplexed to that window over the shared event wire.
 *
 * The engine never imports electron; session lifecycle/handler logic lives in
 * the electron-free ./pi-sessions module, and this module is the seam where
 * Electron specifics (app path, ipcMain, webContents) are injected.
 */

import { readFileSync } from 'node:fs';
import { PiBridge } from '@pi-desktop/engine/main';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { app, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';
import { getInferenceUtility } from '../inference/llm-main';
import type { AppEventMap } from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import { createPiSessions, type PiSessionHandlers } from './pi-sessions';
import { installPiQuitHold } from './quit-hold';

const log = createLogger('desktop:pi');
const events = createIpcEventSender<AppEventMap>();

/**
 * The bundled pi extension packages, loaded via repeated `-e` flags.
 * provider-llamacpp routes local models through its streamSimple provider
 * (llamacpp-stream api); provider-afm does the same for the Apple on-device
 * model (afm-stream api, helper path injected via PI_AFM_HELPER_PATH env, set by
 * afm-main.ts before the first spawn); harness (W5) and web-tools (W6) add
 * tools/commands. Each is resolved to its `<pkg>/src/index.ts` — repo-relative
 * in dev, bundle-relative (inside the asar) when packaged — via the shared
 * app-paths resolver, and only those that actually `export default` an activate
 * are included, so an absent/placeholder extension is tolerated and lands
 * automatically once its workstream ships. provider-afm registers a harmless
 * no-op handler off-platform (no afm block in models.json → never invoked).
 */
const EXTENSION_PACKAGE_DIRS = [
  'provider-llamacpp',
  'provider-afm',
  'harness',
  'web-tools',
  // browser-use drives the canvas browser via the browser-agent socket bridge;
  // mac-connectors (built by a parallel workstream) is referenced by dir even if
  // not shipped yet — an absent/placeholder extension is tolerated by the
  // export-default probe below, so both land automatically once present.
  'browser-use',
  'mac-connectors',
  // mcp-lite (W8): connects the user's ~/.pi/desktop/mcp-connectors.json servers
  // and exposes them to the model per the configured mode (lite proxy / native /
  // bash-cli). Its src/index.ts re-exports the extension's default so the
  // export-default probe below picks it up.
  'mcp-lite',
] as const;

function resolveExtensionPaths(): string[] {
  const out: string[] = [];
  for (const pkgDir of EXTENSION_PACKAGE_DIRS) {
    const abs = resolveBundledPackageAsset(pkgDir, 'src/index.ts');
    try {
      if (/export\s+default/.test(readFileSync(abs, 'utf8'))) out.push(abs);
    } catch {
      // Absent — tolerated; the workstream building it hasn't shipped yet.
    }
  }
  log.info('pi extensions resolved', { count: out.length, paths: out, packaged: app.isPackaged });
  return out;
}

const EXTENSION_PATHS: string[] = resolveExtensionPaths();

/** SIGTERM → SIGKILL grace for every bridge; the quit hold caps at this plus
 * a margin, so the two must not drift apart. */
const KILL_GRACE_MS = 1500;

/**
 * Env for the pi child, augmented (task #54) with the harness reliability
 * engine's utility endpoint when a local model server is running at spawn — so
 * the fixer / reviewer / adversarial / classifier-escalation actually fire,
 * pointed at the SAME local server pi uses. Read fresh on every spawn: a model
 * switch respawns pi (local-model.ts → restartPi), so a server that comes up
 * later is picked up on the next spawn. If no server is up, the vars are left
 * unset and the harness degrades to its heuristic fallback (never a hardcoded
 * URL). Dynamic gap: a server that starts WITHOUT a subsequent pi respawn won't
 * re-point the already-running child until the next spawn.
 */
function buildPiEnv(): Record<string, string | undefined> {
  const utility = getInferenceUtility();
  if (utility === null) return { ...process.env };
  return {
    ...process.env,
    PI_DESKTOP_UTILITY_BASE_URL: utility.baseUrl,
    PI_DESKTOP_UTILITY_MODEL: utility.model,
  };
}

const sessions = createPiSessions<WebContents>({
  createBridge: (req, onEvent, opts) =>
    new PiBridge(
      {
        cwd: req.cwd,
        sessionPath: req.sessionPath,
        env: buildPiEnv(),
        // Extensions are skipped on a post-crash retry (a broken/WIP extension
        // that exits pi at startup degrades to a working extension-free session).
        extensionPaths: opts?.extensionsDisabled === true ? [] : EXTENSION_PATHS,
        // Load ONLY our bundled `-e` extensions; never pi's auto-discovered
        // `~/.pi/agent/extensions/*.ts` (and `<cwd>/.pi/extensions`). A stale
        // user copy of any tool (e.g. web-tools.ts) there registers a duplicate
        // tool name → pi exits 1 at startup → the self-heal respawns
        // extension-free, which leaves models.json's `llamacpp-stream` api
        // UNHANDLED and dead-ends chat. `--no-extensions` (pi 0.68.1) disables
        // discovery only; explicit `-e` paths still load, so this guarantees the
        // primary path and makes the extension-free respawn a true last resort.
        extraArgs: ['--no-extensions'],
        killGraceMs: KILL_GRACE_MS,
        // Bundled resolution root; PI_BIN (E2E/mock) and explicit binPath
        // still take precedence inside the engine.
        appRoot: app.getAppPath(),
      },
      onEvent,
    ),
  sendEvent: (sender, event) => events.send(sender, 'pi:event', event),
  log,
});

/** Sender-aware variant of the shared register helper: pi channels route to a
 * per-window bridge, so handlers need event.sender. Exhaustive by type, and
 * gated on the trusted-sender registry — pi is an exec-capable agent, so only
 * main frames of app-created windows may reach a bridge. */
function registerAll(handlers: PiSessionHandlers<WebContents>): void {
  for (const [channel, handler] of Object.entries(handlers) as Array<
    [string, (sender: WebContents, request: unknown) => unknown]
  >) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, request: unknown) => {
      if (!isTrustedIpcEvent(event)) {
        log.warn('rejected invoke from untrusted sender', { channel, wcId: event.sender.id });
        throw new Error(`[pi] rejected "${channel}": untrusted sender`);
      }
      return handler(event.sender, request);
    });
  }
}

export function registerPiIpc(): void {
  registerAll(sessions.handlers);

  installPiQuitHold(app, {
    bridges: () => sessions.bridges(),
    disposeAll: () => sessions.disposeAll(),
    graceMs: KILL_GRACE_MS,
  });
}
