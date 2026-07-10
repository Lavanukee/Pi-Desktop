import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiBridgeEvent } from '../types/rpc';
import { createEventRouter, extractToolResultText, opFor, stripAnsi } from './event-router';
import { abortEvents, loadFixture, promptEvents } from './test-helpers/fixtures';
import { RecordingSink } from './test-helpers/recording-sink';

function makeRouter(): { sink: RecordingSink; route: (e: PiBridgeEvent) => void } {
  const sink = new RecordingSink();
  let n = 0;
  const router = createEventRouter(sink, {
    nextId: (prefix) => `${prefix}-${++n}`,
    now: () => 1770000000000,
  });
  return { sink, route: (e) => router.handleEvent(e) };
}

function replayPrompt(fixtureName: string, index: number): RecordingSink {
  const { sink, route } = makeRouter();
  for (const event of promptEvents(loadFixture(fixtureName), index)) route(event);
  return sink;
}

describe('event router — full fixture replays (mutation sequence snapshots)', () => {
  it('simple-chat: streamed text turn', () => {
    expect(replayPrompt('simple-chat', 0).calls).toMatchSnapshot();
  });

  it('tool-use: bash + edit with streaming args, executions, results', () => {
    expect(replayPrompt('tool-use', 0).calls).toMatchSnapshot();
  });

  it('edge-cases/think: thinking deltas + huge unicode text block', () => {
    expect(replayPrompt('edge-cases', 0).calls).toMatchSnapshot();
  });

  it('edge-cases/confirm: dialog, notify policy, ghost + legacy tool calls', () => {
    expect(replayPrompt('edge-cases', 1).calls).toMatchSnapshot();
  });

  it('edge-cases/abort: aborted turn still finalizes cleanly', () => {
    expect(replayPrompt('edge-cases', 2).calls).toMatchSnapshot();
  });

  it('parallel-tools: two interleaved streams (0.68.1 id-less deltas + >512-char args)', () => {
    const sink = replayPrompt('parallel-tools', 0);
    // Both calls render, both artifact candidates fire (one from a single
    // huge delta), both result rows are distinct.
    expect(sink.callsFor('beginToolCall')).toHaveLength(2);
    expect(sink.calls).toMatchSnapshot();
  });

  it('id-reuse: same toolCallId across turns renders every call and result', () => {
    const sink = replayPrompt('id-reuse', 0);
    // Two call_0 turns plus one empty-id call — all visible.
    expect(sink.callsFor('beginToolCall')).toHaveLength(3);
    expect(sink.calls).toMatchSnapshot();
  });

  it('id-reuse across runs: fresh run reusing call_0 still renders (fixture prompt #2)', () => {
    const { sink, route } = makeRouter();
    const fixture = loadFixture('id-reuse');
    for (const event of promptEvents(fixture, 0)) route(event);
    for (const event of promptEvents(fixture, 1)) route(event);
    expect(sink.callsFor('beginToolCall')).toHaveLength(4);
    const rowIds = new Set(
      sink.callsFor('upsertToolResult').map((c) => (c[1] as { id: string }).id),
    );
    expect(rowIds.size).toBe(3);
  });

  it('abort-during-tool: abort mid-tool-phase, orphan result after agent_end', () => {
    const { sink, route } = makeRouter();
    const fixture = loadFixture('abort-during-tool');
    for (const event of promptEvents(fixture, 0)) route(event);
    for (const event of abortEvents(fixture, 0)) route(event);
    expect(sink.calls).toMatchSnapshot();
  });

  it('status-stream: queue/compaction/retry/model/session/widget/select coverage', () => {
    expect(replayPrompt('status-stream', 0).calls).toMatchSnapshot();
  });
});

