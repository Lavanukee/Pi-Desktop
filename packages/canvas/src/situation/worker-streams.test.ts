import { describe, expect, it } from 'vitest';
import {
  mockWorkerStreamEndMs,
  mockWorkerStreamFor,
  mockWorkerTranscriptAt,
} from './worker-streams.ts';

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

  it('synthesizes a LIVE transcript: text grows, streams flag, action + context read', () => {
    const node = { id: 'div-game-e1', name: 'Game Logic builder 1', role: 'engineer' } as const;
    // Deterministic: same node + elapsed → same view.
    expect(mockWorkerTranscriptAt(node, 900)).toEqual(mockWorkerTranscriptAt(node, 900));

    // Mid-first-message: the tail is a streaming message whose text GROWS.
    const early = mockWorkerTranscriptAt(node, 700);
    const later = mockWorkerTranscriptAt(node, 1100);
    const earlyTail = early.lines[early.lines.length - 1];
    const laterTail = later.lines[later.lines.length - 1];
    expect(earlyTail?.kind).toBe('message');
    expect(earlyTail?.streaming).toBe(true);
    expect(early.streaming).toBe(true);
    expect(laterTail?.text.length ?? 0).toBeGreaterThan(earlyTail?.text.length ?? 0);
    expect(early.currentAction).toBe('Responding');

    // Mid-thinking: a streaming reasoning line + the "thinking" action.
    const thinking = mockWorkerTranscriptAt(node, 3400);
    expect(thinking.lines.some((l) => l.kind === 'thinking' && l.streaming === true)).toBe(true);
    expect(thinking.currentAction).toBe('thinking');

    // The context reading fills as the run works.
    expect(mockWorkerTranscriptAt(node, 8000).contextPercent ?? 0).toBeGreaterThan(
      mockWorkerTranscriptAt(node, 1000).contextPercent ?? 0,
    );

    // Fully played: nothing streams, no current action — an honest settled log.
    const end = mockWorkerTranscriptAt(node, mockWorkerStreamEndMs(node) + 2000);
    expect(end.streaming).toBeUndefined();
    expect(end.currentAction).toBeUndefined();
    expect(end.lines.length).toBe(mockWorkerStreamFor(node).entries.length);
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
