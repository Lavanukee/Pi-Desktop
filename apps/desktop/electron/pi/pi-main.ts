/**
 * Main-process pi wiring: one PiBridge child per window (WebContents), every
 * bridge event multiplexed to that window over the shared event wire.
 *
 * The engine never imports electron; session lifecycle/handler logic lives in
 * the electron-free ./pi-sessions module, and this module is the seam where
 * Electron specifics (app path, ipcMain, webContents) are injected.
 */

import { readFileSync } from 'node:fs';
import type { PiBridgeEvent } from '@pi-desktop/engine';
import { PiBridge } from '@pi-desktop/engine/main';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { app, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';
import { getInferenceUtility } from '../inference/llm-main';
import type { AppEventMap } from '../ipc-contract';
import { activeProjectPath } from '../project/project-main';
import { resolveSessionCwd } from '../sandbox';
import { advancedSamplingFilePath, generationExperimentEnabled } from '../settings/settings-main';
import { isTrustedIpcEvent } from '../trusted-senders';
import { type ChildAgents, createChildAgents } from './child-agents';
import type { PiInvokeMap } from './contract';
import { extensionPackageDirs } from './extension-dirs';
import { createPiSessions, type PiSessionHandlers } from './pi-sessions';
import { installPiQuitHold } from './quit-hold';
import { registerSubagentBridge } from './subagent-bridge';

const log = createLogger('desktop:pi');
const events = createIpcEventSender<AppEventMap>();

/**
 * The bundled pi extension packages, loaded via repeated `-e` flags. The list is
 * built by the pure {@link extensionPackageDirs} helper: always-on providers +
 * tools (provider-llamacpp/afm/mlx, harness, web-tools, browser-use,
 * mac-connectors, mac-computer-use, mcp-lite), PLUS the `gen-tools` generation
 * tools ONLY when the EXPERIMENTAL generation flag / `PI_DESKTOP_GEN=1` is on —
 * so a default build never exposes the generation tools. Each dir is resolved to
 * its `<pkg>/src/index.ts` — repo-relative in dev, bundle-relative (in the asar)
 * when packaged — and only those that actually `export default` an activate are
 * included, so an absent/placeholder extension is tolerated and lands
 * automatically once its workstream ships.
 *
 * The flag is read once at module load (whenReady). A mid-session toggle applies
 * on the NEXT app launch — matching how an experimental extension-loading flag
 * behaves (the dev `PI_DESKTOP_GEN=1` override is the immediate path).
 */
const EXTENSION_PACKAGE_DIRS = extensionPackageDirs(generationExperimentEnabled());

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
function buildPiEnv(cwd: string | undefined): Record<string, string | undefined> {
  const utility = getInferenceUtility();
  return {
    ...process.env,
    // File-spill containment (blind-test round-2 #2): turn ON the harness's
    // sandbox-fenced write/edit/read/ls override (packages/harness sandbox-fs.ts)
    // for every desktop-spawned pi, and hand it the resolved sandbox/project cwd
    // so a RELATIVE path the model writes lands there — never HOME. Set even when
    // `cwd` is undefined (a resumed session restores its own cwd; the override
    // falls back to pi's per-session ctx.cwd, still never HOME).
    PI_DESKTOP_FS_FENCE: '1',
    // The sampling-override sidecar the provider's advanced-params hook reads for
    // live per-request sampling (power-user panel). Pointing at a stable path;
    // the file may not exist yet (default profile) — the hook no-ops then.
    PI_ADV_SAMPLING_FILE: advancedSamplingFilePath(),
    ...(cwd !== undefined ? { PI_DESKTOP_WORKSPACE_ROOT: cwd } : {}),
    ...(utility !== null
      ? { PI_DESKTOP_UTILITY_BASE_URL: utility.baseUrl, PI_DESKTOP_UTILITY_MODEL: utility.model }
      : {}),
  };
}

const sessions = createPiSessions<WebContents>({
  createBridge: (req, onEvent, opts) => {
    // No project/working-folder + no session to resume → root this conversation
    // at its dedicated `~/.pi/desktop/sandbox/<id>/` sandbox (created on demand)
    // rather than letting pi fall back to HOME. An explicit project cwd still
    // wins; resuming a session defers to its recorded cwd. See electron/sandbox.ts.
    // Also published to the pi child (buildPiEnv) as PI_DESKTOP_WORKSPACE_ROOT so
    // the harness file-tool override roots relative writes here, not HOME (#2).
    // Root EVERY spawn at the active project when one is selected: a resume /
    // model-switch respawn carries no explicit cwd, so without this the session's
    // stale recorded cwd (the sandbox) wins and bash/file ops silently leave the
    // project. An explicit request cwd (a fresh start already carrying the project)
    // still takes precedence.
    const cwd = resolveSessionCwd({ ...req, cwd: req.cwd ?? activeProjectPath() ?? undefined });
    return new PiBridge(
      {
        cwd,
        sessionPath: req.sessionPath,
        env: buildPiEnv(cwd),
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
        //
        // `--no-skills`: SAME discipline for skills. pi auto-discovers
        // `~/.pi/agent/skills/*` and injects an `<available_skills>` catalog into
        // EVERY turn's system prompt. That leaks a user's UNRELATED global skills
        // (jedd saw `coding` / `isaac` / `plan` / `unity` from other projects) into
        // this app's chat — bloat the app never asked for, and skills aren't a
        // designed feature here yet. Off until we surface a curated set from our
        // own bundled dir on purpose.
        extraArgs: ['--no-extensions', '--no-skills'],
        killGraceMs: KILL_GRACE_MS,
        // Spawn pi as its own process-group leader so quit/dispose reaps its
        // subagent grandchildren too, not just the direct child (task #55): a
        // hard-kill otherwise strands orphaned subagent pi processes.
        detached: true,
        // Bundled resolution root; PI_BIN (E2E/mock) and explicit binPath
        // still take precedence inside the engine.
        appRoot: app.getAppPath(),
      },
      onEvent,
    );
  },
  sendEvent: (sender, event) => events.send(sender, 'pi:event', event),
  log,
});

/**
 * Build an app-owned CHILD pi instance (a subagent / role as its own first-class
 * `pi --mode rpc`, driven by the app exactly like the main chat). Same base
 * config as the main bridge, but a fresh `--no-session` and a bumped subagent
 * depth so the child's own harness won't register spawn_subagent — no runaway
 * recursion of children spawning children.
 */
function createChildBridge(
  opts: { cwd?: string },
  onEvent: (event: PiBridgeEvent) => void,
): PiBridge {
  const cwd = resolveSessionCwd({ cwd: opts.cwd ?? activeProjectPath() ?? undefined });
  return new PiBridge(
    {
      cwd,
      env: {
        ...buildPiEnv(cwd),
        // Matches SUBAGENT_DEPTH_ENV (packages/harness subagent/types.ts): a child
        // at depth >= 1 does NOT register the spawn tool.
        PI_DESKTOP_SUBAGENT_DEPTH: '1',
      },
      noSession: true,
      extensionPaths: EXTENSION_PATHS,
      extraArgs: ['--no-extensions', '--no-skills'],
      killGraceMs: KILL_GRACE_MS,
      detached: true,
      appRoot: app.getAppPath(),
    },
    onEvent,
  );
}

const childAgents: ChildAgents<WebContents> = createChildAgents<WebContents>({
  createChildBridge,
  sendChildEvent: (sender, msg) => events.send(sender, 'pi:child-event', msg),
  log,
});

/** Senders whose child-agent reap-on-destroy hook is already installed. */
const childReapHooked = new Set<number>();

/** Register the pi:child-* handlers (guarded like the main pi channels). A child
 * pi is exec-capable, so only trusted main frames may spawn/drive one; children
 * are reaped when their owning window is destroyed and in the quit hold. */
function registerChildAgentIpc(): void {
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!isTrustedIpcEvent(event)) {
      log.warn('rejected child-agent invoke from untrusted sender', {
        channel,
        wcId: event.sender.id,
      });
      throw new Error(`[pi] rejected "${channel}": untrusted sender`);
    }
  };
  ipcMain.handle('pi:child-spawn', (event, req: PiInvokeMap['pi:child-spawn']['request']) => {
    guard(event, 'pi:child-spawn');
    const sender = event.sender;
    if (!childReapHooked.has(sender.id)) {
      childReapHooked.add(sender.id);
      sender.once('destroyed', () => {
        childAgents.disposeForSender(sender.id);
        childReapHooked.delete(sender.id);
      });
    }
    return childAgents.spawn(sender, req);
  });
  ipcMain.handle('pi:child-dispose', (event, req: PiInvokeMap['pi:child-dispose']['request']) => {
    guard(event, 'pi:child-dispose');
    return childAgents.disposeChild(req.childId);
  });
  ipcMain.handle('pi:child-list', (event) => {
    guard(event, 'pi:child-list');
    return { children: childAgents.list(event.sender.id) };
  });
}

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

