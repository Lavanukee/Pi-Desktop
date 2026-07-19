import type {
  CorpChatFn,
  CorpChatRequest,
  CorpChatResult,
  RoleAgentRunInput,
  RoleAgentRunOutput,
  RunRoleAgentFn,
} from '@pi-desktop/harness/corp';
import { slotPath } from '@pi-desktop/harness/corp';
import { describe, expect, it } from 'vitest';
import {
  type CoordinationEvent,
  type DoneEvent,
  isCoordinationEventType,
  isTerminalEvent,
  type TaskHandle,
} from '../index.js';
import { CorpEngine, type CorpWorkspace, createMemoryWorkspace } from './index.js';

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
      // Both areas appear under the CEO. An area is role `division` once it has its
      // builders; an area still awaiting contracts shows as its `manager` (D2 — a
      // planning lead, never a bare division name). Either way both areas are nodes,
      // and at least one has become a division with engineers.
      expect(roles.filter((r) => r === 'division' || r === 'manager')).toHaveLength(2);
      expect(roles).toContain('division');
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

  it('preserves the CEO vision history across promotion + speaks the plan (#3 / A2)', async () => {
    const engine = new CorpEngine({ chat: promotingChat(), maxRevisions: 0 });
    const handle = engine.startTask('Build me a dashboard app');
    await collect(handle);
    const ceo = engine.getWorkerTranscript(handle, 'ceo');
    // The pre-promotion vision/worker notes streamed under `solo`; on promotion they
    // are migrated onto `ceo` so the chat is not "deleted" down to a bare progress bar.
    expect(ceo?.lines.some((l) => /Forming the vision|Reading the request/.test(l.text))).toBe(
      true,
    );
    // A2 — after delegating, the CEO SPEAKS its plan to the user.
    expect(ceo?.lines.some((l) => l.text.includes("Here's my plan"))).toBe(true);
    // The solo node no longer surfaces its own transcript (it was migrated, not orphaned).
    expect(engine.getWorkerTranscript(handle, 'solo')).toBeUndefined();
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

/**
 * A promoting corp run driven through the ROLE-AGENT seam (the desktop/agent
 * path — where the chat seam is never called). Engineers "write" their slot into a
 * shared workspace store and stream LIVE activity via `onActivity`. Deterministic —
 * no model, no network.
 */
function promotingRoleAgent(workspace: CorpWorkspace): RunRoleAgentFn {
  const root = workspace.workspace;
  const knownSlots = ['src/api/core.ts', 'src/ui/core.tsx'];
  return (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
    const emit = input.onActivity;
    const stop = (partial: Partial<RoleAgentRunOutput>): RoleAgentRunOutput => ({
      filesWritten: [],
      finalText: '',
      toolCalls: [],
      terminatedReason: 'stop',
      ...partial,
    });
    switch (input.purpose) {
      case 'vision':
        return Promise.resolve(
          stop({ finalText: 'Build a small dashboard with a UI and an API.' }),
        );
      case 'worker':
        emit?.({ kind: 'turn-start', turnIndex: 0 });
        return Promise.resolve(stop({ finalText: PROMOTION }));
      case 'architect':
        return Promise.resolve(stop({ finalText: ARCHITECTURE }));
      case 'manager':
        return Promise.resolve(
          stop({
            finalText: input.userPrompt.includes('Backend')
              ? contractsFor('Backend', 'src/api/core.ts')
              : contractsFor('Frontend', 'src/ui/core.tsx'),
          }),
        );
      case 'engineer': {
        // The slot this engineer builds (its prompt names it); write a valid,
        // balanced file to the SHARED store FIRST so a peek triggered by the live
        // file-touch already sees it, then stream the mid-work write.
        const slot = knownSlots.find((s) => input.userPrompt.includes(s)) ?? 'src/ui/core.tsx';
        const content = 'export const core = () => 42;\n';
        const bytes = new TextEncoder().encode(content).length;
        workspace.fs.writeFile(slotPath(root, slot), content);
        emit?.({ kind: 'turn-start', turnIndex: 0 });
        emit?.({ kind: 'file-write', toolName: 'write', path: slot, bytes, linesAdded: 1 });
        return Promise.resolve(
          stop({ finalText: 'wrote it', filesWritten: [{ path: slot, bytes }] }),
        );
      }
      case 'review':
        // A measured, no-findings review (submit_findings with an empty list) — no
        // blocking finding, so no bounded revision loop.
        return Promise.resolve(
          stop({ toolCalls: [{ name: 'submit_findings', arguments: { findings: [] } }] }),
        );
      case 'ceo':
      case 'revise':
        return Promise.resolve(
          stop({ finalText: JSON.stringify({ decision: 'approve', notes: 'Looks complete.' }) }),
        );
      default:
        return Promise.resolve(stop({}));
    }
  };
}

describe('CorpEngine — agent-path LIVE activity + peek (spec §11)', () => {
  it('streams a mid-work file-touch + artifact, grows the chart, and peeks the real product', async () => {
    const workspace = createMemoryWorkspace('/corp-peek');
    const engine = new CorpEngine({
      chat: () => {
        throw new Error('chat must not be called on the agent path');
      },
      runRoleAgent: promotingRoleAgent(workspace),
      workspaceFor: () => workspace,
      limit: 1, // one engineer is enough to prove the live path
      maxRevisions: 0,
    });
    const handle = engine.startTask('Build me a dashboard app');

    // Drain; the first live file-touch (phase 'progress') fires WHILE the contract
    // is still in-progress — capture a peek AT that moment (real, non-empty).
    const events: CoordinationEvent[] = [];
    let midRunPeekFiles = 0;
    let sawProgressBeforeDone = false;
    for await (const event of handle.events) {
      if (
        event.type === 'activity' &&
        event.activity.kind === 'file-touch' &&
        event.activity.phase === 'progress'
      ) {
        sawProgressBeforeDone = true;
        midRunPeekFiles = engine.peek(handle)?.files.length ?? 0;
      }
      events.push(event);
    }

    expect(terminal(events).result.outcome).toBe('completed');

    // A LIVE, mid-work file-touch arrived before the terminal done (not only at
    // contract end), attributed to an engineer node, lighting the file map.
    const progress = events.filter(
      (e): e is Extract<CoordinationEvent, { type: 'activity' }> =>
        e.type === 'activity' &&
        e.activity.kind === 'file-touch' &&
        e.activity.phase === 'progress',
    );
    expect(sawProgressBeforeDone).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]?.activity.path).toBeDefined();
    expect(progress[0]?.activity.nodeId?.startsWith('eng-')).toBe(true);

    // An artifact surfaced (the peek affordance enables) pointing at the file.
    const artifacts = events.filter((e) => e.type === 'artifact');
    expect(artifacts.length).toBeGreaterThan(0);

    // The chart grew from role-agent turns (chat never ran): CEO + divisions +
    // an engineer node — and multiple org-chart pulses landed during the run.
    const charts = events.filter((e) => e.type === 'org-chart');
    expect(charts.length).toBeGreaterThan(1);
    const richest = charts.at(-1);
    if (richest?.type === 'org-chart') {
      const roles = richest.chart.nodes.map((n) => n.role);
      expect(roles).toContain('ceo');
      expect(roles).toContain('engineer');
    }

    // A peek taken DURING the run returned the REAL in-progress product (non-empty).
    expect(midRunPeekFiles).toBeGreaterThan(0);

    // And a peek after the run reflects the written slot (real content, not a stub).
    const peek = engine.peek(handle);
    expect(peek?.files.length).toBeGreaterThan(0);
    expect(peek?.files.some((f) => f.content.includes('export const core'))).toBe(true);
    expect(peek?.totalBytes).toBeGreaterThan(0);
  });

  it('peek returns null for an unknown task', () => {
    const engine = new CorpEngine({ chat: promotingChat() });
    expect(engine.peek({ taskId: 'nope', events: (async function* () {})() })).toBeNull();
  });
});

