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
  /** Every known project + the active id (null = working outside a project). */
  'project:list': {
    request: undefined;
    response: { projects: ProjectEntry[]; activeId: string | null };
  };
  /** Activate a project by id (or by adding/reusing a path). Returns the active
   * project (null when the id/path could not be resolved). */
  'project:set': {
    request: { id?: string; path?: string };
    response: { project: ProjectEntry | null; projects: ProjectEntry[] };
  };
  /** Pick a folder (native dialog) → add + activate it. `project` is null when
   * the user cancelled the folder picker. */
  'project:new': {
    request: { path?: string } | undefined;
    response: { project: ProjectEntry | null; projects: ProjectEntry[] };
  };
  /** Clear the active project ("Don't work in a project"). */
  'project:clear': {
    request: undefined;
    response: { projects: ProjectEntry[] };
  };
};

export const PROJECT_INVOKE_CHANNELS = [
  'project:list',
  'project:set',
  'project:new',
  'project:clear',
] as const satisfies readonly (keyof ProjectInvokeMap)[];
