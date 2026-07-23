import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../electron/ipc-contract';
import type { ChatOrganization } from '../../electron/settings/settings-contract';
import { AUTO_PROJECT_PREFIX, displayTitle, groupChats } from './chat-org';

const EMPTY: ChatOrganization = { projects: [], assignments: {}, pinned: [], titles: {} };
const SANDBOX = '/home/u/.pi/desktop/sandbox/conv1';

function chat(file: string, cwd: string, modifiedAt = 't', title = file): SessionSummary {
  return {
    file,
    id: file,
    cwd,
    cwdLabel: cwd.replace('/home/u', '~'),
    startedAt: 't',
    modifiedAt,
    messageCount: 1,
    firstUserText: title,
    title,
  };
}

describe('groupChats — auto folders by working directory', () => {
  it('keeps sandbox + unknown-cwd chats ungrouped, with no auto folders', () => {
    const g = groupChats([chat('a', SANDBOX), chat('b', '')], EMPTY);
    expect(g.projects).toEqual([]);
    expect(g.ungrouped.map((s) => s.file)).toEqual(['a', 'b']);
  });

  it('auto-groups a real-cwd chat into a folder named by the dir basename', () => {
    const g = groupChats([chat('a', '/home/u/work/GeometryDash')], EMPTY);
    expect(g.projects).toHaveLength(1);
    expect(g.projects[0]?.auto).toBe(true);
    expect(g.projects[0]?.project.name).toBe('GeometryDash');
    expect(g.projects[0]?.project.id).toBe(`${AUTO_PROJECT_PREFIX}/home/u/work/GeometryDash`);
    expect(g.ungrouped).toEqual([]);
  });

  it('collects chats sharing a cwd + sorts folders by most-recent activity', () => {
    const g = groupChats(
      [
        chat('a', '/home/u/work/alpha', '2026-01-01'),
        chat('b', '/home/u/work/alpha', '2026-01-03'),
        chat('c', '/home/u/work/beta', '2026-01-05'),
      ],
      EMPTY,
    );
    // beta (Jan 5) is more recent than alpha (Jan 3) → sorts first.
    expect(g.projects.map((p) => p.project.name)).toEqual(['beta', 'alpha']);
    expect(g.projects[1]?.chats.map((s) => s.file)).toEqual(['a', 'b']);
  });

  it('a manual assignment overrides the cwd folder (and manual projects come first)', () => {
    const org: ChatOrganization = {
      projects: [{ id: 'p1', name: 'My Project' }],
      assignments: { a: 'p1' },
      pinned: [],
      titles: {},
    };
    const g = groupChats([chat('a', '/home/u/work/foo'), chat('b', '/home/u/work/foo')], org);
    expect(g.projects[0]?.auto).toBe(false);
    expect(g.projects[0]?.project.name).toBe('My Project');
    expect(g.projects[0]?.chats.map((s) => s.file)).toEqual(['a']);
    // b still auto-folders under its cwd.
    expect(g.projects[1]?.auto).toBe(true);
    expect(g.projects[1]?.chats.map((s) => s.file)).toEqual(['b']);
    expect(g.ungrouped).toEqual([]);
  });

  it('floats pinned chats to the top within a folder', () => {
    const org: ChatOrganization = { ...EMPTY, pinned: ['b'] };
    const g = groupChats([chat('a', '/home/u/work/foo'), chat('b', '/home/u/work/foo')], org);
    expect(g.projects[0]?.chats.map((s) => s.file)).toEqual(['b', 'a']);
  });
});

describe('displayTitle', () => {
  it('uses the rename override when present, else the derived title', () => {
    const s = chat('a', SANDBOX, 't', 'plan a launch');
    expect(displayTitle(s, EMPTY)).toBe('plan a launch');
    expect(displayTitle(s, { ...EMPTY, titles: { a: 'Launch plan' } })).toBe('Launch plan');
  });
});