/**
 * @param opts.extraTeardown Non-pi child processes to reap in the SAME held quit
 *   window as the pi bridges — the inference utilityProcess+llama-server, the
 *   pi-mac helper, and terminal PTYs. Composed in main.ts (the wiring root) and
 *   awaited (bounded by the quit grace) before `app.exit()`.
 */
export function registerPiIpc(
  opts: {
    extraTeardown?: () => Promise<void>;
    /** The app window subagents run under (spawn_subagent → app bridge). When
     * given, the subagent socket bridge stands up + publishes its env before the
     * first pi spawn, so the child's harness routes spawn_subagent to the app. */
    getWindow?: () => WebContents | null;
  } = {},
): void {
  registerAll(sessions.handlers);
  registerChildAgentIpc();
  if (opts.getWindow !== undefined) registerSubagentBridge(opts.getWindow, childAgents);

  installPiQuitHold(app, {
    // Reap child-agent pi instances in the same held quit window as the main
    // bridges, so no orphaned subagent/role pi processes leak on quit.
    bridges: () => [...sessions.bridges(), ...childAgents.bridges()],
    disposeAll: () => {
      sessions.disposeAll();
      childAgents.disposeAll();
    },
    graceMs: KILL_GRACE_MS,
    extraTeardown: opts.extraTeardown,
  });
}
