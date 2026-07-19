// @vitest-environment jsdom
/**
 * CorpChatStream streams a watched corp agent through the EXACT pipeline the
 * normal chat uses ({@link AssistantGroup}), driven by the PUSHED per-node block
 * accumulator (corp-store), NOT a poll:
 *
 *  A. an assistant-text block grows from pushed deltas and renders through the
 *     app's `<Markdown>` — a growing tail formats live, per token.
 *  B. a live "Thinking…" block renders as an ActivityChain WITH its left rail
 *     while it streams (bug 4) — the round-6-unify shape, not a component that
 *     appears only once the thought settles.
 *  C. a live file edit renders as the chain's edit row with its +N readout.
 *  D. the full sequence [thinking, a `<function=write>` text-form call, a
 *     `<function=bash>` written inside a Thought, then more text] renders a
 *     "writing src/x.ts +N" edit row (NOT a code block) and a bash row (NOT raw
 *     markup) — and, critically, appending new blocks NEVER re-mounts the
 *     existing chain (bug 1: no scroll-to-top): a DOM sentinel set on the first
 *     chain survives every subsequent delta.
 *
 * Mounted with the repo's plain react-dom + act() pattern (no testing library).
 */
import { CanvasProvider, createCanvasController } from '@pi-desktop/canvas';
import type { OrgNodeView, WorkerActivityEvent } from '@pi-desktop/coordination';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCorpStore } from '../../state/corp-store';
import { CorpChatStream } from './CorpChatStream';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The transcript/peek IPC is stubbed to return nothing — the live body comes from
// the PUSH accumulator, so the fetch is only the (empty) briefing/fallback source.
beforeEach(() => {
  (window as unknown as { piDesktop: unknown }).piDesktop = {
    invoke: () => Promise.resolve({ transcript: null, peek: null }),
  };
  useCorpStore.getState().setTask('t1');
});

afterEach(() => {
  useCorpStore.getState().setTask(null);
});

