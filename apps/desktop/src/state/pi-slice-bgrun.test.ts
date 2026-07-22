/**
 * Background-run event routing (step 4 core): while a chat streams in the BACKGROUND
 * (the user is viewing another), the sink must write its thread events into
 * `bgRun.messages`, NOT the viewed `messages` — otherwise a backgrounded turn's
 * tokens leak into the chat you're looking at. This pins that redirect + the
 * agent-end "mark the bg run done" behavior, and confirms the normal (no bg) path is
 * unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type BgRun, createPiSink, usePiStore } from './pi-slice';

const userMsg = (text: string) => ({ kind: 'user' as const, id: `u-${text}`, text, timestamp: 1 });
const bg = (over: Partial<BgRun> = {}): BgRun => ({
  sessionFile: '/chat/A.jsonl',
  messages: [userMsg('A prompt')],
  streaming: true,
  title: 'Chat A',
  ...over,
});
const flat = (msgs: unknown[]) => JSON.stringify(msgs);

beforeEach(() => {
  usePiStore.setState({ messages: [userMsg('viewed B')], bgRun: null, runningToolCalls: [] });
});

describe('sink thread routing with a background run', () => {
  it('routes a streaming reply into the background buffer, leaving the view untouched', () => {
    usePiStore.setState({ bgRun: bg() });
    const sink = createPiSink();
    sink.beginAssistantTurn('a1');
    sink.appendTextDelta('a1', 'hello from the backgrounded chat');
    sink.appendThinkingDelta('a1', ' (thinking)');

    const st = usePiStore.getState();
    // Landed in the bg buffer…
    expect(flat(st.bgRun?.messages ?? [])).toContain('hello from the backgrounded chat');
    expect(flat(st.bgRun?.messages ?? [])).toContain('(thinking)');
    // …and NOT in the viewed thread.
    expect(flat(st.messages)).not.toContain('hello from the backgrounded chat');
    expect(flat(st.messages)).toContain('viewed B');
  });

  it('routes a tool result into the background buffer too', () => {
    usePiStore.setState({ bgRun: bg() });
    const sink = createPiSink();
    sink.upsertToolResult({
      kind: 'toolResult',
      id: 'tr1',
      toolCallId: 'c1',
      toolName: 'bash',
      text: 'bg tool output',
      isError: false,
      timestamp: 1,
    });
    const st = usePiStore.getState();
    expect(flat(st.bgRun?.messages ?? [])).toContain('bg tool output');
    expect(flat(st.messages)).not.toContain('bg tool output');
  });

  it('agentEnd marks the background run done (spinner → finished notice) but keeps its buffer', () => {
    usePiStore.setState({
      bgRun: bg({
        messages: [
          userMsg('A'),
          {
            kind: 'assistant',
            id: 'a1',
            blocks: [{ type: 'text', text: 'done reply' }],
            timestamp: 1,
            isStreaming: true,
          },
        ],
      }),
    });
    createPiSink().agentEnd();
    const st = usePiStore.getState();
    expect(st.bgRun?.streaming).toBe(false);
    expect(flat(st.bgRun?.messages ?? [])).toContain('done reply');
  });

  it('once the bg run is no longer streaming, writes fall back to the viewed thread', () => {
    usePiStore.setState({ bgRun: bg({ streaming: false }) });
    const sink = createPiSink();
    sink.beginAssistantTurn('a2');
    sink.appendTextDelta('a2', 'this belongs to the view');
    const st = usePiStore.getState();
    expect(flat(st.messages)).toContain('this belongs to the view');
    expect(flat(st.bgRun?.messages ?? [])).not.toContain('this belongs to the view');
  });

  it('with NO background run, the normal path writes the viewed thread (unchanged)', () => {
    const sink = createPiSink();
    sink.beginAssistantTurn('a3');
    sink.appendTextDelta('a3', 'normal single-chat reply');
    const st = usePiStore.getState();
    expect(flat(st.messages)).toContain('normal single-chat reply');
    expect(st.bgRun).toBeNull();
  });
});
