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
import { CanvasProvider } from '@pi-desktop/canvas';
import type { OrgNodeView, WorkerActivityEvent } from '@pi-desktop/coordination';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
