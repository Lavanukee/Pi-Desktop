/**
 * The property that matters: come back to the same project tomorrow, in a
 * different chat, and reach the SAME team. Everything else here is in service of
 * that, or of not leaving something confusing in a user's folder.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findHierarchy,
  hierarchiesRoot,
  hierarchySlug,
  listHierarchies,
  openHierarchy,
  PROJECT_POINTER,
} from './hierarchy-store';

let appData: string;
beforeEach(() => {
  appData = mkdtempSync(path.join(os.tmpdir(), 'pd-appdata-'));
});
afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
});

describe('the same project always reaches the same team', () => {
  it('re-opens the identical directory on a second call', () => {
    const first = openHierarchy(appData, '/Users/jedd/Desktop');
    const second = openHierarchy(appData, '/Users/jedd/Desktop');
    expect(second.dir).toBe(first.dir);
    expect(second.sessionsDir).toBe(first.sessionsDir);
    expect(first.existed).toBe(false);
    expect(second.existed).toBe(true); // the whole point: it was already there
  });

  it('does not care how the path was spelled', () => {
    const a = openHierarchy(appData, '/Users/jedd/Desktop');
    for (const spelling of ['/Users/jedd/Desktop/', '/Users/jedd/./Desktop', '/Users/jedd/x/../Desktop']) {
      expect(openHierarchy(appData, spelling).dir).toBe(a.dir);
    }
  });

  it('keeps two projects with the same NAME apart', () => {
    const work = openHierarchy(appData, '/Users/jedd/work/app');
    const old = openHierarchy(appData, '/Users/jedd/archive/app');
    expect(work.dir).not.toBe(old.dir);
    // ...while both stay recognisable to a human reading the folder list.
    expect(path.basename(work.dir).startsWith('app-')).toBe(true);
    expect(path.basename(old.dir).startsWith('app-')).toBe(true);
  });

  it('names the folder after the project, readably', () => {
    expect(hierarchySlug('/Users/jedd/Desktop')).toMatch(/^desktop-[0-9a-f]{8}$/);
    expect(hierarchySlug('/tmp/My Project (v2)')).toMatch(/^my-project-v2-[0-9a-f]{8}$/);
    expect(hierarchySlug('/')).toMatch(/^project-[0-9a-f]{8}$/);
  });
});

describe('a human can tell what a folder is for', () => {
  it('records the absolute project path next to the team', () => {
    const h = openHierarchy(appData, '/Users/jedd/Desktop');
    expect(readFileSync(path.join(h.dir, PROJECT_POINTER), 'utf8').trim()).toBe('/Users/jedd/Desktop');
  });

  it('lists every team the app is holding, with what each is for', () => {
    openHierarchy(appData, '/Users/jedd/Desktop');
    openHierarchy(appData, '/Users/jedd/code/thing');
    const all = listHierarchies(appData).map((h) => h.projectPath).sort();
    expect(all).toEqual(['/Users/jedd/Desktop', '/Users/jedd/code/thing']);
  });

  it('leaves NOTHING in the user’s own project directory', () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'pd-project-'));
    openHierarchy(appData, project);
    expect(existsSync(path.join(project, '.pi'))).toBe(false);
    expect(existsSync(path.join(project, '.corp'))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });
});

describe('looking one up without creating it', () => {
  it('finds nothing for a project that has never had a team', () => {
    expect(findHierarchy(appData, '/Users/jedd/never-opened')).toBeUndefined();
    expect(existsSync(hierarchiesRoot(appData))).toBe(false);
  });

  it('finds the team once one exists', () => {
    const made = openHierarchy(appData, '/Users/jedd/Desktop');
    expect(findHierarchy(appData, '/Users/jedd/Desktop')?.dir).toBe(made.dir);
  });

  it('never throws on a junk directory', () => {
    expect(() => listHierarchies('/definitely/not/here')).not.toThrow();
    expect(listHierarchies('/definitely/not/here')).toEqual([]);
  });
});
