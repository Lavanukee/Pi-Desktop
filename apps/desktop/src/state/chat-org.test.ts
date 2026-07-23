import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../electron/ipc-contract';
import type { ChatOrganization } from '../../electron/settings/settings-contract';
import { displayTitle, groupChats } from './chat-org';

const EMPTY: ChatOrganization = { projects: [], assignments: {}, pinned: [], titles: {} };

function chat(file: string, title = file): SessionSummary {
  return {
    file,
    id: file,
    cwd: '/tmp',
    cwdLabel: '~/tmp',
    startedAt: 't',
    modifiedAt: 't',
    messageCount: 1,
    firstUserText: title,
    title,
  };
}

describe('groupChats', () => {
  const a = chat('a.jsonl');
  const b = chat('b.jsonl');
  const c = chat('c.jsonl');

  it('puts everything ungrouped when there are no projects/assignments', () => {
    const g = groupChats([a, b, c], EMPTY);
    expect(g.projects).toEqual([]);
    expect(g.ungrouped.map((s) => s.file)).toEqual(['a.jsonl', 'b.jsonl', 'c.jsonl']);
  });

  it('places assigned chats under their project, leaving the rest ungrouped', () => {
    const org: ChatOrganization = {
      projects: [{ id: 'p1', name: 'Proj' }],
      assignments: { 'a.jsonl': 'p1', 'c.jsonl': 'p1' },
      pinned: [],
      titles: {},
    };
    const g = groupChats([a, b, c], org);
    expect(g.projects).toHaveLength(1);
    expect(g.projects[0]?.project.name).toBe('Proj');
    expect(g.projects[0]?.chats.map((s) => s.file)).toEqual(['a.jsonl', 'c.jsonl']);
    expect(g.ungrouped.map((s) => s.file)).toEqual(['b.jsonl']);
  });

  it('floats pinned chats to the top of their container', () => {
    const org: ChatOrganization = { ...EMPTY, pinned: ['c.jsonl'] };
    const g = groupChats([a, b, c], org);
    expect(g.ungrouped.map((s) => s.file)).toEqual(['c.jsonl', 'a.jsonl', 'b.jsonl']);
  });

  it('drops an assignment to a project that no longer exists (→ ungrouped)', () => {
    const org: ChatOrganization = { ...EMPTY, assignments: { 'a.jsonl': 'gone' } };
    const g = groupChats([a, b], org);
    expect(g.projects).toEqual([]);
    expect(g.ungrouped.map((s) => s.file)).toEqual(['a.jsonl', 'b.jsonl']);
  });

  it('keeps an empty project group so chats can still be added to it', () => {
    const org: ChatOrganization = { ...EMPTY, projects: [{ id: 'p1', name: 'Empty' }] };
    const g = groupChats([a], org);
    expect(g.projects).toHaveLength(1);
    expect(g.projects[0]?.chats).toEqual([]);
    expect(g.ungrouped.map((s) => s.file)).toEqual(['a.jsonl']);
  });
});

describe('displayTitle', () => {
  it('uses the rename override when present, else the derived title', () => {
    const s = chat('a.jsonl', 'plan a launch');
    expect(displayTitle(s, EMPTY)).toBe('plan a launch');
    expect(displayTitle(s, { ...EMPTY, titles: { 'a.jsonl': 'Launch plan' } })).toBe('Launch plan');
  });
});
