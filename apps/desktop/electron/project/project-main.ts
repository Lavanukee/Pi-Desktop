/**
 * Main-process project (working-folder) handlers. Owns
 * `~/.pi/desktop/projects.json` — the list of working folders + which one is
 * active. The active project scopes the renderer's pi session cwd + canvas
 * file-tree root; this module only persists the list and runs the native
 * folder picker for "New project". Trusted-sender gated like the other channels.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger, type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import { dialog, type IpcMain } from 'electron';
import type { ProjectEntry, ProjectInvokeMap } from './project-contract';

const log = createLogger('desktop:project');

const HOME = os.homedir();
const PROJECTS_PATH = path.join(HOME, '.pi', 'desktop', 'projects.json');

interface ProjectsDoc {
  version: 1;
  projects: ProjectEntry[];
  activeId: string | null;
}

/** Stable, filesystem-independent id for a folder path (short base36 hash). */
function pathId(abs: string): string {
  let hash = 5381;
  for (let i = 0; i < abs.length; i++) hash = (hash * 33) ^ abs.charCodeAt(i);
  return `p_${(hash >>> 0).toString(36)}`;
}

function projectFor(abs: string): ProjectEntry {
  const clean = abs.replace(/\/+$/, '') || '/';
  return { id: pathId(clean), name: path.basename(clean) || clean, path: clean };
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * True when `project` is set but its working folder no longer exists on disk (or
 * is not a directory). The renderer surfaces this as a "using sandbox" warn on
 * the folder chip: a missing project path makes pi root the conversation at its
 * sandbox rather than HOME (electron/sandbox.ts resolveSessionCwd). `null` (no
 * active project) is never "missing".
 */
function pathMissing(project: ProjectEntry | null): boolean {
  if (project === null) return false;
  try {
    return !fs.statSync(project.path).isDirectory();
  } catch {
    return true; // gone / unreadable → treat as missing
  }
}

/**
 * True when the conversation is (or would be) rooted at the per-conversation
 * SANDBOX rather than a real project — i.e. there is no valid active project:
 * none selected, or the selected one's folder is gone. The composer folder chip
 * reads this to show "Sandbox"/"No project" (blind-test round-2 #2). Distinct
 * from `pathMissing`, which is specifically the "selected but dead" warn.
 */
function usingSandbox(active: ProjectEntry | null): boolean {
  return active === null || pathMissing(active);
}

function readDoc(): ProjectsDoc {
  const raw = safeRead(PROJECTS_PATH);
  if (raw === null) return { version: 1, projects: [], activeId: null };
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectsDoc>;
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.filter(
          (p): p is ProjectEntry =>
            typeof p?.id === 'string' && typeof p?.name === 'string' && typeof p?.path === 'string',
        )
      : [];
    const activeId =
      typeof parsed.activeId === 'string' && projects.some((p) => p.id === parsed.activeId)
        ? parsed.activeId
        : null;
    return { version: 1, projects, activeId };
  } catch {
    return { version: 1, projects: [], activeId: null };
  }
}

function writeDoc(doc: ProjectsDoc): void {
  try {
    fs.mkdirSync(path.dirname(PROJECTS_PATH), { recursive: true });
    fs.writeFileSync(PROJECTS_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  } catch (error) {
    log.warn('projects write failed', { error: String(error) });
  }
}

/** Add (or reuse) a project for `abs`, persist it as active, and return the doc. */
function activatePath(abs: string): ProjectsDoc {
  const entry = projectFor(abs);
  const doc = readDoc();
  const projects = doc.projects.some((p) => p.id === entry.id)
    ? doc.projects
    : [entry, ...doc.projects];
  const next: ProjectsDoc = { version: 1, projects, activeId: entry.id };
  writeDoc(next);
  return next;
}

const handlers: IpcHandlers<ProjectInvokeMap> = {
  'project:list': () => {
    // STALE-CLEAR (round-2 #3): on load, an active project whose folder no longer
    // exists is cleared to none so the dead name is never surfaced anywhere; the
    // conversation then defaults to the sandbox and the files panel to "No project
    // selected". Persist the clear so it sticks across restarts.
    let doc = readDoc();
    const current = doc.projects.find((p) => p.id === doc.activeId) ?? null;
    if (current !== null && pathMissing(current)) {
      doc = { ...doc, activeId: null };
      writeDoc(doc);
    }
    const active = doc.projects.find((p) => p.id === doc.activeId) ?? null;
    return {
      projects: doc.projects,
      activeId: doc.activeId,
      activeMissing: pathMissing(active),
      usingSandbox: usingSandbox(active),
    };
  },

  'project:set': (req) => {
    const doc = readDoc();
    // By explicit path (adds it if new); else by an existing id.
    if (typeof req.path === 'string' && req.path.length > 0) {
      const next = activatePath(req.path);
      const project = next.projects.find((p) => p.id === next.activeId) ?? null;
      return {
        project,
        projects: next.projects,
        activeMissing: pathMissing(project),
        usingSandbox: usingSandbox(project),
      };
    }
    const project = doc.projects.find((p) => p.id === req.id) ?? null;
    const next: ProjectsDoc = { ...doc, activeId: project?.id ?? doc.activeId };
    writeDoc(next);
    return {
      project,
      projects: next.projects,
      activeMissing: pathMissing(project),
      usingSandbox: usingSandbox(project),
    };
  },

  'project:new': async (req) => {
    let target = typeof req?.path === 'string' && req.path.length > 0 ? req.path : null;
    if (target === null) {
      const picked = await dialog.showOpenDialog({
        title: 'Choose a project folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        const doc = readDoc();
        const active = doc.projects.find((p) => p.id === doc.activeId) ?? null;
        return {
          project: null,
          projects: doc.projects,
          activeMissing: pathMissing(active),
          usingSandbox: usingSandbox(active),
        };
      }
      target = picked.filePaths[0] ?? null;
    }
    if (target === null) {
      const doc = readDoc();
      const active = doc.projects.find((p) => p.id === doc.activeId) ?? null;
      return {
        project: null,
        projects: doc.projects,
        activeMissing: pathMissing(active),
        usingSandbox: usingSandbox(active),
      };
    }
    const next = activatePath(target);
    const project = next.projects.find((p) => p.id === next.activeId) ?? null;
    log.info('project added', { path: project?.path });
    return {
      project,
      projects: next.projects,
      activeMissing: pathMissing(project),
      usingSandbox: usingSandbox(project),
    };
  },

  'project:clear': () => {
    const doc = readDoc();
    const next: ProjectsDoc = { ...doc, activeId: null };
    writeDoc(next);
    // No active project → always the sandbox.
    return { projects: next.projects, usingSandbox: true };
  },
};

export function registerProjectIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<ProjectInvokeMap>(ipcMain, handlers, { allowSender });
}