describe('event router — null-valued wire sub-fields (JSON null treated as absent) [round-9]', () => {
  it('does not throw when streaming wire fields arrive as JSON null', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });

    // assistantMessageEvent === null must be treated as absent (a `=== undefined`
    // guard would fall through to `ev.type` and throw).
    expect(() =>
      route({ type: 'message_update', assistantMessageEvent: null } as unknown as PiBridgeEvent),
    ).not.toThrow();

    // toolcall_end carrying a null toolCall must be skipped, not dereferenced.
    expect(() =>
      route({
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: null },
      } as unknown as PiBridgeEvent),
    ).not.toThrow();

    // turn_end with a null message finalizes the turn without throwing, and a
    // null entry inside toolResults is silently dropped.
    expect(() =>
      route({
        type: 'turn_end',
        message: null,
        toolResults: [null],
      } as unknown as PiBridgeEvent),
    ).not.toThrow();

    // The turn still finalized (endTurn was recorded) despite the null message.
    expect(sink.callsFor('endTurn').length).toBeGreaterThan(0);
  });
});

describe('event router — synthesized tool rows (hiding tool calls is a trust violation)', () => {
  it('synthesizes the inline block when only tool_execution_start/end arrive', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route({
      type: 'tool_execution_start',
      toolCallId: 'call_ghost',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    route({
      type: 'tool_execution_end',
      toolCallId: 'call_ghost',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    });
    const begins = sink.callsFor('beginToolCall');
    expect(begins).toHaveLength(1);
    expect(begins[0]?.[2]).toMatchObject({ id: 'call_ghost', name: 'bash' });
    expect(sink.callsFor('upsertToolResult')).toHaveLength(1);
  });

  it('synthesizes at turn_end for results whose call was never announced', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route({
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
          toolCallId: 'call_unseen',
          toolName: 'read',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    expect(sink.callsFor('beginToolCall')).toHaveLength(1);
    expect(sink.callsFor('upsertToolResult')[0]?.[1]).toMatchObject({
      toolCallId: 'call_unseen',
      text: 'file contents',
    });
  });

  it('never duplicates a block when start, execution, and turn_end all mention the same call', () => {
    const { sink, route } = makeRouter();
    const partial = {
      role: 'assistant' as const,
      content: [{ type: 'toolCall' as const, id: 'call_1', name: 'bash', arguments: {} }],
    };
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial },
    } as unknown as PiBridgeEvent);
    route({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    route({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    });
    expect(sink.callsFor('beginToolCall')).toHaveLength(1);
  });
});

describe('event router — reused and empty toolCallIds (index-as-id providers)', () => {
  const modernPartial = (callId: string) => ({
    role: 'assistant' as const,
    content: [{ type: 'toolCall' as const, id: callId, name: 'bash', arguments: {} }],
  });

  function turnWithTool(
    route: (e: PiBridgeEvent) => void,
    callId: string,
    resultText: string,
  ): void {
    const partial = modernPartial(callId);
    route({ type: 'turn_start' });
    route({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial },
    } as unknown as PiBridgeEvent);
    route({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"command":"x"}',
        partial,
      },
    } as unknown as PiBridgeEvent);
    route({
      type: 'tool_execution_end',
      toolCallId: callId,
      toolName: 'bash',
      result: { content: [{ type: 'text', text: resultText }] },
      isError: false,
    });
    route({
      type: 'turn_end',
      message: { role: 'assistant', content: [], stopReason: 'toolUse' },
      toolResults: [
        {
          role: 'toolResult',
          toolCallId: callId,
          toolName: 'bash',
          content: [{ type: 'text', text: resultText }],
          isError: false,
          timestamp: 1,
        },
      ],
    } as unknown as PiBridgeEvent);
  }

  it('renders both tool calls when a later turn reuses the same toolCallId', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    turnWithTool(route, 'call_0', 'turn1 output');
    turnWithTool(route, 'call_0', 'turn2 output');
    route({ type: 'agent_end', messages: [] } as unknown as PiBridgeEvent);
    expect(sink.callsFor('beginToolCall')).toHaveLength(2);
    // …and each turn's deltas land on that turn's own assistant message.
    expect(sink.callsFor('appendToolCallArgs').map((c) => c[1])).toEqual(['a-1', 'a-2']);
  });

  it('keeps result rows distinct across turns (assistant-scoped row ids)', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    turnWithTool(route, 'call_0', 'turn1 output');
    turnWithTool(route, 'call_0', 'turn2 output');
    const rows = sink.callsFor('upsertToolResult').map((c) => c[1] as { id: string });
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('treats empty-string ids as missing: two calls in one turn get two rows', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    const block = (name: string) => ({ type: 'toolCall', id: '', name, arguments: {} });
    route({
      type: 'message_update',
      message: { role: 'assistant', content: [block('bash')] },
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { role: 'assistant', content: [block('bash')] },
      },
    } as unknown as PiBridgeEvent);
    route({
      type: 'message_update',
      message: { role: 'assistant', content: [block('bash'), block('read')] },
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 1,
        partial: { role: 'assistant', content: [block('bash'), block('read')] },
      },
    } as unknown as PiBridgeEvent);
    const begins = sink.callsFor('beginToolCall');
    expect(begins).toHaveLength(2);
    const ids = begins.map((c) => (c[2] as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('toolcall_end with an empty id finalizes the streamed block via callIdByIndex', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    const partial = {
      role: 'assistant' as const,
      content: [{ type: 'toolCall' as const, id: '', name: 'write', arguments: {} }],
    };
    route({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial },
    } as unknown as PiBridgeEvent);
    route({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: '', name: 'write', arguments: { path: '/tmp/e.txt' } },
        partial,
      },
    } as unknown as PiBridgeEvent);
    // No second block was begun; finalize targeted the streamed one.
    expect(sink.callsFor('beginToolCall')).toHaveLength(1);
    const begunId = (sink.callsFor('beginToolCall')[0]?.[2] as { id: string }).id;
    expect(sink.callsFor('finalizeToolCall')[0]?.[2]).toBe(begunId);
  });

  it('tool_execution_start with an empty id still renders a row', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route({ type: 'tool_execution_start', toolCallId: '', toolName: 'bash', args: {} });
    expect(sink.callsFor('beginToolCall')).toHaveLength(1);
    expect((sink.callsFor('beginToolCall')[0]?.[2] as { id: string }).id).not.toBe('');
  });
});

