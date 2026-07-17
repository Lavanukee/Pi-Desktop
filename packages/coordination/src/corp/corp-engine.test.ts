import type { CorpChatFn, CorpChatRequest, CorpChatResult } from '@pi-desktop/harness/corp';
import { describe, expect, it } from 'vitest';
import {
  type CoordinationEvent,
  type DoneEvent,
  isCoordinationEventType,
  isTerminalEvent,
  type TaskHandle,
} from '../index.js';
import { CorpEngine } from './index.js';

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

const PROMOTION = JSON.stringify({
  reason: 'This is a multi-part build.',
  divisions: [
    { name: 'Frontend', purpose: 'the UI' },
    { name: 'Backend', purpose: 'the API' },
  ],
});

const ARCHITECTURE = JSON.stringify({
  moduleMap: [
    { path: 'src/ui/', owner: 'Frontend', purpose: 'the UI' },
    { path: 'src/api/', owner: 'Backend', purpose: 'the API' },
  ],
  interfaces: [
    {
      name: 'Api',
      exposedBy: 'Backend',
      path: 'src/api/index.ts',
      summary: 'the API surface',
      consumedBy: ['Frontend'],
    },
  ],
});

function contractsFor(division: string, slot: string): string {
  return JSON.stringify([
    {
      id: `${division.toLowerCase()}-1`,
      title: `Build the ${division} core`,
      ownerNodeId: `division-${division.toLowerCase()}`,
      input: 'the architecture',
      output: 'a working module',
      slot,
      available: { tools: [], imports: [] },
      reviewRubric: 'compiles and is typed',
      dependsOn: [],
    },
  ]);
}

/** A deterministic promoting corp run: promote → architect → 1 contract per
 * division → engineers produce files → CEO approves. */
function promotingChat(): CorpChatFn {
  return (req: CorpChatRequest): CorpChatResult => {
    const text = req.messages.map((m) => m.content).join('\n');
    switch (req.purpose) {
      case 'worker':
        return { content: PROMOTION };
      case 'architect':
        return { content: ARCHITECTURE };
      case 'manager':
        return text.includes('Backend')
          ? { content: contractsFor('Backend', 'src/api/core.ts') }
          : { content: contractsFor('Frontend', 'src/ui/core.tsx') };
      case 'engineer':
        return { content: '```ts\nexport const core = () => 42;\n```' };
      case 'ceo':
      case 'revise':
        return { content: JSON.stringify({ decision: 'approve', notes: 'Looks complete.' }) };
      default:
        return { content: '' };
    }
  };
}

describe('CorpEngine implements CoordinationEngine', () => {
  it('maps a promoting run into the coordination event stream', async () => {
    const engine = new CorpEngine({ chat: promotingChat(), maxRevisions: 0 });
    const handle = engine.startTask('Build me a dashboard app');
    const events = await collect(handle);

    // Every emitted event is a valid discriminated-union member.
    for (const event of events) expect(isCoordinationEventType(event.type)).toBe(true);

    // Exactly one terminal event, last, completed.
    expect(events.filter(isTerminalEvent)).toHaveLength(1);
    expect(terminal(events).result.outcome).toBe('completed');

    // The arc surfaced planning + working status.
    expect(events.some((e) => e.type === 'status' && e.status === 'planning')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.status === 'working')).toBe(true);

    // An org-chart with the CEO + both divisions + engineer nodes appeared.
    const charts = events.filter((e) => e.type === 'org-chart');
    const richest = charts.at(-1);
    expect(richest?.type === 'org-chart').toBe(true);
    if (richest?.type === 'org-chart') {
      const roles = richest.chart.nodes.map((n) => n.role);
      expect(roles).toContain('ceo');
      expect(roles.filter((r) => r === 'division')).toHaveLength(2);
      expect(roles).toContain('engineer');
      // The architecture module map projected through.
      expect(richest.chart.modules?.length).toBeGreaterThan(0);
    }

    // A checklist driven from contract state; the TERMINAL checklist reconciles
    // every contract to done (all engineers produced files, CEO approved).
    const checklist = events.filter((e) => e.type === 'checklist').at(-1);
    expect(checklist?.type === 'checklist' && checklist.items.length).toBeGreaterThan(0);
    expect(
      checklist?.type === 'checklist' && checklist.items.every((i) => i.state === 'done'),
    ).toBe(true);

    // An honest ETA range (low <= high).
    const eta = events.filter((e) => e.type === 'eta').at(-1);
    expect(eta?.type === 'eta' && eta.eta.lowMinutes <= eta.eta.highMinutes).toBe(true);

    // getOrgChart reflects the terminal (done) state.
    const chart = engine.getOrgChart(handle);
    expect(chart.taskId).toBe(handle.taskId);
    expect(chart.nodes.every((n) => n.state === 'done')).toBe(true);
  });

  it('exposes a REAL worker transcript for an attributed node', async () => {
    const engine = new CorpEngine({ chat: promotingChat(), maxRevisions: 0 });
    const handle = engine.startTask('Build me a dashboard app');
    await collect(handle);
    const ceo = engine.getWorkerTranscript(handle, 'ceo');
    expect(ceo?.role).toBe('ceo');
    expect(ceo?.lines.length ?? 0).toBeGreaterThan(0);
    // Unknown node → undefined (the app falls back to a generated preview).
    expect(engine.getWorkerTranscript(handle, 'nope')).toBeUndefined();
  });

  it('stays solo when the worker does not promote', async () => {
    const soloChat: CorpChatFn = (req) =>
      req.purpose === 'worker'
        ? { content: 'Here is your answer directly.' }
        : { content: JSON.stringify({ decision: 'approve', notes: 'ok' }) };
    const engine = new CorpEngine({ chat: soloChat, maxRevisions: 0 });
    const handle = engine.startTask('What is 2 + 2?');
    const events = await collect(handle);

    expect(terminal(events).result.outcome).toBe('completed');
    const chart = engine.getOrgChart(handle);
    expect(chart.nodes).toHaveLength(1);
    expect(chart.nodes[0]?.role).toBe('solo');
    expect(chart.nodes[0]?.state).toBe('done');
  });

  it('startUnavailable surfaces a missing model as an honest error — never runs', async () => {
    let called = false;
    const engine = new CorpEngine({
      chat: () => {
        called = true;
        return { content: 'should never be asked' };
      },
    });
    const message =
      "The model isn't available. Download qwen3.5-4b-mtp in Settings → Models to run the production harness.";
    const handle = engine.startUnavailable('Build me a dashboard app', message);
    const events = await collect(handle);

    // The harness never ran — the injected model seam was never invoked.
    expect(called).toBe(false);
    // A clear terminal state carrying the user-meaningful error.
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true);
    const done = terminal(events);
    expect(done.result.outcome).toBe('failed');
    expect(done.result.error).toBe(message);
    // No hollow run: no planning/working status, no invented checklist of tasks.
    expect(
      events.some(
        (e) => e.type === 'status' && (e.status === 'planning' || e.status === 'working'),
      ),
    ).toBe(false);
    expect(events.some((e) => e.type === 'checklist')).toBe(false);
  });

  it('abort ends the stream with an aborted done event', async () => {
    const engine = new CorpEngine({ chat: promotingChat() });
    const handle = engine.startTask('Long running task');
    engine.abort(handle); // synchronous, before iterating — pre-empts completion
    const events = await collect(handle);

    expect(terminal(events).result.outcome).toBe('aborted');
    expect(events.filter(isTerminalEvent)).toHaveLength(1);
  });
});
