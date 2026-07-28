/**
 * WHERE A PROJECT'S TEAM LIVES, BETWEEN RUNS.
 *
 * The point of the whole design is that a project has a team and the team
 * persists: the person who wrote the audio code still knows it next week, so
 * coming back to a project means talking to the same people rather than briefing
 * strangers. That only works if every agent's conversation survives the run that
 * created it.
 *
 * It did not. A corp run was handed a fresh randomly-named directory under the OS
 * temp dir, so `team.json` and every session file were written somewhere that had
 * never existed before and would be swept away — a new team, hired and destroyed,
 * every single run. The machinery to remember was built and unit-tested; nothing
 * ever pointed it at a place that lasts.
 *
 * WHERE IT GOES, and why not in the project. The obvious home is a dot-directory
 * beside the user's work, and jedd's objection to that is the right one: months
 * later you open your Desktop and find an ominous hidden folder full of machine
 * transcripts you did not put there. So the hierarchy lives in the APP's own
 * storage, and each one records the absolute path of the project it belongs to:
 *
 *   <appData>/hierarchies/
 *     desktop-4f2a91c8/
 *       project.txt          /Users/jedd/Desktop          <- what this team is for
 *       team.json            the roster: who exists, their role, their session
 *       sessions/<agent>/    each agent's actual conversation, on disk
 *
 * The folder name is readable (the project's own name) and unique (a hash of its
 * full path), so two projects called `desktop` cannot collide. The lookup is by
 * path, so any chat working in that directory — today's, or one opened next month
 * — reaches the same hierarchy and therefore the same people.
 *
 * Node fs only. Never throws on read: a hierarchy that cannot be read is a team
 * that gets rebuilt, which is recoverable; an exception here would take the run.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** One project's persistent team. */
export interface Hierarchy {
  /** `<root>/hierarchies/<slug>` — everything about this team is under here. */
  readonly dir: string;
  /** The absolute path of the project this team works on. */
  readonly projectPath: string;
  /** The roster file (who exists, and where each one's conversation is). */
  readonly teamFile: string;
  /** Parent of the per-agent session directories. */
  readonly sessionsDir: string;
  /** True when this team already existed before this call. */
  readonly existed: boolean;
}

/** The file inside a hierarchy that names the project it belongs to. */
export const PROJECT_POINTER = 'project.txt';

/** Normalise a project path so the same directory always maps to the same team,
 * whatever spelling reached us — a trailing slash, `.`, a relative path. */
function canonical(projectPath: string): string {
  return path.resolve(projectPath).replace(/\/+$/, '');
}

/**
 * The directory name for a project: its own name, so a human can recognise it,
 * plus a short hash of the full path, so `~/work/app` and `~/old/app` are two
 * different teams rather than one confused one.
 */
export function hierarchySlug(projectPath: string): string {
  const abs = canonical(projectPath);
  const name =
    path
      .basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

/** The root under which all hierarchies live. */
export function hierarchiesRoot(appDataDir: string): string {
  return path.join(appDataDir, 'hierarchies');
}

/**
 * Open (or create) the team for a project. Idempotent: calling it again for the
 * same directory returns the same place, which is the entire point.
 */
export function openHierarchy(appDataDir: string, projectPath: string): Hierarchy {
  const abs = canonical(projectPath);
  const dir = path.join(hierarchiesRoot(appDataDir), hierarchySlug(abs));
  const existed = existsSync(path.join(dir, PROJECT_POINTER));
  mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  try {
    // Rewritten every time so it stays true if a project is moved and re-opened
    // under the same name — and so a human can always tell what a folder is for.
    writeFileSync(path.join(dir, PROJECT_POINTER), `${abs}\n`);
  } catch {
    // a pointer we cannot write is cosmetic; the team still works
  }
  return {
    dir,
    projectPath: abs,
    teamFile: path.join(dir, 'team.json'),
    sessionsDir: path.join(dir, 'sessions'),
    existed,
  };
}

/** Every team this app knows about, for showing the user what exists. Never throws. */
export function listHierarchies(appDataDir: string): Array<{ slug: string; projectPath: string }> {
  const root = hierarchiesRoot(appDataDir);
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ slug: string; projectPath: string }> = [];
  for (const slug of entries) {
    try {
      const projectPath = readFileSync(path.join(root, slug, PROJECT_POINTER), 'utf8').trim();
      if (projectPath !== '') out.push({ slug, projectPath });
    } catch {
      // not a hierarchy, or unreadable — skip it
    }
  }
  return out;
}

/** The team for a project, if one has ever been created. Read-only: creates nothing. */
export function findHierarchy(appDataDir: string, projectPath: string): Hierarchy | undefined {
  const abs = canonical(projectPath);
  const dir = path.join(hierarchiesRoot(appDataDir), hierarchySlug(abs));
  if (!existsSync(path.join(dir, PROJECT_POINTER))) return undefined;
  return {
    dir,
    projectPath: abs,
    teamFile: path.join(dir, 'team.json'),
    sessionsDir: path.join(dir, 'sessions'),
    existed: true,
  };
}