describe('event router — streaming args path peek', () => {
  const start = (id: string, name: string): PiBridgeEvent =>
    ({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'toolcall_start', id, name, arguments: {} },
    }) as unknown as PiBridgeEvent;
  const delta = (id: string, argsDelta: string): PiBridgeEvent =>
    ({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'toolcall_delta', id, argsDelta },
    }) as unknown as PiBridgeEvent;

  it('fires an artifact candidate once when the path appears within 512 chars', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route(start('c1', 'write'));
    route(delta('c1', '{"pa'));
    route(delta('c1', 'th":"/tmp/a.html","content":"'));
    route(delta('c1', 'more","x":"/tmp/b.html"}'));
    const candidates = sink.callsFor('artifactCandidate');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.[1]).toEqual({
      kind: 'file',
      path: '/tmp/a.html',
      op: 'write',
      toolCallId: 'c1',
      toolName: 'write',
    });
  });

  it('gives up scanning past 512 chars (streaming perf guard)', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route(start('c2', 'write'));
    route(delta('c2', `{"content":"${'x'.repeat(600)}",`));
    // Path arrives only after the cutoff — must NOT be picked up.
    route(delta('c2', '"path":"/tmp/late.html"}'));
    expect(sink.callsFor('artifactCandidate')).toHaveLength(0);
    // The args deltas still reached the store untouched.
    expect(sink.callsFor('appendToolCallArgs')).toHaveLength(2);
  });

  it('fires when a single large delta (>512 chars) carries the path inside the window', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route(start('c5', 'write'));
    // Many servers deliver the complete args JSON in one chunk.
    route(delta('c5', `{"path":"/tmp/big.html","content":"${'x'.repeat(600)}"}`));
    const candidates = sink.callsFor('artifactCandidate');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.[1]).toMatchObject({ path: '/tmp/big.html', op: 'write' });
    // The window is now full: later deltas must not fire again.
    route(delta('c5', '"path":"/tmp/other.html"'));
    expect(sink.callsFor('artifactCandidate')).toHaveLength(1);
  });

  it('scans a buffer of exactly 512 chars (boundary) before giving up', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route(start('c6', 'write'));
    const exact = `{"path":"/tmp/big.html","content":"${'x'.repeat(512 - 37)}"}`;
    expect(exact.length).toBe(512);
    route(delta('c6', exact));
    expect(sink.callsFor('artifactCandidate')).toHaveLength(1);
  });

  it('does not fire for tools with no workspace op (e.g. bash)', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route(start('c3', 'bash'));
    route(delta('c3', '{"path":"/tmp/a.sh"}'));
    expect(sink.callsFor('artifactCandidate')).toHaveLength(0);
  });

  it('uses upfront arguments from toolcall_start when providers send them', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'toolcall_start',
        id: 'c4',
        name: 'read',
        arguments: { path: '/etc/hosts' },
      },
    } as unknown as PiBridgeEvent);
    expect(sink.callsFor('artifactCandidate')[0]?.[1]).toMatchObject({
      kind: 'file',
      path: '/etc/hosts',
      op: 'read',
    });
  });
});

