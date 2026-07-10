import { type ChatMsg, createEventRouter, type PiBridgeEvent } from '@pi-desktop/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiSink, usePiStore } from './pi-slice';

const initial = usePiStore.getState();

function route(events: PiBridgeEvent[]): void {
  const router = createEventRouter(createPiSink(), { nextId: (p) => `${p}-test` });
  for (const e of events) router.handleEvent(e);
}

beforeEach(() => {
  usePiStore.setState(initial, true);
});

describe('pi-slice as StoreSink', () => {
  it('accumulates streamed text into one assistant message', () => {
    route([
      { type: 'agent_start' },
      { type: 'turn_start' },
      {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' },
      } as unknown as PiBridgeEvent,
      {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' },
      } as unknown as PiBridgeEvent,
    ]);
    const { messages, agent } = usePiStore.getState();
    expect(agent.isStreaming).toBe(true);
    expect(messages).toHaveLength(1);
    const assistant = messages[0];
    if (assistant?.kind !== 'assistant') throw new Error('expected assistant');
    expect(assistant.isStreaming).toBe(true);
    expect(assistant.blocks).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('tracks tool call args, running state, and upserts results without duplicates', () => {
    route([
      { type: 'agent_start' },
      { type: 'turn_start' },
      {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: {
          type: 'toolcall_start',
          id: 'c1',
          name: 'bash',
          arguments: {},
        },
      } as unknown as PiBridgeEvent,
      {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'toolcall_delta', id: 'c1', argsDelta: '{"command":"ls"}' },
      } as unknown as PiBridgeEvent,
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} },
    ]);
    expect(usePiStore.getState().runningToolCalls).toEqual(['c1']);

    route([]); // no-op; continue with a fresh router is fine for execution end
    const sinkEvents: PiBridgeEvent[] = [
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'partial' }] },
        isError: false,
      },
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [],
          api: 'a',
          provider: 'p',
          model: 'm',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        toolResults: [
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'final output' }],
            isError: false,
            timestamp: 2,
          },
        ],
      } as unknown as PiBridgeEvent,
    ];
    // Reuse one router across both event groups so turn state is preserved.
    const router = createEventRouter(createPiSink(), { nextId: (p) => `${p}-again` });
    router.handleEvent({ type: 'turn_start' });
    for (const e of sinkEvents) router.handleEvent(e);

    const { messages, runningToolCalls } = usePiStore.getState();
    const results = messages.filter((m) => m.kind === 'toolResult');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: 'c1', text: 'final output' });
    expect(runningToolCalls).toEqual([]);

    const argsBlocks = messages.flatMap((m) =>
      m.kind === 'assistant' ? m.blocks.filter((b) => b.type === 'toolCall') : [],
    );
    expect(argsBlocks[0]).toMatchObject({ id: 'c1', argsText: '{"command":"ls"}' });
  });

  it('caps notifications and stores ui requests until resolved', () => {
    route(
      ['a', 'b', 'c', 'd', 'e', 'f'].map(
        (m) =>
          ({
            type: 'extension_ui_request',
            id: `n-${m}`,
            method: 'notify',
            message: m,
            notifyType: 'error',
          }) as unknown as PiBridgeEvent,
      ),
    );
    expect(usePiStore.getState().notifications.length).toBeLessThanOrEqual(4);

    route([
      {
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'confirm',
        title: 'ok?',
        message: 'sure?',
      } as unknown as PiBridgeEvent,
    ]);
    expect(usePiStore.getState().uiRequests).toHaveLength(1);
    usePiStore.getState().resolveUiRequest('ui-1');
    expect(usePiStore.getState().uiRequests).toHaveLength(0);
  });

  it('appendUser provides the local echo the composer needs', () => {
    usePiStore.getState().appendUser('hi there');
    expect(usePiStore.getState().messages[0]).toMatchObject({ kind: 'user', text: 'hi there' });
  });
});

