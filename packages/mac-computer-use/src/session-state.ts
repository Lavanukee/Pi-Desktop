/**
 * The per-session CONTROLLED-APP state machine.
 *
 * jedd's core computer-use requirement: once the model opens (or snapshots) an
 * app, the session must KNOW that app is the controlled target — every
 * subsequent click/type/key/scroll routes to it unambiguously (pid-stamped, so
 * the helper resolves indices in the right namespace AND delivers fallback
 * events to that app only, in the background), and the model is told what it
 * is controlling.
 *
 * Pure state in a closure — no bridge, no timers — so the contract unit-tests
 * exactly: which events take control, which merely refresh it, and what gets
 * stamped onto acts.
 *
 * Transitions:
 *   - `noteLaunched(app, pid)`   → takes control (mac_launch resolved a pid).
 *   - `noteSnapshot(snap)`       → takes/refreshes control: an explicit-app or
 *     first snapshot moves control to the snapshotted app; a default snapshot
 *     of the already-controlled app just refreshes its metadata.
 *   - `release()`                → drops control (app gone / session reset).
 */

/** The app this session is currently driving. */
export interface ControlledApp {
  readonly pid: number;
  readonly app: string;
  readonly windowId?: number;
}

/** Snapshot-shaped input (structural: the wire MacSnapshot satisfies it). */
export interface ControlledSnapshotNote {
  readonly app?: string;
  readonly pid?: number;
  readonly windowId?: number;
}

export interface MacSessionState {
  /** The controlled app, or null before anything was launched/snapshotted. */
  controlled(): ControlledApp | null;
  /** mac_launch resolved a background-opened app → it takes control. */
  noteLaunched(app: string, pid: number, windowId?: number): void;
  /** A snapshot resolved → the snapshotted app takes/refreshes control. */
  noteSnapshot(snap: ControlledSnapshotNote): void;
  /** Drop control (controlled app quit / explicit reset). */
  release(): void;
  /** Params every act must be stamped with: `{ pid }` while controlling, `{}`
   * before control exists (legacy frontmost behavior). */
  targetParams(): Record<string, unknown>;
  /** One human/model-readable line naming the controlled target ('' if none). */
  describe(): string;
}

/** Build a fresh session state (one per extension instance / pi session). */
export function createMacSessionState(): MacSessionState {
  let current: ControlledApp | null = null;

  return {
    controlled: () => current,

    noteLaunched(app: string, pid: number, windowId?: number): void {
      current = { pid, app, windowId };
    },

    noteSnapshot(snap: ControlledSnapshotNote): void {
      if (typeof snap.pid !== 'number') return; // unresolved snapshot cannot take control
      current = {
        pid: snap.pid,
        app: snap.app ?? current?.app ?? '',
        windowId: snap.windowId ?? (snap.pid === current?.pid ? current?.windowId : undefined),
      };
    },

    release(): void {
      current = null;
    },

    targetParams(): Record<string, unknown> {
      return current === null ? {} : { pid: current.pid };
    },

    describe(): string {
      return current === null ? '' : `You are controlling "${current.app}" (pid ${current.pid}).`;
    },
  };
}