describe('event router — errors-only notify policy', () => {
  const notify = (notifyType: string | undefined, message: string): PiBridgeEvent =>
    ({
      type: 'extension_ui_request',
      id: `n-${message}`,
      method: 'notify',
      message,
      notifyType,
    }) as unknown as PiBridgeEvent;

  it('drops info/warning/success chatter and surfaces errors (ANSI-stripped)', () => {
    const { sink, route } = makeRouter();
    route(notify('info', 'llm up'));
    route(notify('warning', 'careful'));
    route(notify(undefined, 'defaults to info'));
    route(notify('error', '\u001b[31mboom\u001b[0m'));
    expect(sink.callsFor('notify')).toEqual([['notify', 'error', 'boom']]);
  });

  it('extension_error and bridge exit surface as error notifications', () => {
    const { sink, route } = makeRouter();
    route({ type: 'extension_error', error: 'ext blew up' });
    route({ type: '_bridge_exit', code: null, signal: 'SIGKILL' });
    expect(sink.callsFor('notify').map((c) => c[2])).toEqual([
      'Extension error: ext blew up',
      'pi exited (SIGKILL).',
    ]);
    expect(sink.callsFor('bridgeExit')).toHaveLength(1);
  });
});

describe('event router — bridge exit finalizes the in-flight turn', () => {
  it('endTurn(stopReason error) fires for the streaming assistant row, then state resets', () => {
    const { sink, route } = makeRouter();
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial answ' },
    } as unknown as PiBridgeEvent);
    route({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'read',
      args: { path: '/x' },
    });
    route({ type: '_bridge_exit', code: null, signal: 'SIGKILL' });
    expect(sink.callsFor('endTurn')).toEqual([['endTurn', 'a-1', 'error', undefined]]);

    // Restarted bridge, same router: pre-crash bookkeeping must not suppress
    // a new run that reuses the same callId.
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'write',
      args: { path: '/y' },
    });
    expect(sink.callsFor('beginToolCall')).toHaveLength(2);
  });

  it('does not call endTurn when no turn is in flight', () => {
    const { sink, route } = makeRouter();
    route({ type: '_bridge_exit', code: 1, signal: null });
    expect(sink.callsFor('endTurn')).toHaveLength(0);
    expect(sink.callsFor('bridgeExit')).toHaveLength(1);
  });
});