/**
 * The agent path with LIVE tool activity: each engineer streams a read → bash →
 * write sequence via `onActivity`, so the situation room can (bug 1) tick "X of N"
 * up as each contract completes, (bug 2) light ONLY the running node, and (bug 3)
 * expose the running node's real tool calls through getWorkerTranscript.
 */
function liveRoleAgent(workspace: CorpWorkspace): RunRoleAgentFn {
  const root = workspace.workspace;
  const knownSlots = ['src/api/core.ts', 'src/ui/core.tsx'];
  return (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
    const emit = input.onActivity;
    const stop = (partial: Partial<RoleAgentRunOutput>): RoleAgentRunOutput => ({
      filesWritten: [],
      finalText: '',
      toolCalls: [],
      terminatedReason: 'stop',
      ...partial,
    });
    switch (input.purpose) {
      case 'vision':
        return Promise.resolve(stop({ finalText: 'Build a small dashboard.' }));
      case 'worker':
        return Promise.resolve(stop({ finalText: PROMOTION }));
      case 'architect':
        return Promise.resolve(stop({ finalText: ARCHITECTURE }));
      case 'manager':
        // Key off the unambiguous "Division: X" marker — the shared architecture
        // also names Backend (interface exposedBy), so a bare `includes('Backend')`
        // would misfire on the Frontend manager's prompt and dedup to one contract.
        return Promise.resolve(
          stop({
            finalText: input.userPrompt.includes('Division: Backend')
              ? contractsFor('Backend', 'src/api/core.ts')
              : contractsFor('Frontend', 'src/ui/core.tsx'),
          }),
        );
      case 'engineer': {
        const slot = knownSlots.find((s) => input.userPrompt.includes(s)) ?? 'src/ui/core.tsx';
        const content = 'export const core = () => 42;\n';
        const bytes = new TextEncoder().encode(content).length;
        // Stream a real read → bash → write tool sequence, THEN write the slot.
        // The turn boundary carries the session's live context reading (0..100).
        emit?.({ kind: 'turn-start', turnIndex: 0, contextPercent: 37 });
        emit?.({ kind: 'tool', toolName: 'read' });
        emit?.({ kind: 'tool', toolName: 'bash' });
        workspace.fs.writeFile(slotPath(root, slot), content);
        emit?.({ kind: 'file-write', toolName: 'write', path: slot, bytes, linesAdded: 1 });
        return Promise.resolve(
          stop({ finalText: 'wrote it', filesWritten: [{ path: slot, bytes }] }),
        );
      }
      case 'review':
        return Promise.resolve(
          stop({ toolCalls: [{ name: 'submit_findings', arguments: { findings: [] } }] }),
        );
      case 'ceo':
      case 'revise':
        return Promise.resolve(
          stop({ finalText: JSON.stringify({ decision: 'approve', notes: 'Looks complete.' }) }),
        );
      default:
        return Promise.resolve(stop({}));
    }
  };
}

