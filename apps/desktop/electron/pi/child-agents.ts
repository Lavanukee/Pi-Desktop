/**
 * App-owned CHILD pi instances — the multi-agent core. A subagent (or a running
 * role) is not a grandchild hidden inside the main pi child; it's a first-class
 * `pi --mode rpc` instance the APP spawns and drives, exactly like the main chat,
 * so its full transcript (thinking, tool calls, responses) streams to the
 * renderer and renders as a nested chat under its parent.
 *
 * This is the electron-free core (bridge lifecycle + the pi:child-* handlers);
 * pi-main.ts injects the real PiBridge factory + the event wire, mirroring the
 * pi-sessions.ts split so it unit-tests in plain Node.
 */

import type { PiBridgeEvent } from '@pi-desktop/engine';
import type { ChildAgentInfo } from './contract';
import type { SessionLog, SessionSender } from './pi-sessions';

/** Structural slice of PiBridge the child manager needs (tests inject a fake). */
export interface ChildBridge {
  readonly alive: boolean;
  readonly pid: number;
  ready(): Promise<void>;
  prompt(message: string): Promise<unknown>;
  abort(): Promise<unknown>;
  whenExited(): Promise<void>;
  /** Immediate SIGKILL (no grace) — the quit hold's last-resort reap. */
  killNow(): void;
  dispose(): void;
}

export interface ChildSpawnRequest {
  childId: string;
  parentId: string;
  title: string;
  goal: string;
  cwd?: string;
}

export interface ChildAgentsDeps<S extends SessionSender> {
  /** Build an app-owned child pi bridge (pi-main injects the real PiBridge with
   * the same base config as the main chat + `--no-session` + a bumped subagent
   * depth so a child can't recursively spawn its own children). */
  createChildBridge: (
    opts: { cwd?: string },
    onEvent: (event: PiBridgeEvent) => void,
  ) => ChildBridge;
  /** Fan one tagged child event out to the renderer (the 'pi:child-event' wire). */
  sendChildEvent: (
    sender: S,
    msg: { childId: string; parentId: string; event: PiBridgeEvent },
  ) => void;
  log: SessionLog;
}

interface ChildRecord {
  readonly childId: string;
  readonly parentId: string;
  readonly title: string;
  readonly senderId: number;
  readonly bridge: ChildBridge;
}

export interface ChildAgents<S extends SessionSender> {
  spawn(
    sender: S,
    req: ChildSpawnRequest,
  ): Promise<{ success: boolean; pid?: number; error?: string }>;
  disposeChild(childId: string): { success: boolean; error?: string };
  list(senderId: number): ChildAgentInfo[];
  /** Reap every child owned by a window (called when its WebContents dies). */
  disposeForSender(senderId: number): void;
  disposeAll(): void;
  /** Live bridges, for the quit-hold to reap alongside the main ones. */
  bridges(): ChildBridge[];
}

export function createChildAgents<S extends SessionSender>(
  deps: ChildAgentsDeps<S>,
): ChildAgents<S> {
  const children = new Map<string, ChildRecord>();

  async function spawn(
    sender: S,
    req: ChildSpawnRequest,
  ): Promise<{ success: boolean; pid?: number; error?: string }> {
    // A re-spawn with the same id replaces the old instance.
    children.get(req.childId)?.bridge.dispose();

    const bridge = deps.createChildBridge({ cwd: req.cwd }, (event) => {
      if (!sender.isDestroyed()) {
        deps.sendChildEvent(sender, { childId: req.childId, parentId: req.parentId, event });
      }
    });
    const record: ChildRecord = {
      childId: req.childId,
      parentId: req.parentId,
      title: req.title,
      senderId: sender.id,
      bridge,
    };
    children.set(req.childId, record);

    try {
      await bridge.ready();
      if (!bridge.alive) {
        children.delete(req.childId);
        return { success: false, error: 'child pi exited at startup' };
      }
    } catch (error) {
      children.delete(req.childId);
      return { success: false, error: String(error instanceof Error ? error.message : error) };
    }

    // Drive the goal but DON'T await the turn — the transcript streams out live
    // over pi:child-event; the caller only needs the spawn to have started.
    void bridge.prompt(req.goal).catch((error) => {
      deps.log.warn('child agent prompt failed', {
        childId: req.childId,
        error: String(error instanceof Error ? error.message : error),
      });
    });
    deps.log.info('child agent spawned', {
      childId: req.childId,
      parentId: req.parentId,
      pid: bridge.pid,
    });
    return { success: true, pid: bridge.pid };
  }

  function disposeChild(childId: string): { success: boolean; error?: string } {
    const record = children.get(childId);
    if (record === undefined) return { success: false, error: 'no such child agent' };
    children.delete(childId);
    record.bridge.dispose();
    deps.log.info('child agent disposed', { childId });
    return { success: true };
  }

  function list(senderId: number): ChildAgentInfo[] {
    return [...children.values()]
      .filter((r) => r.senderId === senderId && r.bridge.alive)
      .map((r) => ({ childId: r.childId, parentId: r.parentId, title: r.title }));
  }

  function disposeForSender(senderId: number): void {
    for (const r of [...children.values()]) {
      if (r.senderId === senderId) disposeChild(r.childId);
    }
  }

  function disposeAll(): void {
    for (const childId of [...children.keys()]) disposeChild(childId);
  }

  function bridges(): ChildBridge[] {
    return [...children.values()].map((r) => r.bridge);
  }

  return { spawn, disposeChild, list, disposeForSender, disposeAll, bridges };
}