describe('event router — harness ask_user (rich QuestionCard over input)', () => {
  const sentinel = 'PI_DESKTOP_ASK_USER::v1::';

  it('decodes a sentinel-tagged input placeholder into a synthetic askUser dialog', () => {
    const { sink, route } = makeRouter();
    const spec = {
      v: 1,
      mode: 'multi',
      question: 'Pick features',
      options: [
        { value: 'a', label: 'Auth' },
        { value: 'b', label: 'Billing' },
      ],
    };
    route({
      type: 'extension_ui_request',
      id: 'ask-1',
      method: 'input',
      title: 'Pick features',
      placeholder: sentinel + JSON.stringify(spec),
    } as unknown as PiBridgeEvent);

    const [call] = sink.callsFor('uiRequest');
    const req = call?.[1] as
      | { method: string; ask?: { mode: string }; placeholder?: string }
      | undefined;
    expect(req?.method).toBe('askUser');
    expect(req?.ask?.mode).toBe('multi');
    // The sentinel placeholder is not leaked to the plain-input field.
    expect(req?.placeholder).toBeUndefined();
  });

  it('leaves a plain input request as a normal input dialog', () => {
    const { sink, route } = makeRouter();
    route({
      type: 'extension_ui_request',
      id: 'in-1',
      method: 'input',
      title: 'Your name?',
      placeholder: 'Ada',
    } as unknown as PiBridgeEvent);
    const [call] = sink.callsFor('uiRequest');
    const req = call?.[1] as { method: string; ask?: unknown } | undefined;
    expect(req?.method).toBe('input');
    expect(req?.ask).toBeUndefined();
  });

  it('treats a malformed sentinel payload as a normal input (defensive)', () => {
    const { sink, route } = makeRouter();
    route({
      type: 'extension_ui_request',
      id: 'in-2',
      method: 'input',
      title: 'x',
      placeholder: `${sentinel}not json{`,
    } as unknown as PiBridgeEvent);
    const [call] = sink.callsFor('uiRequest');
    const req = call?.[1] as { method: string } | undefined;
    expect(req?.method).toBe('input');
  });
});

describe('event router — dialog expiry (pi auto-resolves silently)', () => {
  afterEach(() => vi.useRealTimers());

  it('self-expires a timed dialog via sink.resolveUiRequest after timeout + grace', () => {
    vi.useFakeTimers();
    const { sink, route } = makeRouter();
    route({
      type: 'extension_ui_request',
      id: 'ui-confirm-1',
      method: 'confirm',
      title: 'Proceed?',
      message: 'Dangerous op',
      timeout: 30_000,
    } as unknown as PiBridgeEvent);
    expect(sink.callsFor('uiRequest')).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(sink.callsFor('resolveUiRequest')).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(sink.callsFor('resolveUiRequest')).toEqual([['resolveUiRequest', 'ui-confirm-1']]);
  });

  it('never expires dialogs without a timeout, and reset() cancels pending timers', () => {
    vi.useFakeTimers();
    const { sink, route } = makeRouter();
    route({
      type: 'extension_ui_request',
      id: 'ui-editor-1',
      method: 'editor',
      title: 'Edit',
    } as unknown as PiBridgeEvent);
    route({
      type: 'extension_ui_request',
      id: 'ui-select-1',
      method: 'select',
      title: 'Pick',
      options: ['a'],
      timeout: 5000,
    } as unknown as PiBridgeEvent);
    // agent_end resets per-run state, which must cancel the expiry timer.
    route({ type: 'agent_end', messages: [] } as unknown as PiBridgeEvent);
    vi.advanceTimersByTime(600_000);
    expect(sink.callsFor('resolveUiRequest')).toHaveLength(0);
  });
});

