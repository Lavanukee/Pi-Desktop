/**
 * Project (working-folder) IPC contract. A "project" is just a named working
 * folder the app can scope pi's session cwd + the canvas file-tree root to. The
 * list + active id persist to `~/.pi/desktop/projects.json`. Composed into the
 * app-wide maps in ../ipc-contract.ts.
 */

/** One persisted project — a working folder with a stable id + display name. */
export interface ProjectEntry {
  /** Stable id (derived from the absolute path). */
  id: string;
  /** Display label (the folder's basename). */
  name: string;
  /** Absolute path of the working folder. */
  path: string;
}

export type ProjectInvokeMap = {
  /** Every known project + the active id (null = working outside a project).
   * `activeMissing` is true when an active project IS selected but its folder no
   * longer exists on disk. `usingSandbox` is true whenever there is NO valid
   * active project (none selected OR the selected one is gone) — pi then roots the
   * conversation at its per-conversation sandbox (electron/sandbox.ts), so the
   * composer folder chip reads "Sandbox"/"No project" (blind-test round-2 #2).
   *
   * STALE-CLEAR (round-2 #3): a persisted active project whose folder no longer
   * exists is cleared to none here (activeId → null) so a dead folder name is
   * never surfaced; the files panel then defaults to "No project selected". */
  'project:list': {
    request: undefined;
    response: {
      projects: ProjectEntry[];
      activeId: string | null;
      activeMissing: boolean;
      usingSandbox: boolean;
    };
  };
  /** Activate a project by id (or by adding/reusing a path). Returns the active
   * project (null when the id/path could not be resolved). `activeMissing` flags
   * that the active folder is gone from disk; `usingSandbox` flags no valid
   * active project (see `project:list`). */
  'project:set': {
    request: { id?: string; path?: string };
    response: {
      project: ProjectEntry | null;
      projects: ProjectEntry[];
      activeMissing: boolean;
      usingSandbox: boolean;
    };
  };
  /** Pick a folder (native dialog) → add + activate it. `project` is null when
   * the user cancelled the folder picker. */
  'project:new': {
    request: { path?: string } | undefined;
    response: {
      project: ProjectEntry | null;
      projects: ProjectEntry[];
      activeMissing: boolean;
      usingSandbox: boolean;
    };
  };
  /** Clear the active project ("Don't work in a project"). `usingSandbox` is then
   * always true (no project → sandbox). */
  'project:clear': {
    request: undefined;
    response: { projects: ProjectEntry[]; usingSandbox: boolean };
  };
};

export const PROJECT_INVOKE_CHANNELS = [
  'project:list',
  'project:set',
  'project:new',
  'project:clear',
] as const satisfies readonly (keyof ProjectInvokeMap)[];