describe('pi-slice — fork branch registry', () => {
  const userMsg = (id: string, text: string): ChatMsg => ({
    kind: 'user',
    id,
    text,
    timestamp: 1,
  });
  const asstMsg = (id: string, text: string): ChatMsg => ({
    kind: 'assistant',
    id,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
  });
  const textOf = (m: ChatMsg): string =>
    m.kind === 'user'
      ? m.text
      : m.kind === 'assistant'
        ? m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
        : '';

  it('commitFork trims to the fork point and records the two branches', () => {
    const store = usePiStore.getState();
    store.setMessagesExternal([userMsg('u1', 'count to three'), asstMsg('a1', 'Original')]);
    store.commitFork(0, {
      messageIndex: 0,
      newFile: '/s/branch-1.jsonl',
      baseFile: '/s/branch-0.jsonl',
      editedText: 'count to five',
    });

    const s = usePiStore.getState();
    // Thread reset to the edited user echo (prefix before the fork point + edit).
    expect(s.messages.map((m) => m.kind)).toEqual(['user']);
    expect(s.messages[0]).toMatchObject({ kind: 'user', text: 'count to five' });
    const group = s.branches[0];
    expect(group?.files).toEqual(['/s/branch-0.jsonl', '/s/branch-1.jsonl']);
    expect(group?.active).toBe(1);
    // Branch 0 kept the full original thread as its snapshot.
    expect(group?.snapshots[0]?.map((m) => m.kind)).toEqual(['user', 'assistant']);
  });

  it('switchBranch swaps the visible transcript and captures the outgoing one', () => {
    const store = usePiStore.getState();
    store.setMessagesExternal([userMsg('u1', 'count to three'), asstMsg('a1', 'Original')]);
    store.commitFork(0, {
      messageIndex: 0,
      newFile: '/s/branch-1.jsonl',
      baseFile: '/s/branch-0.jsonl',
      editedText: 'count to five',
    });
    // Simulate the forked turn's streamed response landing in the live thread.
    usePiStore.setState((s) => ({ messages: [...s.messages, asstMsg('a2', 'Edited')] }));

    // ‹ back to branch 0 → the original transcript returns.
    usePiStore.getState().switchBranch(0, 0);
    let s = usePiStore.getState();
    expect(s.branches[0]?.active).toBe(0);
    expect(s.messages.map(textOf)).toEqual(['count to three', 'Original']);

    // › forward to branch 1 → the edited transcript (with its response) returns.
    usePiStore.getState().switchBranch(0, 1);
    s = usePiStore.getState();
    expect(s.branches[0]?.active).toBe(1);
    expect(s.messages.map(textOf)).toEqual(['count to five', 'Edited']);
  });

  it('setMessagesExternal (session load) clears the branch registry', () => {
    const store = usePiStore.getState();
    store.setMessagesExternal([userMsg('u1', 'hi')]);
    store.commitFork(0, {
      messageIndex: 0,
      newFile: '/s/b1.jsonl',
      baseFile: '/s/b0.jsonl',
      editedText: 'hey',
    });
    expect(Object.keys(usePiStore.getState().branches)).toHaveLength(1);
    usePiStore.getState().setMessagesExternal([userMsg('u2', 'other session')]);
    expect(usePiStore.getState().branches).toEqual({});
  });
});

describe('pi-slice — toolCallId reuse across runs (index-as-id providers)', () => {
  function runOnce(router: ReturnType<typeof createEventRouter>, output: string): void {
    const events: PiBridgeEvent[] = [
      { type: 'agent_start' },
      { type: 'turn_start' },
      {
        type: 'tool_execution_start',
        toolCallId: 'call_0',
        toolName: 'get_time',
        args: {},
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'call_0',
        toolName: 'get_time',
        result: { content: [{ type: 'text', text: output }] },
        isError: false,
      },
      {
        type: 'turn_end',
        message: { role: 'assistant', content: [], stopReason: 'toolUse' },
        toolResults: [
          {
            role: 'toolResult',
            toolCallId: 'call_0',
            toolName: 'get_time',
            content: [{ type: 'text', text: output }],
            isError: false,
            timestamp: 1,
          },
        ],
      },
      { type: 'agent_end', messages: [] },
    ] as unknown as PiBridgeEvent[];
    for (const e of events) router.handleEvent(e);
  }

  it('keeps both runs’ results distinct and in order', () => {
    let n = 0;
    const router = createEventRouter(createPiSink(), { nextId: (p) => `${p}-${++n}` });
    runOnce(router, 'RUN1 OUTPUT');
    runOnce(router, 'RUN2 OUTPUT');
    const shape = usePiStore
      .getState()
      .messages.map((m) => (m.kind === 'toolResult' ? `toolResult:${m.text}` : m.kind));
    expect(shape).toEqual([
      'assistant',
      'toolResult:RUN1 OUTPUT',
      'assistant',
      'toolResult:RUN2 OUTPUT',
    ]);
  });

  it('still dedupes the same result arriving twice within one turn', () => {
    let n = 0;
    const router = createEventRouter(createPiSink(), { nextId: (p) => `${p}-${++n}` });
    runOnce(router, 'ONLY ONCE');
    const results = usePiStore.getState().messages.filter((m) => m.kind === 'toolResult');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: 'call_0', text: 'ONLY ONCE' });
  });
});