describe('CorpEngine — live progress, node status, and transcript (bugs 1–3)', () => {
  it('ticks progress up, lights only the running node, and exposes live tool calls', async () => {
    const workspace = createMemoryWorkspace('/corp-live');
    const engine = new CorpEngine({
      chat: () => {
        throw new Error('chat must not be called on the agent path');
      },
      runRoleAgent: liveRoleAgent(workspace),
      workspaceFor: () => workspace,
      maxRevisions: 0,
    });
    const handle = engine.startTask('Build me a dashboard app');

    // Captured at the FIRST engineer's mid-work file-touch (order-agnostic).
    // Transcript lines only ever GROW, so reading them here is race-free even though
    // the synchronous mock advances the node's status forward immediately after.
    let runningNodeId: string | undefined;
    let liveToolLines = 0;
    const events: CoordinationEvent[] = [];
    for await (const event of handle.events) {
      if (
        event.type === 'activity' &&
        event.activity.kind === 'file-touch' &&
        event.activity.phase === 'progress' &&
        event.activity.nodeId?.startsWith('eng-') &&
        runningNodeId === undefined
      ) {
        runningNodeId = event.activity.nodeId;
        // Bug 3: the running node's transcript already carries its real tool calls.
        const transcript = engine.getWorkerTranscript(handle, runningNodeId);
        liveToolLines = (transcript?.lines ?? []).filter((l) => l.kind === 'tool-call').length;
      }
      events.push(event);
    }

    expect(terminal(events).result.outcome).toBe('completed');

    // Bug 2: from the EMITTED org-chart snapshots (immutable — not read-forward),
    // (a) some snapshot lit exactly one engineer while >=1 sibling stayed dim, and
    // (b) no snapshot ever lit two engineers at once (sequential dispatch → exactly
    // the one running node is 'working', never a queued one).
    const engineerWorkCounts = events
      .filter((e): e is Extract<CoordinationEvent, { type: 'org-chart' }> => e.type === 'org-chart')
      .map((e) => {
        const eng = e.chart.nodes.filter((n) => n.role === 'engineer');
        return { working: eng.filter((n) => n.state === 'working').length, total: eng.length };
      });
    expect(engineerWorkCounts.some((c) => c.working === 1 && c.total > 1)).toBe(true);
    expect(engineerWorkCounts.every((c) => c.working <= 1)).toBe(true);

    // Bug 3: the click-through transcript held LIVE tool-call lines (read + bash),
    // not just a briefing.
    expect(liveToolLines).toBeGreaterThanOrEqual(2);
    const finalTranscript = engine.getWorkerTranscript(handle, runningNodeId ?? '');
    const toolNames = (finalTranscript?.lines ?? [])
      .filter((l) => l.kind === 'tool-call')
      .map((l) => l.text);
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('bash');
    // The run's live context reading threads through to the transcript (the
    // app's context ring fills from this).
    expect(finalTranscript?.contextPercent).toBe(37);

    // Bug 1: "X of N" climbed DURING the run — an intermediate checklist showed at
    // least one contract 'done' BEFORE the terminal event, and it grew.
    const doneCounts = events
      .filter((e): e is Extract<CoordinationEvent, { type: 'checklist' }> => e.type === 'checklist')
      .map((e) => e.items.filter((i) => i.state === 'done').length);
    const terminalIdx = events.findIndex((e) => e.type === 'done');
    const preTerminalChecklists = events
      .slice(0, terminalIdx)
      .filter(
        (e): e is Extract<CoordinationEvent, { type: 'checklist' }> => e.type === 'checklist',
      );
    expect(preTerminalChecklists.some((e) => e.items.some((i) => i.state === 'done'))).toBe(true);
    // The count is monotonic non-decreasing and reaches the full total (2 contracts).
    expect(Math.max(...doneCounts)).toBe(2);
    expect(doneCounts.some((n) => n > 0 && n < 2)).toBe(true);
  });
});

