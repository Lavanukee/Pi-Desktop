import type { CoordinationEvent, EtaEvent } from '@pi-desktop/coordination';
import { describe, expect, it } from 'vitest';
import {
  buildMockCorpRunScript,
  MOCK_TASK_ID,
  mockRunDurationMs,
  startMockCorpRun,
} from './mock-run.ts';
import { contractProgress, initialSituation, reduceSituation } from './situation-model.ts';

function foldTo(atMs: number) {
  const script = buildMockCorpRunScript();
  let state = initialSituation(MOCK_TASK_ID);
  for (const entry of script) {
    if (entry.at > atMs) break;
    state = reduceSituation(state, entry.event);
  }
  return state;
}

describe('buildMockCorpRunScript', () => {
  const script = buildMockCorpRunScript();

  it('is deterministic, starts at 0, and ends with exactly one done event', () => {
    expect(script[0]?.at).toBe(0);
    expect(script.at(-1)?.event.type).toBe('done');
    expect(script.filter((e) => e.event.type === 'done')).toHaveLength(1);
    expect(mockRunDurationMs(script)).toBeGreaterThan(40_000);
    expect(mockRunDurationMs(script)).toBeLessThan(60_000);
    // Deterministic: same array both times.
    expect(buildMockCorpRunScript()).toEqual(script);
  });

  it('keeps the schedule effectively chronological (player replays in order)', () => {
    let prev = 0;
    for (const entry of script) {
      // Micro-offsets (chart/checklist follow-ups) may trail by <200ms; the
      // player preserves ORDER, so we only require near-monotonic times.
      expect(entry.at).toBeGreaterThanOrEqual(prev - 200);
      prev = Math.max(prev, entry.at);
    }
  });

  it('replays the full 3D-game corp run: promotion → 5 divisions → 48 contracts → done', () => {
    const final = foldTo(Number.POSITIVE_INFINITY);
    expect(final.status).toBe('done');
    expect(contractProgress(final)).toEqual({ done: 48, total: 48 });
    expect(final.files).toHaveLength(48);
    expect(final.chart.modules).toHaveLength(5);
    expect(final.chart.interfaces).toHaveLength(4);
    const root = final.chart.nodes.find((n) => n.parentId === undefined);
    expect(root?.role).toBe('ceo');
    expect(root?.state).toBe('done');
    expect(final.chart.nodes.filter((n) => n.role === 'division')).toHaveLength(5);
  });

  it('starts solo and promotes to CEO during planning', () => {
    const early = foldTo(1000);
    expect(early.chart.nodes).toHaveLength(1);
    expect(early.chart.nodes[0]?.role).toBe('solo');
    const promoted = foldTo(3000);
    expect(promoted.chart.nodes.find((n) => n.id === 'root')?.role).toBe('ceo');
    expect(promoted.status).toBe('planning');
  });

  it('is mid-dispatch around t=26s: some done, some in flight, files landing', () => {
    const mid = foldTo(26_000);
    expect(mid.status).toBe('working');
    const progress = contractProgress(mid);
    expect(progress.total).toBe(48);
    expect(progress.done).toBeGreaterThan(4);
    expect(progress.done).toBeLessThan(40);
    expect(mid.checklist.some((i) => i.state === 'in-progress')).toBe(true);
    expect(mid.files.length).toBeGreaterThan(4);
    expect(mid.chart.nodes.some((n) => n.role === 'engineer' && n.state === 'working')).toBe(true);
  });

  it('carries per-node currentAction and drives the live-action feed', () => {
    // Planning: the root's chart carries a live action from the very first snapshot.
    const early = foldTo(600);
    expect(early.chart.nodes[0]?.currentAction).toBe('Reading the request');
    expect(early.actionFeed[0]).toMatchObject({ area: 'Pi', done: false });

    // Mid-dispatch: working builders carry "Writing <file>" actions, and the
    // feed holds OPEN rows (spinners) plus settled ones (done checks).
    const mid = foldTo(26_000);
    const workingEngineers = mid.chart.nodes.filter(
      (n) => n.role === 'engineer' && n.state === 'working',
    );
    expect(workingEngineers.some((n) => n.currentAction?.startsWith('Writing '))).toBe(true);
    expect(mid.actionFeed.some((r) => !r.done)).toBe(true);
    expect(mid.actionFeed.some((r) => r.done)).toBe(true);
    // Rows read as "Area · action" — a builder reports under its AREA name.
    expect(mid.actionFeed.some((r) => r.area === 'Core Engine')).toBe(true);

    // Terminal: every row settles.
    const final = foldTo(Number.POSITIVE_INFINITY);
    expect(final.actionFeed.every((r) => r.done)).toBe(true);
  });

  it('narrows the ETA range monotonically as contracts complete', () => {
    const etas = script
      .map((e) => e.event)
      .filter((e): e is EtaEvent => e.type === 'eta')
      .map((e) => e.eta);
    expect(etas.length).toBeGreaterThan(5);
    for (let i = 1; i < etas.length; i += 1) {
      const prev = etas[i - 1] as (typeof etas)[number];
      const next = etas[i] as (typeof etas)[number];
      expect(next.lowMinutes).toBeLessThanOrEqual(prev.lowMinutes);
      expect(next.highMinutes).toBeLessThanOrEqual(prev.highMinutes);
      expect(next.lowMinutes).toBeLessThanOrEqual(next.highMinutes);
    }
  });

  it('drives the live-richness states: phases with deltas, and exercise sessions', () => {
    // Mid-dispatch: some files are actively being written, deltas have landed.
    const mid = foldTo(26_000);
    expect(mid.files.some((f) => f.active)).toBe(true);
    expect(mid.files.some((f) => f.added > 0)).toBe(true);

    // Three exercise sessions run over the script: browse → test → run,
    // each opening (running) and closing (terminal status).
    const sessions = script
      .map((e) => e.event)
      .filter((e) => e.type === 'exercise')
      .map((e) => (e.type === 'exercise' ? e.session : undefined))
      .filter((s) => s !== undefined);
    const byId = new Map<string, string[]>();
    for (const s of sessions) {
      byId.set(s.id, [...(byId.get(s.id) ?? []), s.status]);
    }
    expect([...byId.keys()].sort()).toEqual(['ex-browse', 'ex-play', 'ex-test']);
    for (const statuses of byId.values()) {
      expect(statuses[0]).toBe('running');
      expect(['passed', 'ended']).toContain(statuses.at(-1));
    }
    // The user-facing copy never leaks the internal org vocabulary.
    const summaries = script
      .map((e) => e.event)
      .filter((e) => e.type === 'activity')
      .map((e) => (e.type === 'activity' ? e.activity.summary : ''))
      .join(' ');
    for (const banned of [/corporation/i, /contract/i, /\bCEO\b/, /division/i, /architect/i]) {
      expect(summaries).not.toMatch(banned);
    }
  });

  it('has real cross-division dependencies in the plan', () => {
    const final = foldTo(Number.POSITIVE_INFINITY);
    const byId = new Map(final.checklist.map((i) => [i.id, i]));
    let cross = 0;
    for (const item of final.checklist) {
      for (const dep of item.dependsOn ?? []) {
        const depItem = byId.get(dep);
        if (depItem && depItem.group !== item.group) cross += 1;
      }
    }
    expect(cross).toBe(7);
  });
});

describe('startMockCorpRun', () => {
  it('fast-forwards the prefix synchronously and streams like a TaskHandle', async () => {
    // startAt beyond the script end: the whole run replays without timers.
    const handle = startMockCorpRun({ startAt: Number.MAX_SAFE_INTEGER });
    expect(handle.taskId).toBe(MOCK_TASK_ID);
    const events: CoordinationEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events.at(-1)?.type).toBe('done');
    expect(events).toHaveLength(buildMockCorpRunScript().length);
    // Activity timestamps were stamped (not the script's 0 placeholder).
    const activity = events.find((e) => e.type === 'activity');
    expect(activity?.type === 'activity' && activity.activity.timestamp > 0).toBe(true);
  });

  it('stop() ends the stream without a terminal event', async () => {
    const handle = startMockCorpRun();
    handle.stop();
    const events: CoordinationEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events.every((e) => e.type !== 'done')).toBe(true);
  });
});