describe('event router — misc defensive behaviors', () => {
  it('0.68.1 toolcall events without top-level ids resolve via partial.content[contentIndex]', () => {
    const { sink, route } = makeRouter();
    const partial = {
      role: 'assistant' as const,
      content: [{ type: 'toolCall' as const, id: 'call_modern', name: 'edit', arguments: {} }],
    };
    route({ type: 'agent_start' });
    route({ type: 'turn_start' });
    route({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial },
    } as unknown as PiBridgeEvent);
    route({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"path":"/tmp/x.ts"}',
        partial,
      },
    } as unknown as PiBridgeEvent);
    expect(sink.callsFor('beginToolCall')[0]?.[2]).toMatchObject({ id: 'call_modern' });
    expect(sink.callsFor('appendToolCallArgs')[0]?.slice(1)).toEqual([
      'a-1',
      'call_modern',
      '{"path":"/tmp/x.ts"}',
    ]);
    expect(sink.callsFor('artifactCandidate')[0]?.[1]).toMatchObject({ path: '/tmp/x.ts' });
  });

  it('get_state responses hydrate agent status and session info', () => {
    const { sink, route } = makeRouter();
    route({
      type: 'response',
      command: 'get_state',
      success: true,
      id: 'probe',
      data: {
        model: {
          id: 'm1',
          name: 'Model One',
          api: 'openai-completions',
          provider: 'llamacpp',
          baseUrl: '',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 512,
        },
        thinkingLevel: 'off',
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'all',
        followUpMode: 'all',
        sessionFile: '/tmp/s.jsonl',
        sessionId: 'sid',
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
    expect(sink.callsFor('setAgentStatus')[0]?.[1]).toMatchObject({
      model: { id: 'm1', name: 'Model One', provider: 'llamacpp' },
    });
    expect(sink.callsFor('sessionChanged')[0]?.[1]).toEqual({
      sessionFile: '/tmp/s.jsonl',
      sessionId: 'sid',
    });
  });

  it('get_state with model: null (docs/rpc.md-sanctioned shape) hydrates without throwing', () => {
    const { sink, route } = makeRouter();
    // Exactly what JSON.parse of a pi stdout line with "model": null yields.
    route(
      JSON.parse(
        JSON.stringify({
          type: 'response',
          command: 'get_state',
          success: true,
          id: 'probe',
          data: {
            model: null,
            thinkingLevel: 'off',
            isStreaming: false,
            isCompacting: false,
            steeringMode: 'all',
            followUpMode: 'all',
            sessionFile: '/tmp/s.jsonl',
            sessionId: 'sid',
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          },
        }),
      ) as PiBridgeEvent,
    );
    expect(sink.callsFor('setAgentStatus')[0]?.[1]).toMatchObject({ model: null });
    expect(sink.callsFor('sessionChanged')).toHaveLength(1);
  });

  it('failed responses surface as error notifications (protocol drift visibility)', () => {
    const { sink, route } = makeRouter();
    route({
      type: 'response',
      command: 'some_future_command',
      success: false,
      error: 'Unknown command: some_future_command',
    } as unknown as PiBridgeEvent);
    expect(sink.callsFor('notify')).toEqual([
      ['notify', 'error', 'pi rejected some_future_command: Unknown command: some_future_command'],
    ]);
  });

  it('filters bracketed stderr noise but surfaces real lines', () => {
    const { sink, route } = makeRouter();
    route({ type: '_stderr', text: '[pi] debug chatter\n' });
    route({ type: '_stderr', text: '   \n' });
    route({ type: '_stderr', text: 'FATAL: cannot load model\n' });
    expect(sink.callsFor('stderrText')).toEqual([['stderrText', 'FATAL: cannot load model\n']]);
  });

  it('queue/compaction/retry events map to agent status patches', () => {
    const { sink, route } = makeRouter();
    route({ type: 'queue_update', steering: ['a'], followUp: ['b', 'c'] });
    route({ type: 'compaction_start', reason: 'threshold' });
    route({
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: 'quota exceeded',
    });
    route({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: '529',
    });
    route({ type: 'auto_retry_end', success: true, attempt: 2 });
    expect(sink.callsFor('setAgentStatus').map((c) => c[1])).toEqual([
      { pendingMessageCount: 3 },
      { isCompacting: true },
      { isCompacting: false },
      { retry: { attempt: 1, maxAttempts: 3 } },
      { retry: null },
    ]);
    // Failed compaction is a real error the user must see.
    expect(sink.callsFor('notify')).toEqual([
      ['notify', 'error', 'Compaction failed: quota exceeded'],
    ]);
  });
});

describe('helpers', () => {
  it('opFor maps tool names to workspace ops', () => {
    expect(opFor('Read')).toBe('read');
    expect(opFor('write_file')).toBe('write');
    expect(opFor('str_replace_editor')).toBe('edit');
    expect(opFor('bash')).toBeNull();
  });

  it('extractToolResultText handles the wire shapes', () => {
    expect(extractToolResultText('plain')).toBe('plain');
    expect(extractToolResultText({ text: 'direct' })).toBe('direct');
    expect(
      extractToolResultText({ content: [{ type: 'text', text: 'a' }, 'b', { type: 'image' }] }),
    ).toBe('a\nb');
    expect(extractToolResultText({ output: 'out' })).toBe('out');
    expect(extractToolResultText(undefined)).toBe('');
  });

  it('stripAnsi removes escape sequences', () => {
    expect(stripAnsi('\u001b[1;31mred\u001b[0m plain')).toBe('red plain');
  });
});