/** Await until `cond()` holds, yielding to the event loop between checks. */
async function waitFor(cond: () => boolean, label: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/**
 * The token-level PUSH channel (worker-activity): a role-agent that STREAMS its
 * assistant text delta-by-delta and writes a file must surface those as
 * `worker-activity` events on the neutral stream — the additive real-time feed
 * the renderer folds into a pi-style block (per-token, never a chunky poll) —
 * WITHOUT disturbing the transcript accumulation the peek/late-join relies on.
 */
function streamingRoleAgent(workspace: CorpWorkspace): RunRoleAgentFn {
  const root = workspace.workspace;
  const knownSlots = ['src/api/core.ts', 'src/ui/core.tsx'];
  return (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
    const emit = input.onActivity;
    const stop = (partial: Partial<RoleAgentRunOutput>): RoleAgentRunOutput => ({
      filesWritten: [],
      finalText: '',
      toolCalls: [],
      terminatedReason: 'stop',
      ...partial,
    });
    switch (input.purpose) {
      case 'vision':
        return Promise.resolve(stop({ finalText: 'Build a small dashboard.' }));
      case 'worker':
        // Stream the answer token-by-token BEFORE returning the promotion decision.
        emit?.({ kind: 'turn-start', turnIndex: 0 });
        emit?.({ kind: 'assistant-text', phase: 'start' });
        emit?.({ kind: 'assistant-text', phase: 'delta', delta: 'Planning ' });
        emit?.({ kind: 'assistant-text', phase: 'delta', delta: 'the build.' });
        emit?.({ kind: 'assistant-text', phase: 'end', text: 'Planning the build.' });
        return Promise.resolve(stop({ finalText: PROMOTION }));
      case 'architect':
        return Promise.resolve(stop({ finalText: ARCHITECTURE }));
      case 'manager':
        return Promise.resolve(
          stop({
            finalText: input.userPrompt.includes('Division: Backend')
              ? contractsFor('Backend', 'src/api/core.ts')
              : contractsFor('Frontend', 'src/ui/core.tsx'),
          }),
        );
      case 'engineer': {
        const slot = knownSlots.find((s) => input.userPrompt.includes(s)) ?? 'src/ui/core.tsx';
        const content = 'export const core = () => 42;\n';
        const bytes = new TextEncoder().encode(content).length;
        emit?.({ kind: 'turn-start', turnIndex: 0 });
        // A bash command STARTS (its command, no output yet) then its RESULT arrives
        // as a second `tool` record carrying the captured output — the terminal
        // mirror shows command + output.
        emit?.({ kind: 'tool', toolName: 'bash', detail: 'npm run build' });
        emit?.({
          kind: 'tool',
          toolName: 'bash',
          detail: 'npm run build',
          output: 'Build OK in 3.2s',
        });
        workspace.fs.writeFile(slotPath(root, slot), content);
        emit?.({ kind: 'file-write', toolName: 'write', path: slot, bytes, linesAdded: 1 });
        return Promise.resolve(
          stop({ finalText: 'wrote it', filesWritten: [{ path: slot, bytes }] }),
        );
      }
      case 'review':
        return Promise.resolve(
          stop({ toolCalls: [{ name: 'submit_findings', arguments: { findings: [] } }] }),
        );
      case 'ceo':
      case 'revise':
        return Promise.resolve(
          stop({ finalText: JSON.stringify({ decision: 'approve', notes: 'Looks complete.' }) }),
        );
      default:
        return Promise.resolve(stop({}));
    }
  };
}

describe('CorpEngine — worker-activity PUSH (per-token inline chat stream)', () => {
  it('emits worker-activity for an assistant-text delta and for a file write', async () => {
    const workspace = createMemoryWorkspace('/corp-wa');
    const engine = new CorpEngine({
      chat: () => {
        throw new Error('chat must not be called on the agent path');
      },
      runRoleAgent: streamingRoleAgent(workspace),
      workspaceFor: () => workspace,
      limit: 1,
      maxRevisions: 0,
    });
    const handle = engine.startTask('Build me a dashboard app');
    const events = await collect(handle);

    // Every worker-activity is a valid discriminated-union member (the type was
    // added to COORDINATION_EVENT_TYPES).
    const worker = events.filter(
      (e): e is Extract<CoordinationEvent, { type: 'worker-activity' }> =>
        e.type === 'worker-activity',
    );
    expect(worker.every((e) => isCoordinationEventType(e.type))).toBe(true);

    // Folding an assistant-text delta emitted worker-activity{kind:'text',delta},
    // attributed to a node, carrying the streamed increment.
    const textDeltas = worker.filter(
      (e) => e.kind === 'text' && e.phase === 'delta' && (e.delta?.length ?? 0) > 0,
    );
    expect(textDeltas.length).toBeGreaterThanOrEqual(2);
    expect(textDeltas.map((e) => e.delta).join('')).toBe('Planning the build.');
    expect(textDeltas.every((e) => typeof e.nodeId === 'string' && e.nodeId.length > 0)).toBe(true);
    // The stream opened + closed with phase markers (so the accumulator brackets a block).
    expect(worker.some((e) => e.kind === 'text' && e.phase === 'start')).toBe(true);
    expect(worker.some((e) => e.kind === 'text' && e.phase === 'end')).toBe(true);

    // A file write emitted worker-activity{kind:'file',addedLines}, pointing at the slot.
    const fileDeltas = worker.filter((e) => e.kind === 'file' && (e.addedLines ?? 0) > 0);
    expect(fileDeltas.length).toBeGreaterThan(0);
    expect(fileDeltas[0]?.path).toBeDefined();
    expect(fileDeltas[0]?.nodeId.startsWith('eng-')).toBe(true);

    // The additive PUSH did NOT disturb the transcript: the streamed text still
    // accumulated into the node's transcript line (peek/late-join intact).
    const solo =
      engine.getWorkerTranscript(handle, 'ceo') ?? engine.getWorkerTranscript(handle, 'solo');
    expect(solo).toBeDefined();

    // A bash step surfaced BOTH its command (a `tool` worker-activity, no output)
    // and its captured result (a `tool` worker-activity carrying `output`) — the
    // pair the terminal mirror folds into one row (command + output).
    const bashActivity = worker.filter((e) => e.kind === 'tool' && e.toolName === 'bash');
    expect(bashActivity.some((e) => e.output === undefined)).toBe(true);
    const withOutput = bashActivity.find((e) => e.output !== undefined);
    expect(withOutput?.output).toContain('Build OK');
    expect(withOutput?.nodeId.startsWith('eng-')).toBe(true);

    // Terminal, completed.
    expect(terminal(events).result.outcome).toBe('completed');
  });
});

describe('CorpEngine — a hung/aborted turn settles its frozen live line', () => {
  it('settles an OPEN streaming line (streaming:false) when the abort path emits turn-end', async () => {
    const workspace = createMemoryWorkspace('/corp-abort');
    let releaseOpen!: () => void;
    let releaseSettled!: () => void;
    const openedGate = new Promise<void>((r) => {
      releaseOpen = r;
    });
    const settledGate = new Promise<void>((r) => {
      releaseSettled = r;
    });
    let danced = false;

    // The FIRST role turn (the CEO vision, attributed to the solo node) opens a live
    // reasoning stream and then HANGS — its stream is cut, so no thinking_end/turn_end
    // arrives. It settles the frozen line with a synthetic turn-end (the SAME record
    // runRoleAgent's abort/error path emits via settleActivitiesOnEnd), staying in
    // flight (settledGate) so the run's own terminate() cannot be what settled it.
    const abortingRoleAgent: RunRoleAgentFn = (
      input: RoleAgentRunInput,
    ): Promise<RoleAgentRunOutput> => {
      const emit = input.onActivity;
      if (danced) {
        return Promise.resolve({
          filesWritten: [],
          finalText: '',
          toolCalls: [],
          terminatedReason: 'stop',
        });
      }
      danced = true;
      emit?.({ kind: 'turn-start', turnIndex: 0 });
      emit?.({ kind: 'thinking', phase: 'start' });
      emit?.({ kind: 'thinking', phase: 'delta', delta: 'weighing the approach' });
      return openedGate.then(() => {
        emit?.({ kind: 'turn-end', turnIndex: 0 });
        return settledGate.then(() => ({
          filesWritten: [],
          finalText: '',
          toolCalls: [],
          terminatedReason: 'error' as const,
        }));
      });
    };

    const engine = new CorpEngine({
      chat: () => {
        throw new Error('chat must not be called on the agent path');
      },
      runRoleAgent: abortingRoleAgent,
      workspaceFor: () => workspace,
      maxRevisions: 0,
    });
    const handle = engine.startTask('Do a small thing');

    const thinkingLine = () =>
      engine.getWorkerTranscript(handle, 'solo')?.lines.find((l) => l.kind === 'thinking');

    // 1) The line opens live — this is the frozen "Thinking…" the bug leaves spinning.
    await waitFor(() => thinkingLine()?.streaming === true, 'thinking line opens');
    expect(engine.getWorkerTranscript(handle, 'solo')?.streaming).toBe(true);
    releaseOpen();

    // 2) The abort's turn-end settles the SAME line — streaming:false — while the run
    //    is still in flight (blocked on settledGate), so terminate() is NOT what
    //    closed it: the settle is the abort path's own doing.
    await waitFor(() => thinkingLine()?.streaming !== true, 'thinking line settles');
    const settled = engine.getWorkerTranscript(handle, 'solo');
    expect(settled?.lines.find((l) => l.kind === 'thinking')?.streaming).toBeFalsy();
    expect(settled?.streaming).toBeFalsy();

    releaseSettled();
    await collect(handle); // drain to done so the background run tears down cleanly
  });
});
