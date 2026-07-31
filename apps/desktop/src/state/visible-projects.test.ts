/**
 * The picker may offer exactly what the sidebar lists — nothing more.
 *
 * jedd, after a day of probe runs, opened the composer's project dropdown and
 * found eight throwaway `unify-*` directories, not one of which was in his
 * sidebar: "nothing should be in this dropdown if it isn't in the left sidebar."
 * The two were reading different sources — the sidebar derived folders from real
 * chats, while the picker listed every working directory the app had ever been
 * pointed at. This pins the single derivation both now share.
 */
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../electron/ipc-contract';
import { activeVisibleProjectId, autoProjectPath, visibleProjectsOf } from './visible-projects';

const chat = (file: string, cwd: string): SessionSummary =>
  ({ file, cwd, cwdLabel: cwd, modifiedAt: '2026-07-29T00:00:00Z' }) as SessionSummary;

const org = (over: Partial<Parameters<typeof visibleProjectsOf>[1]> = {}) =>
  ({ projects: [], assignments: {}, pinned: [], titles: {}, ...over }) as Parameters<
    typeof visibleProjectsOf
  >[1];

describe('what a user may pick', () => {
  it('lists a folder only when a chat actually lives in it', () => {
    const got = visibleProjectsOf([chat('a.jsonl', '/Users/j/Desktop')], org());
    expect(got.map((p) => p.name)).toEqual(['Desktop']);
  });

  it('does NOT invent a project for a directory with no chats', () => {
    // The exact clutter: eight probe-run folders that were registered as working
    // directories and never held a chat in this profile.
    expect(visibleProjectsOf([], org())).toEqual([]);
  });

  it('lists a project the user made, even before it has chats', () => {
    const got = visibleProjectsOf([], org({ projects: [{ id: 'p1', name: 'Movie' }] }));
    expect(got.map((p) => p.name)).toEqual(['Movie']);
    expect(got[0]?.auto).toBe(false);
  });

  it('marks a directory-derived folder as auto, so it is selected by PATH', () => {
    const got = visibleProjectsOf([chat('a.jsonl', '/Users/j/code/thing')], org());
    expect(got[0]?.auto).toBe(true);
    expect(got[0]?.id).toContain('/Users/j/code/thing');
  });

  it('puts the user’s own projects first, as the sidebar does', () => {
    const got = visibleProjectsOf(
      [chat('a.jsonl', '/Users/j/Desktop')],
      org({ projects: [{ id: 'p1', name: 'Movie' }] }),
    );
    expect(got.map((p) => p.name)).toEqual(['Movie', 'Desktop']);
  });
});

/**
 * jedd: "project selection just doesn't actually select the project when I click
 * it." It did select — the working folder changed underneath — but the chip asked
 * the ELECTRON project store which project was active, and that store answers with
 * a path hash (`p_1a2b`) while every row in the menu is a sidebar id (`cwd:<path>`
 * or a chatOrg id). Nothing could match, so no row was checked and the chip still
 * read "No project": indistinguishable from a click that did nothing.
 */
describe('which project reads as selected', () => {
  const desktop = visibleProjectsOf([chat('a.jsonl', '/Users/j/Desktop')], org());

  it('checks the folder the user just picked', () => {
    expect(activeVisibleProjectId(desktop, { workingPath: '/Users/j/Desktop' })).toBe(
      desktop[0]?.id,
    );
  });

  it('never asks the electron store for the answer — its ids are not in the list', () => {
    // The exact mismatch: `project:set` hands back `p_<hash>` for this same folder.
    expect(desktop.some((p) => p.id === 'p_1a2b')).toBe(false);
    expect(activeVisibleProjectId(desktop, { workingPath: '/Users/j/Desktop' })).not.toBeNull();
  });

  it('matches a folder however the path is spelled', () => {
    expect(activeVisibleProjectId(desktop, { workingPath: '/Users/j/Desktop/' })).toBe(
      desktop[0]?.id,
    );
  });

  it('keeps the chat’s own project ahead of the working folder', () => {
    const visible = visibleProjectsOf(
      [chat('a.jsonl', '/Users/j/Desktop')],
      org({ projects: [{ id: 'p1', name: 'Movie' }] }),
    );
    expect(
      activeVisibleProjectId(visible, { orgProjectId: 'p1', workingPath: '/Users/j/Desktop' }),
    ).toBe('p1');
  });

  it('selects nothing in a sandbox, and nothing for an unlisted folder', () => {
    expect(activeVisibleProjectId(desktop, { workingPath: null })).toBeNull();
    expect(activeVisibleProjectId(desktop, { workingPath: '/Users/j/elsewhere' })).toBeNull();
  });

  it('never matches a user-made project by path — those are chosen by id', () => {
    const visible = visibleProjectsOf([], org({ projects: [{ id: 'p1', name: 'Movie' }] }));
    expect(visible.map(autoProjectPath)).toEqual([null]);
  });
});
