import { describe, expect, it } from 'vitest';
import { mockWorkerStreamFor } from './worker-streams.ts';

describe('mockWorkerStreamFor', () => {
  it('is deterministic and covers every role', () => {
    const roles = [
      'solo',
      'ceo',
      'manager',
      'division',
      'division-head',
      'engineer',
      'specialist',
    ] as const;
    for (const role of roles) {
      const node = { id: `n-${role}`, name: 'Game Logic builder 1', role };
      const a = mockWorkerStreamFor(node);
      const b = mockWorkerStreamFor(node);
      expect(a).toEqual(b);
      expect(a.briefing.title.length).toBeGreaterThan(0);
      expect(a.briefing.deliverables.length).toBeGreaterThan(0);
      expect(a.entries.length).toBeGreaterThan(3);
      // Entries replay in order.
      let prev = 0;
      for (const entry of a.entries) {
        expect(entry.at).toBeGreaterThanOrEqual(prev);
        prev = entry.at;
      }
    }
  });

  it('grounds a builder stream in its area material', () => {
    const stream = mockWorkerStreamFor({
      id: 'div-game-e1',
      name: 'Game Logic builder 1',
      role: 'engineer',
    });
    expect(stream.briefing.roleLine).toContain('Game Logic');
    expect(stream.briefing.area).toBe('src/game/');
    // The task briefing never leaks internal org vocabulary.
    const text = `${stream.briefing.title} ${stream.briefing.goal} ${stream.briefing.roleLine}`;
    for (const banned of [
      /corporation/i,
      /contract/i,
      /\bCEO\b/,
      /division/i,
      /architect/i,
      /manager/i,
    ]) {
      expect(text).not.toMatch(banned);
    }
  });
});