interface RenderResult {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

async function render(node: ReactNode): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const CEO: OrgNodeView = { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' };

function stream(node: OrgNodeView = CEO): ReactNode {
  return (
    <CanvasProvider>
      <CorpChatStream taskId="t1" node={node} />
    </CanvasProvider>
  );
}

/** Push one worker-activity delta into the ceo node's accumulator (inside act). */
async function push(...events: Omit<WorkerActivityEvent, 'type' | 'nodeId'>[]): Promise<void> {
  await act(async () => {
    for (const e of events) {
      useCorpStore.getState().foldWorkerActivity({ type: 'worker-activity', nodeId: 'ceo', ...e });
    }
  });
}

describe('CorpChatStream — pushed deltas stream like the normal chat', () => {
  it('grows an assistant-text block from pushed deltas and renders it via <Markdown>', async () => {
    await push(
      { kind: 'text', phase: 'start' },
      { kind: 'text', phase: 'delta', delta: 'Hello ' },
      { kind: 'text', phase: 'delta', delta: '**world**' },
    );

    // The accumulator grew ONE text block from the three deltas.
    const blocks = useCorpStore.getState().workerBlocks.ceo ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'text', text: 'Hello **world**', streaming: true });

    const { container, unmount } = await render(stream());
    // Rendered through the design-system Markdown (NOT a raw pre-wrap span)…
    const md = container.querySelector('.pd-markdown');
    expect(md).not.toBeNull();
    // …with REAL formatting (the streamed **world** became <strong>).
    expect(md?.querySelector('strong')?.textContent).toBe('world');
    expect(container.querySelector('span.whitespace-pre-wrap')).toBeNull();
    await unmount();
  });

  it('renders a live "Thinking…" run as an ActivityChain WITH its rail while streaming', async () => {
    await push(
      { kind: 'thinking', phase: 'start' },
      { kind: 'thinking', phase: 'delta', delta: 'weighing the approach' },
    );

    const { container, unmount } = await render(stream());
    // The thinking run is a real ActivityChain — force-expanded while it streams,
    // so its left connector RAIL (`.pd-chain-steps`, whose ::before is the rail)
    // is on screen mid-thought, not only once the thought settles.
    const chain = container.querySelector('.pd-chain');
    expect(chain).not.toBeNull();
    expect(chain?.getAttribute('data-expanded')).toBe('true');
    expect(container.querySelector('.pd-chain-steps')).not.toBeNull();
    const thinkingStep = container.querySelector('.pd-chain-step[data-kind="thinking"]');
    expect(thinkingStep).not.toBeNull();
    // The live thought text streams inside the step (un-clamped).
    expect(container.querySelector('.pd-chain-thought')?.textContent).toContain(
      'weighing the approach',
    );
    // The old standalone thinking block (which lacked the rail while streaming) is gone.
    expect(container.querySelector('.pd-thinking')).toBeNull();
    await unmount();
  });

  it('shows a live file edit as an edit row with its +N readout', async () => {
    await push({ kind: 'file', path: 'src/x.ts', label: 'Writing', addedLines: 5 });

    const { container, unmount } = await render(stream());
    // A real chain edit row carrying the filename…
    const step = container.querySelector('.pd-chain-step[data-kind="edit"]');
    expect(step).not.toBeNull();
    expect(step?.querySelector('.pd-chain-step-subline')?.textContent).toBe('x.ts');
    // …with the +N line-count readout counting the reported delta.
    expect(container.textContent).toContain('+5');
    // NOT a fenced code dump of the file.
    expect(container.querySelector('.pd-code-block')).toBeNull();
    await unmount();
  });

  it('shows a live "Working…" indicator when the node is working but nothing streams', async () => {
    // A SETTLED assistant paragraph while the node is still working (one turn
    // ended; the next ~48s-later turn hasn't started) — nothing is streaming, so
    // the feed must show a live working indicator, never sit on a frozen frame.
    await push(
      { kind: 'text', phase: 'start' },
      { kind: 'text', phase: 'delta', delta: 'Here is the plan.' },
      { kind: 'text', phase: 'end' },
    );
    const { container, unmount } = await render(stream());
    const action = container.querySelector('[data-testid="corp-current-action"]');
    expect(action).not.toBeNull();
    expect(action?.textContent).toContain('Working');
    await unmount();
  });

  it('B3: a working coordinator lead reads "waiting for other subagents to finish", not a bare Working…', async () => {
    const MGR: OrgNodeView = { id: 'mgr', role: 'manager', name: 'Build plan', state: 'working' };
    // A promoted run (team formed) so the manager is coordinating, not producing.
    await act(async () => {
      useCorpStore.getState().foldEvent({
        type: 'org-chart',
        chart: {
          taskId: 't1',
          nodes: [
            { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' },
            MGR,
            { id: 'eng', role: 'engineer', name: 'HUD', parentId: 'mgr', state: 'working' },
          ],
          edges: [],
        },
      });
      for (const e of [
        { kind: 'text', phase: 'start' } as const,
        { kind: 'text', phase: 'delta', delta: 'Contracts written.' } as const,
        { kind: 'text', phase: 'end' } as const,
      ]) {
        useCorpStore
          .getState()
          .foldWorkerActivity({ type: 'worker-activity', nodeId: 'mgr', ...e });
      }
    });
    const { container, unmount } = await render(stream(MGR));
    const action = container.querySelector('[data-testid="corp-current-action"]');
    expect(action?.textContent).toContain('waiting for other subagents to finish');
    expect(action?.textContent).not.toContain('Working…');
    await unmount();
  });

  it('A3: history mode preserves the vision text but shows NO live working tail', async () => {
    // The CEO formed its vision (a settled paragraph) and is still "working"
    // (coordinating). Rendered as history beneath the "Waiting for N…" indicator, it
    // keeps its text on screen but must not sprout its own live tail.
    await push(
      { kind: 'text', phase: 'start' },
      { kind: 'text', phase: 'delta', delta: 'Here is the plan for Breakout.' },
      { kind: 'text', phase: 'end' },
    );
    const { container, unmount } = await render(
      <CanvasProvider>
        <CorpChatStream taskId="t1" node={CEO} historyMode />
      </CanvasProvider>,
    );
    expect(container.querySelector('.pd-markdown')?.textContent).toContain(
      'Here is the plan for Breakout.',
    );
    // No "Working…"/waiting tail of its own (the live signal is the sibling indicator).
    expect(container.querySelector('[data-testid="corp-current-action"]')).toBeNull();
    await unmount();
  });

  it('A3: history mode renders nothing when the lead produced no vision yet', async () => {
    const { container, unmount } = await render(
      <CanvasProvider>
        <CorpChatStream taskId="t1" node={CEO} historyMode />
      </CanvasProvider>,
    );
    expect(container.querySelector('[data-testid="corp-chat-stream"]')).toBeNull();
    await unmount();
  });

  it('hides the working indicator WHILE text streams (the streaming tail is the live signal)', async () => {
    await push(
      { kind: 'text', phase: 'start' },
      { kind: 'text', phase: 'delta', delta: 'Streaming the answer' },
    );
    const { container, unmount } = await render(stream());
    // A streaming tail is on screen (the Markdown), so no separate indicator.
    expect(container.querySelector('[data-testid="corp-current-action"]')).toBeNull();
    await unmount();
  });

  it('renders [thinking → write → bash-in-thought → text] as real rows and never re-mounts the chain', async () => {
    const content = Array.from({ length: 50 }, (_, i) => `const a${i} = ${i};`).join('\n');
    const writeXml = [
      '<tool_call>',
      '<function=write>',
      '<parameter=path>',
      'src/x.ts',
      '</parameter>',
      '<parameter=content>',
      content,
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');
    const bashThought = [
      'Now run it.',
      '<tool_call>',
      '<function=bash>',
      '<parameter=command>',
      'node src/x.ts',
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');

    // Phase 1: a live thought only.
    await push(
      { kind: 'thinking', phase: 'start' },
      { kind: 'thinking', phase: 'delta', delta: 'Planning the file.' },
    );
    const { container, unmount } = await render(stream());
    const firstChain = container.querySelector('.pd-chain');
    expect(firstChain).not.toBeNull();
    // Tag the LIVE first chain with a sentinel React never manages: if it survives
    // every later delta, the chain was reconciled in place (never re-mounted).
    firstChain?.setAttribute('data-corp-sentinel', 'keep');

    // Phase 2: settle the thought, then a write call, a bash-in-thought, and text.
    await push({ kind: 'thinking', phase: 'end' });
    await push(
      { kind: 'text', phase: 'start' },
      { kind: 'text', phase: 'delta', delta: writeXml },
      { kind: 'text', phase: 'end' },
    );
    await push(
      { kind: 'thinking', phase: 'start' },
      { kind: 'thinking', phase: 'delta', delta: bashThought },
      { kind: 'thinking', phase: 'end' },
    );
    await push(
      { kind: 'text', phase: 'start' },
      { kind: 'text', phase: 'delta', delta: 'Done — files written.' },
      { kind: 'text', phase: 'end' },
    );

    // The write rendered as an EDIT row (writing src/x.ts) with its +N (50 lines
    // of content) — NOT a fenced code block dumping the file.
    const editStep = container.querySelector('.pd-chain-step[data-kind="edit"]');
    expect(editStep).not.toBeNull();
    expect(editStep?.querySelector('.pd-chain-step-subline')?.textContent).toBe('x.ts');
    expect(container.textContent).toContain('+50');
    // The write is a chain edit row, NOT a fenced code block leaked into the
    // assistant prose (the bug). A bash command's own CodeBlock lives under
    // `.pd-chain`, so scope the anti-dump check to markdown text.
    expect(container.querySelector('.pd-markdown .pd-code-block')).toBeNull();

    // The bash written inside a Thought rendered as a BASH row — never raw markup.
    expect(container.querySelector('.pd-chain-step[data-kind="bash"]')).not.toBeNull();
    expect(container.textContent).not.toContain('<function=bash>');
    expect(container.textContent).not.toContain('<parameter=');

    // The trailing prose rendered through Markdown.
    expect(container.querySelector('.pd-markdown')?.textContent).toContain('Done — files written.');

    // CRITICAL (bug 1): the first chain's DOM node is the SAME one — appending all
    // those blocks reconciled the chain in place instead of re-mounting the whole
    // chain (which reset scroll to the top). The sentinel proves the node persisted.
    const kept = container.querySelector('[data-corp-sentinel="keep"]');
    expect(kept).not.toBeNull();
    expect(kept?.classList.contains('pd-chain')).toBe(true);
    expect(kept).toBe(container.querySelector('.pd-chain'));
    await unmount();
  });
});

/**
 * J3: the corp feed is text / thoughts / tool-call rows ONLY. An inline artifact
 * widget (a ```html/```svg preview — the live "Core Game Implementation" black box)
 * must NOT render inline in the corp chat; it opens in the CANVAS instead, routed
 * from the same stream. The surrounding markdown/tool rows stay in the feed.
 */
describe('CorpChatStream — J3: inline artifacts open in the canvas, never inline', () => {
  it('suppresses a corp ```html artifact inline and routes it to a canvas tab', async () => {
    const controller = createCanvasController();
    // The CEO writes its vision with an inline HTML preview fence (the black box).
    await push(
      { kind: 'text', phase: 'start' },
      {
        kind: 'text',
        phase: 'delta',
        delta: '# Core Game Implementation\n\n```html\n<div id="game">Breakout</div>\n```\n',
      },
      { kind: 'text', phase: 'end' },
    );
    const { container, unmount } = await render(
      <CanvasProvider controller={controller}>
        <CorpChatStream taskId="t1" node={CEO} />
      </CanvasProvider>,
    );
    // No inline artifact widget (the black box) anywhere in the corp feed…
    expect(container.querySelector('[data-testid="inline-artifacts"]')).toBeNull();
    // …the prose header still renders as plain markdown text in the feed…
    expect(container.querySelector('.pd-markdown')?.textContent).toContain(
      'Core Game Implementation',
    );
    // …and the artifact was ROUTED to a canvas HTML tab (keyed by the stable id),
    // carrying the live preview source — it opens in the canvas, not the chat.
    const tab = controller.getState().tabs.find((t) => t.key === 'corp-a0');
    expect(tab).not.toBeUndefined();
    expect(tab?.kind).toBe('html');
    expect(tab?.artifact?.content.text).toContain('<div id="game">Breakout</div>');
    await unmount();
  });
});

/**
 * J4: the lead (CEO/root) keeps STREAMING through the vision→promotion hand-off.
 * Once the team forms, the lead renders in history mode — but its post-vision tool
 * calls (submit_vision → create_production_hierarchy) must still render as a LIVE
 * activity row, never a bare settled header with dead air beneath it. Its own idle
 * "Working…" tail stays suppressed (the sibling "Waiting for N…" indicator owns it).
 */
describe('CorpChatStream — J4: the lead streams through the vision→promotion gap', () => {
  it('renders the lead post-vision tool calls LIVE in history mode, not a bare header', async () => {
    // Promote the run (a team formed) — the lead now renders in history mode.
    await act(async () => {
      useCorpStore.getState().foldEvent({
        type: 'org-chart',
        chart: {
          taskId: 't1',
          nodes: [
            { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' },
            { id: 'mgr', role: 'manager', name: 'Build', parentId: 'ceo', state: 'working' },
          ],
          edges: [],
        },
      });
    });
    // The CEO forms its vision (settled), THEN calls create_production_hierarchy.
    await push(
      { kind: 'text', phase: 'start' },
      { kind: 'text', phase: 'delta', delta: '# Core Game Implementation' },
      { kind: 'text', phase: 'end' },
      { kind: 'tool', toolName: 'create_production_hierarchy' },
    );
    const { container, unmount } = await render(
      <CanvasProvider>
        <CorpChatStream taskId="t1" node={CEO} historyMode />
      </CanvasProvider>,
    );
    // The vision header still renders as history…
    expect(container.querySelector('.pd-markdown')?.textContent).toContain(
      'Core Game Implementation',
    );
    // …AND the post-vision tool call renders as a LIVE chain row (expanded/active),
    // not a dead settled title — the lead's stream is continuous through the gap.
    expect(container.querySelector('.pd-chain-step[data-kind="tool"]')).not.toBeNull();
    expect(container.querySelector('.pd-chain')?.getAttribute('data-expanded')).toBe('true');
    // But NO idle "Working…"/waiting tail of its own (A3 preserved — the
    // "Waiting for N…" indicator carries the coordinating signal).
    expect(container.querySelector('[data-testid="corp-current-action"]')).toBeNull();
    await unmount();
  });
});

/**
 * J1: the user-facing "Processing…" indicator (the chat equivalent of the dev HUD's
 * stall detector). While the node is working but no token has streamed for a beat
 * (a prefill / slow-tool gap), a "Processing… Ns" indicator appears directly below
 * the latest step; it hides again the moment tokens stream (the streaming tail IS
 * the live signal then).
 */
describe('CorpChatStream — J1: a "Processing…" indicator fills a prefill/stall gap', () => {
  it('appears when active+idle below the latest step, and hides while streaming', async () => {
    vi.useFakeTimers();
    try {
      // The latest step is a tool call; the node is working; nothing streams.
      await push({ kind: 'tool', toolName: 'create_production_hierarchy' });
      const { container, unmount } = await render(stream());
      // A delta just landed — no stall yet.
      expect(container.querySelector('[data-testid="corp-processing"]')).toBeNull();
      // Advance past the stall threshold with NO new deltas → "Processing… Ns".
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      const proc = container.querySelector('[data-testid="corp-processing"]');
      expect(proc).not.toBeNull();
      expect(proc?.textContent).toContain('Processing');
      expect(proc?.textContent).toMatch(/\d+s/);
      // It sits as the tail beneath the latest tool-call row (the chain is above it).
      expect(container.querySelector('.pd-chain')).not.toBeNull();
      // A fresh streaming delta clears the stall → the indicator hides.
      await push(
        { kind: 'text', phase: 'start' },
        { kind: 'text', phase: 'delta', delta: 'Back to work.' },
      );
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(container.querySelector('[data-testid="corp-processing"]')).toBeNull();
      await unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
