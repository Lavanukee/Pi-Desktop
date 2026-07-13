/**
 * Project (working-folder) store (round-8 #15). A "project" is a named working
 * folder that scopes two things:
 *   (a) the pi session cwd — switching the active project respawns pi rooted at
 *       the project folder (the only seam to change a live session's cwd), and
 *   (b) the canvas file-tree root — file tabs root their tree at the active
 *       project (see chat/canvas/file-tabs.ts, which reads `activePath`).
 *
 * The list + active id persist in main (`~/.pi/desktop/projects.json` via the
 * `project:*` IPC). This store mirrors them for the `ProjectPicker` chip and
 * drives the working-folder side effects on change.
 */
import { create } from 'zustand';
import type { ProjectEntry } from '../../electron/project/project-contract';
import { restartPi } from './pi-connect';
import { usePiStore } from './pi-slice';

interface ProjectState {
  projects: ProjectEntry[];
  activeId: string | null;
  /** Working folder of the active project, or null when working outside one. */
  activePath: string | null;
  /**
   * True when an active project IS selected but its folder no longer exists on
   * disk. pi then roots the conversation at its per-conversation SANDBOX instead
   * of the (dead) project path — and never HOME (see electron/sandbox.ts
   * resolveSessionCwd + the file-spill fix). The composer folder-chip reads this
   * to show a "missing / using sandbox" warn state (backlog #13) rather than
   * silently presenting a deleted folder as the working directory.
   */
  projectMissing: boolean;
  loaded: boolean;
  /** Load the persisted list + active id (no working-folder side effect). */
  load: () => Promise<void>;
  /** Activate an existing project by id. */
  selectProject: (id: string) => Promise<void>;
  /** Activate a project by absolute path (adds it if new). Used by "New project"
   * once a folder is chosen, and by E2E probes. */
  selectPath: (path: string) => Promise<void>;
  /** Pick a folder (native dialog) → add + activate it. */
  newProject: () => Promise<void>;
  /** "Don't work in a project" — clear the working folder (back to the default). */
  clearProject: () => Promise<void>;
}

/**
 * Switch the working folder: respawn pi rooted at `path` (undefined = the pi
 * default cwd) and reset the rendered thread so the new folder starts clean.
 * Best-effort — a failed restart leaves the UI's project selection intact.
 */
async function applyWorkingFolder(path: string | null): Promise<void> {
  try {
    await restartPi({ cwd: path ?? undefined });
    usePiStore.getState().setMessagesExternal([]);
  } catch {
    // Non-fatal: the file-tree root still follows the selection.
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeId: null,
  activePath: null,
  projectMissing: false,
  loaded: false,

  load: async () => {
    const res = await window.piDesktop.invoke('project:list', undefined).catch(() => null);
    if (res === null) {
      set({ loaded: true });
      return;
    }
    const active = res.projects.find((p) => p.id === res.activeId) ?? null;
    set({
      projects: res.projects,
      activeId: res.activeId,
      activePath: active?.path ?? null,
      projectMissing: res.activeMissing,
      loaded: true,
    });
  },

  selectProject: async (id) => {
    if (id === get().activeId) return;
    const res = await window.piDesktop.invoke('project:set', { id }).catch(() => null);
    if (res === null || res.project === null) return;
    set({
      projects: res.projects,
      activeId: res.project.id,
      activePath: res.project.path,
      projectMissing: res.activeMissing,
    });
    await applyWorkingFolder(res.project.path);
  },

  selectPath: async (path) => {
    const res = await window.piDesktop.invoke('project:set', { path }).catch(() => null);
    if (res === null || res.project === null) return;
    const changed = res.project.path !== get().activePath;
    set({
      projects: res.projects,
      activeId: res.project.id,
      activePath: res.project.path,
      projectMissing: res.activeMissing,
    });
    if (changed) await applyWorkingFolder(res.project.path);
  },

  newProject: async () => {
    const res = await window.piDesktop.invoke('project:new', undefined).catch(() => null);
    if (res === null) return;
    if (res.project === null) {
      // Cancelled the folder picker — still refresh the list + missing flag.
      set({ projects: res.projects, projectMissing: res.activeMissing });
      return;
    }
    const changed = res.project.path !== get().activePath;
    set({
      projects: res.projects,
      activeId: res.project.id,
      activePath: res.project.path,
      projectMissing: res.activeMissing,
    });
    if (changed) await applyWorkingFolder(res.project.path);
  },

  clearProject: async () => {
    const res = await window.piDesktop.invoke('project:clear', undefined).catch(() => null);
    const wasActive = get().activeId !== null;
    set({
      projects: res?.projects ?? get().projects,
      activeId: null,
      activePath: null,
      // No active project → never "missing" (the chip shows the sandbox default).
      projectMissing: false,
    });
    if (wasActive) await applyWorkingFolder(null);
  },
}));

// E2E hook (same `?piE2E=1` opt-in as __pi_store): lets the round-8 probe drive
// the working folder without a native folder dialog.
if (new URLSearchParams(window.location.search).has('piE2E')) {
  window.__pi_project = () => useProjectStore;
}
