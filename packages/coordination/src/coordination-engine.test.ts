import { describe, expect, it } from 'vitest';
import {
  COORDINATION_EVENT_TYPES,
  type CoordinationEngine,
  type CoordinationEvent,
  type DoneEvent,
  isCoordinationEventType,
  isTerminalEvent,
  type TaskHandle,
} from './index.js';
import { SoloEngine } from './solo/index.js';

/** Drain a handle's event stream to completion (each run ends in `done`). */
async function collect(handle: TaskHandle): Promise<CoordinationEvent[]> {
  const events: CoordinationEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function terminal(events: CoordinationEvent[]): DoneEvent {
  const last = events.at(-1);
  if (last?.type !== 'done') throw new Error('stream did not end with a done event');
  return last;
}

describe('CoordinationEvent DTOs', () => {
  it('lists exactly the spec §1 event types, in order', () => {
    expect([...COORDINATION_EVENT_TYPES]).toEqual([
      'status',
      'org-chart',
      'activity',
      'artifact',
      'checklist',
      'eta',
      'permission',
      'done',
    ]);
  });

  it('isCoordinationEventType narrows known discriminants', () => {
    for (const type of COORDINATION_EVENT_TYPES) expect(isCoordinationEventType(type)).toBe(true);
    expect(isCoordinationEventType('nope')).toBe(false);
    expect(isCoordinationEventType(42)).toBe(false);
    expect(isCoordinationEventType(undefined)).toBe(false);
  });

  it('isTerminalEvent detects the done event only', () => {
    const done: CoordinationEvent = { type: 'done', result: { outcome: 'completed' } };
    const status: CoordinationEvent = { type: 'status', status: 'working' };
    expect(isTerminalEvent(done)).toBe(true);
    expect(isTerminalEvent(status)).toBe(false);
  });
});

describe('SoloEngine implements CoordinationEngine', () => {
  it('satisfies the interface shape', () => {
    // Compile-time proof the skeleton is a full implementation, plus a runtime
    // check that every method is present.
    const engine: CoordinationEngine = new SoloEngine();
    expect(typeof engine.startTask).toBe('function');
    expect(typeof engine.steer).toBe('function');
    expect(typeof engine.abort).toBe('function');
    expect(typeof engine.getOrgChart).toBe('function');
    expect(typeof engine.respondToPermission).toBe('function');
  });

  it('returns a handle synchronously with a taskId and an event stream', () => {
    const engine = new SoloEngine();
    const handle = engine.startTask('Build me a dashboard');
    expect(typeof handle.taskId).toBe('string');
    expect(handle.taskId.length).toBeGreaterThan(0);
    expect(typeof handle.events[Symbol.asyncIterator]).toBe('function');
  });

  it('drives a normal run to a completed done event', async () => {
    const engine = new SoloEngine();
    const handle = engine.startTask('Fix a typo on the login button', {
      effort: 'low',
      ceoMode: 'ask',
    });
    const events = await collect(handle);

    // Every emitted event is a valid discriminated-union member.
    for (const event of events) expect(isCoordinationEventType(event.type)).toBe(true);

    // Exactly one terminal event, and it is last.
    expect(events.filter(isTerminalEvent)).toHaveLength(1);
    expect(terminal(events).result.outcome).toBe('completed');

    // The representative arc surfaced status, an honest ETA range, and a checklist.
    expect(events.some((e) => e.type === 'status' && e.status === 'working')).toBe(true);
    const eta = events.find((e) => e.type === 'eta');
    expect(eta?.type === 'eta' && eta.eta.lowMinutes <= eta.eta.highMinutes).toBe(true);
    expect(events.some((e) => e.type === 'checklist')).toBe(true);

    // getOrgChart reflects the terminal state.
    const chart = engine.getOrgChart(handle);
    expect(chart.taskId).toBe(handle.taskId);
    expect(chart.nodes).toHaveLength(1);
    expect(chart.nodes[0]?.role).toBe('solo');
    expect(chart.nodes[0]?.state).toBe('done');
  });

  it('abort ends the stream with an aborted done event', async () => {
    const engine = new SoloEngine();
    const handle = engine.startTask('Long running task');
    engine.abort(handle); // synchronous, before iterating — must pre-empt completion
    const events = await collect(handle);

    expect(terminal(events).result.outcome).toBe('aborted');
    expect(events.filter(isTerminalEvent)).toHaveLength(1);
    expect(engine.getOrgChart(handle).nodes[0]?.state).toBe('retired');
  });

  it('steer and respondToPermission emit activity without throwing', async () => {
    const engine = new SoloEngine();
    const handle = engine.startTask('Add a settings panel');
    engine.steer(handle, 'make the toggles bigger');
    engine.respondToPermission(handle, 'perm-1', true);
    const events = await collect(handle);

    const activities = events.filter((e) => e.type === 'activity');
    expect(
      activities.some((e) => e.type === 'activity' && e.activity.summary.includes('steer')),
    ).toBe(true);
    expect(
      activities.some((e) => e.type === 'activity' && e.activity.summary.includes('perm-1')),
    ).toBe(true);
    // The run still terminates cleanly.
    expect(terminal(events).result.outcome).toBe('completed');
  });

  it('getOrgChart returns an empty-node solo view for an unknown handle', () => {
    const engine = new SoloEngine();
    const chart = engine.getOrgChart({ taskId: 'never-started', events: emptyStream() });
    expect(chart.nodes[0]?.state).toBe('idle');
  });
});

/** A trivially-closed stream, for the unknown-handle probe above. */
function emptyStream(): AsyncIterable<CoordinationEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<CoordinationEvent> {
      return { next: () => Promise.resolve({ value: undefined, done: true }) };
    },
  };
}