describe('pi-slice — artifact candidate dedupe', () => {
  it('one edit call with streamed args yields exactly one artifact entry', () => {
    const router = createEventRouter(createPiSink(), { nextId: (p) => `${p}-a` });
    const feed = (e: unknown): void => router.handleEvent(e as PiBridgeEvent);
    feed({ type: 'agent_start' });
    feed({ type: 'turn_start' });
    const partial = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc-1', name: 'edit', arguments: {} }],
    };
    feed({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial },
    });
    // Path-peek fires the first candidate…
    feed({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        partial,
        delta: '{"file_path": "/repo/src/main.ts", "old_string": "a", "new_string": "b"}',
      },
    });
    // …and tool_execution_start intentionally re-pushes the same identity.
    feed({
      type: 'tool_execution_start',
      toolCallId: 'tc-1',
      toolName: 'edit',
      args: { file_path: '/repo/src/main.ts', old_string: 'a', new_string: 'b' },
    });
    expect(usePiStore.getState().artifacts).toHaveLength(1);
    expect(usePiStore.getState().artifacts[0]).toMatchObject({
      kind: 'file',
      path: '/repo/src/main.ts',
      op: 'edit',
    });
  });

  it('re-touching a path moves it to the head with the newest op; other paths survive', () => {
    const sink = createPiSink();
    sink.artifactCandidate({ kind: 'file', path: '/a.ts', op: 'read' });
    sink.artifactCandidate({ kind: 'file', path: '/b.ts', op: 'write' });
    sink.artifactCandidate({ kind: 'url', url: 'https://example.com' });
    sink.artifactCandidate({ kind: 'file', path: '/a.ts', op: 'edit' });
    sink.artifactCandidate({ kind: 'url', url: 'https://example.com' });
    expect(usePiStore.getState().artifacts).toEqual([
      { kind: 'url', url: 'https://example.com' },
      { kind: 'file', path: '/a.ts', op: 'edit' },
      { kind: 'file', path: '/b.ts', op: 'write' },
    ]);
  });
});

describe('pi-slice — dialog lifecycle (pi auto-resolves expired dialogs silently)', () => {
  afterEach(() => vi.useRealTimers());

  it('a timed-out dialog is removed from the store without a user answer', () => {
    vi.useFakeTimers();
    const router = createEventRouter(createPiSink(), { nextId: (p) => `${p}-d` });
    router.handleEvent({
      type: 'extension_ui_request',
      id: 'ui-confirm-1',
      method: 'confirm',
      title: 'Proceed?',
      message: 'Dangerous op',
      timeout: 30_000,
    } as unknown as PiBridgeEvent);
    expect(usePiStore.getState().uiRequests).toHaveLength(1);
    vi.advanceTimersByTime(31_000);
    expect(usePiStore.getState().uiRequests).toHaveLength(0);
  });

  it('agent_end and bridge exit drop queued dialogs', () => {
    const router = createEventRouter(createPiSink(), { nextId: (p) => `${p}-d` });
    const dialog = (id: string): PiBridgeEvent =>
      ({
        type: 'extension_ui_request',
        id,
        method: 'input',
        title: 'Name?',
      }) as unknown as PiBridgeEvent;
    router.handleEvent(dialog('ui-1'));
    router.handleEvent({ type: 'agent_end', messages: [] } as unknown as PiBridgeEvent);
    expect(usePiStore.getState().uiRequests).toHaveLength(0);

    router.handleEvent(dialog('ui-2'));
    router.handleEvent({ type: '_bridge_exit', code: 1, signal: null } as PiBridgeEvent);
    expect(usePiStore.getState().uiRequests).toHaveLength(0);
    expect(usePiStore.getState().bridgeExited).toEqual({ code: 1, signal: null });
  });
});
