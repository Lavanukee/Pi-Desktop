import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  buildCanvasContext,
  CANVAS_STATE_OPEN,
  type CanvasContextMessage,
  type CanvasStateSource,
  formatCanvasSummary,
  isCanvasStateMessage,
  registerCanvasContext,
  withCanvasBlock,
} from './canvas-context.js';
import type { CanvasState } from './protocol.js';

const userMsg = (text: string): CanvasContextMessage =>
  ({ role: 'user', content: text, timestamp: 0 }) as CanvasContextMessage;
const asstMsg = (text: string): CanvasContextMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 0 }) as CanvasContextMessage;

/** A source that returns a fixed state (or throws, to exercise the catch). */
function source(state: CanvasState | null, opts: { throws?: boolean } = {}): CanvasStateSource {
  return {
    getCanvasState: async () => {
      if (opts.throws === true) throw new Error('bridge down');
      return state;
    },
  };
}

const BROWSER: CanvasState = {
  active: {
    kind: 'browser',
    tabId: 't1',
    title: 'Sandboxels',
    url: 'https://neal.fun/sandboxels/',
  },
  others: [
    { kind: 'file', filePath: 'src/App.tsx', dirty: true },
    { kind: 'terminal', cwd: '~/proj', lastCommand: 'npm test' },
  ],
};

describe('formatCanvasSummary', () => {
  it('renders the active surface + the others, wrapped in the sentinel', () => {
    const block = formatCanvasSummary(BROWSER);
    expect(block).not.toBeNull();
    expect(block).toContain(CANVAS_STATE_OPEN);
    expect(block).toContain('</canvas_state>');
    expect(block).toContain(
      'The user is looking at: Browser — "Sandboxels" (https://neal.fun/sandboxels/)',
    );
    expect(block).toContain('Also open:');
    expect(block).toContain('File src/App.tsx (unsaved)');
    expect(block).toContain('Terminal (cwd ~/proj, last: `npm test`)');
  });

  it('includes a capped excerpt when the active file has one', () => {
    const block = formatCanvasSummary({
      active: { kind: 'file', filePath: 'a.txt', excerpt: 'x'.repeat(1000) },
      others: [],
    });
    expect(block).toContain('Excerpt:');
    expect(block).toContain('…'); // clipped
    expect((block ?? '').length).toBeLessThan(500);
  });

  it('returns null for an empty canvas (nothing to inject)', () => {
    expect(formatCanvasSummary({ active: null, others: [] })).toBeNull();
  });
});

describe('withCanvasBlock / dedupe', () => {
  it('appends the block as the LAST message', () => {
    const msgs = [userMsg('hello'), asstMsg('hi there')];
    const out = withCanvasBlock(msgs, `${CANVAS_STATE_OPEN}\nx\n</canvas_state>`);
    expect(out).toHaveLength(3);
    const last = out.at(-1);
    expect(last !== undefined && isCanvasStateMessage(last)).toBe(true);
    // The original messages are untouched (non-destructive).
    expect(out.slice(0, 2)).toEqual(msgs);
  });

  it('strips a prior block before appending (never accumulates)', () => {
    const first = withCanvasBlock([userMsg('hello')], `${CANVAS_STATE_OPEN}\nA\n</canvas_state>`);
    const second = withCanvasBlock(first, `${CANVAS_STATE_OPEN}\nB\n</canvas_state>`);
    const blocks = second.filter(isCanvasStateMessage);
    expect(blocks).toHaveLength(1); // exactly one, the fresh one
    expect(JSON.stringify(blocks[0])).toContain('B');
    expect(JSON.stringify(blocks[0])).not.toContain('A');
    // Still pinned to the tail.
    const tail = second.at(-1);
    expect(tail !== undefined && isCanvasStateMessage(tail)).toBe(true);
  });

  it('only treats user-role blocks as injected (not assistant text)', () => {
    expect(isCanvasStateMessage(asstMsg(CANVAS_STATE_OPEN))).toBe(false);
    expect(isCanvasStateMessage(userMsg(`${CANVAS_STATE_OPEN} ...`))).toBe(true);
  });
});

describe('buildCanvasContext', () => {
  it('appends a fresh block when the canvas has content', async () => {
    const res = await buildCanvasContext(source(BROWSER), [userMsg('go')]);
    expect(res).toBeDefined();
    const blocks = res?.messages.filter(isCanvasStateMessage) ?? [];
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks[0])).toContain('Sandboxels');
  });

  it('dedupes across calls (feeding its own output re-yields one block)', async () => {
    const first = (await buildCanvasContext(source(BROWSER), [userMsg('go')]))?.messages ?? [];
    const second = (await buildCanvasContext(source(BROWSER), first))?.messages ?? [];
    expect(second.filter(isCanvasStateMessage)).toHaveLength(1);
  });

  it('returns undefined (no change) when there is nothing and no prior block', async () => {
    const res = await buildCanvasContext(source({ active: null, others: [] }), [userMsg('go')]);
    expect(res).toBeUndefined();
  });

  it('strips a stale block when the canvas goes empty', async () => {
    const withBlock = withCanvasBlock(
      [userMsg('go')],
      `${CANVAS_STATE_OPEN}\nold\n</canvas_state>`,
    );
    const res = await buildCanvasContext(source({ active: null, others: [] }), withBlock);
    expect(res).toBeDefined();
    expect(res?.messages.some(isCanvasStateMessage)).toBe(false);
  });

  it('never throws — a bridge failure yields no change', async () => {
    const res = await buildCanvasContext(source(null, { throws: true }), [userMsg('go')]);
    expect(res).toBeUndefined();
  });
});

describe('registerCanvasContext', () => {
  it("registers a 'context' handler that injects the block", async () => {
    const handlers: Record<string, (e: { messages: CanvasContextMessage[] }) => unknown> = {};
    const pi = {
      on: (event: string, h: (e: { messages: CanvasContextMessage[] }) => unknown) => {
        handlers[event] = h;
      },
    } as unknown as ExtensionAPI;
    registerCanvasContext(pi, source(BROWSER));
    const handler = handlers.context;
    expect(handler).toBeDefined();
    const out = (await handler?.({ messages: [userMsg('go')] })) as
      | { messages: CanvasContextMessage[] }
      | undefined;
    expect(out?.messages.some(isCanvasStateMessage)).toBe(true);
  });
});
