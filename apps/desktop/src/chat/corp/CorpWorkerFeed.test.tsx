// @vitest-environment jsdom
/**
 * CorpWorkerFeed renders a watched corp agent through the EXACT pipeline the
 * normal chat uses ({@link AssistantGroup} → `segmentGroup` → `Markdown` +
 * `ThreadActivityChain`), so `message` lines look IDENTICAL to a Pi reply:
 *
 *  A. prose renders through `<Markdown>` (react-markdown) — real formatting,
 *     NOT a raw `whitespace-pre-wrap` span.
 *  B. a message that IS a JSON payload fences to a ```json CodeBlock through
 *     Markdown (pretty-printed when the model emitted a minified one-liner) —
 *     never a raw blob, never leaked fence backticks.
 *  C. a STREAMING brace-led tail (unparseable mid-stream) still fences.
 *  D. settled text that merely STARTS with a brace but is not JSON stays prose.
 *
 * A tool call the local model wrote as raw TEXT (the qwen grammar-failure shape)
 * splits out into a real activity ROW — the same ActivityChain the normal chat
 * uses — not a raw XML/JSON wall or a code block (display-only; never executed).
 *
 * Mounted with the repo's plain react-dom + act() pattern (no testing library).
 */
import { CanvasProvider } from '@pi-desktop/canvas';
import type { WorkerTranscriptView } from '@pi-desktop/coordination';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { CorpWorkerFeed } from './CorpWorkerPane';

// React's act() warns unless this flag is set in a test environment.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface RenderResult {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

/** Mount a React node into a jsdom container, flushing effects via act(). */
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

/** A transcript around the given lines (briefing chrome is not under test). */
function transcript(lines: WorkerTranscriptView['lines']): WorkerTranscriptView {
  return {
    nodeId: 'mgr',
    role: 'manager',
    briefing: {
      workerName: 'Build plan',
      roleLine: 'Area lead · Engine',
      title: 'Plan the engine build',
      goal: 'Split the engine into contracts and hand them out.',
      deliverables: ['contracts'],
    },
    lines,
  };
}

// The activity chain calls useCanvasTabs(), so every feed mounts under a provider
// (exactly like the real chat, which lives inside the app's CanvasProvider).
function feed(lines: WorkerTranscriptView['lines'], working = false) {
  return (
    <CanvasProvider>
      <CorpWorkerFeed
        transcript={transcript(lines)}
        working={working}
        loading={false}
        nodeState={working ? 'working' : 'done'}
      />
    </CanvasProvider>
  );
}

const MINIFIED_JSON =
  '{"contract":"emitter","files":["src/engine/emitter.ts"],"depends_on":["state"]}';

describe('CorpWorkerFeed — message lines render like the normal chat', () => {
  it('renders prose through Markdown, not a raw pre-wrap span', async () => {
    const { container, unmount } = await render(
      feed([
        {
          at: 0,
          kind: 'message',
          text: 'Splitting into **three contracts** with `emitter` first.',
        },
      ]),
    );
    // The design-system Markdown container is on screen…
    expect(container.querySelector('.pd-markdown')).not.toBeNull();
    // …with REAL formatting: bold became <strong>, backticks became <code>.
    expect(container.querySelector('.pd-markdown strong')?.textContent).toBe('three contracts');
    expect(container.querySelector('.pd-markdown code')?.textContent).toBe('emitter');
    expect(container.textContent).not.toContain('**');
    // The old raw-span path is gone.
    expect(container.querySelector('span.whitespace-pre-wrap')).toBeNull();
    await unmount();
  });

  it('renders a settled minified JSON message as a pretty-printed json CodeBlock, never a raw blob', async () => {
    const { container, unmount } = await render(
      feed([{ at: 0, kind: 'message', text: MINIFIED_JSON }]),
    );
    const block = container.querySelector('.pd-code-block');
    expect(block).not.toBeNull();
    expect(block?.querySelector('.pd-code-block-lang')?.textContent).toBe('json');
    // Pretty-printed inside the block (the one-liner gained indentation)…
    const code = block?.querySelector('pre code')?.textContent ?? '';
    expect(code).toContain('\n  "contract": "emitter"');
    // …and neither the raw span nor the fence backticks leak into the feed.
    expect(container.querySelector('span.whitespace-pre-wrap')).toBeNull();
    expect(container.textContent).not.toContain('```');
    await unmount();
  });

  it('keeps a still-streaming (unparseable) brace-led tail inside the json CodeBlock', async () => {
    const { container, unmount } = await render(
      feed(
        [
          {
            at: 0,
            kind: 'message',
            text: '{"contract":"emitter","files":["src/en',
            streaming: true,
          },
        ],
        true,
      ),
    );
    const block = container.querySelector('.pd-code-block');
    expect(block).not.toBeNull();
    expect(block?.querySelector('.pd-code-block-lang')?.textContent).toBe('json');
    expect(block?.querySelector('pre code')?.textContent).toContain('"contract"');
    await unmount();
  });

  it('renders a LARGE settled payload as a plain (pretty-printed) json code block', async () => {
    const big = JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({
        contract: `part-${i}`,
        files: [`src/engine/part-${i}.ts`],
      })),
    );
    const { container, unmount } = await render(feed([{ at: 0, kind: 'message', text: big }]));
    // Identical to the normal chat rendering a fenced block: a json CodeBlock,
    // NOT a raw blob (the old corp-only "Structured output" details reveal is gone).
    const block = container.querySelector('.pd-code-block');
    expect(block).not.toBeNull();
    expect(block?.querySelector('.pd-code-block-lang')?.textContent).toBe('json');
    expect(container.querySelector('[data-testid="corp-structured-output"]')).toBeNull();
    expect(container.textContent).not.toContain('```');
    await unmount();
  });

  it('renders settled brace-led text that is NOT JSON as ordinary prose', async () => {
    const text = '{spec: the emitter owns particle lifetimes, not the loop}';
    const { container, unmount } = await render(feed([{ at: 0, kind: 'message', text }]));
    expect(container.querySelector('.pd-code-block')).toBeNull();
    expect(container.querySelector('.pd-markdown')?.textContent).toContain(
      'the emitter owns particle lifetimes',
    );
    await unmount();
  });
});

/**
 * A tool call the local model wrote as raw TEXT (the server's grammar failed to
 * parse it into a structured frame) must render as a proper tool-call ROW — the
 * same ActivityChain look the feed uses for parsed tool calls — not a raw
 * XML/JSON wall or a fenced code block. Display-only salvage: never executes.
 */
describe('CorpWorkerFeed — a tool-call written as TEXT renders as a tool-call row', () => {
  // The exact Qwen/Hermes XML the model emits as text when the jinja grammar fails
  // (the `<parameter=…>` child shape the shared repair parser now covers).
  const PARAM_XML = [
    '<tool_call>',
    '<function=write>',
    '<parameter=path>',
    'src/x.ts',
    '</parameter>',
    '<parameter=content>',
    'export function f() { return { ok: true }; }',
    '</parameter>',
    '</function>',
  ].join('\n');

  it('renders a <function=write><parameter=…> call as an edit row for x.ts, not raw XML', async () => {
    const { container, unmount } = await render(
      feed([{ at: 0, kind: 'message', text: PARAM_XML }]),
    );
    // A real feed tool-call/file row: an ActivityChain carrying a file (edit) step.
    const step = container.querySelector('.pd-chain-step[data-kind="edit"]');
    expect(step).not.toBeNull();
    // The filename shows on the subline as its basename (matches the feed's file rows).
    expect(step?.querySelector('.pd-chain-step-subline')?.textContent).toBe('x.ts');
    // NOT a raw XML wall, and NOT a fenced code dump of the file content.
    expect(container.textContent).not.toContain('<function=write>');
    expect(container.textContent).not.toContain('<parameter=');
    expect(container.querySelector('.pd-code-block')).toBeNull();
    await unmount();
  });

  it('renders a <function=write>{json} call (shared repair parser path) as a tool-call row', async () => {
    const jsonBody =
      '<function=write>{"path":"src/menu.ts","content":"export const x = 1;\\nexport const y = 2;\\n"}</function>';
    const { container, unmount } = await render(feed([{ at: 0, kind: 'message', text: jsonBody }]));
    const step = container.querySelector('.pd-chain-step[data-kind="edit"]');
    expect(step).not.toBeNull();
    expect(step?.querySelector('.pd-chain-step-subline')?.textContent).toBe('menu.ts');
    expect(container.querySelector('.pd-code-block')).toBeNull();
    await unmount();
  });

  it('leaves a normal prose message as Markdown — no tool-call row', async () => {
    const { container, unmount } = await render(
      feed([
        {
          at: 0,
          kind: 'message',
          text: 'Splitting the work; the writer owns `src/x.ts` and the loop.',
        },
      ]),
    );
    expect(container.querySelector('.pd-chain-step[data-kind="edit"]')).toBeNull();
    expect(container.querySelector('.pd-markdown')).not.toBeNull();
    // Real Markdown formatting survived (backticks → inline code).
    expect(container.querySelector('.pd-markdown code')?.textContent).toBe('src/x.ts');
    await unmount();
  });

  it('keeps a STILL-STREAMING (incomplete) tool-call tag as live text, not a row', async () => {
    const partial = '<tool_call>\n<function=write>\n<parameter=path>\nsrc/x.ts';
    const { container, unmount } = await render(
      feed([{ at: 0, kind: 'message', text: partial, streaming: true }], true),
    );
    // Mid-stream the tag is incomplete/unparseable — we keep the live text, no
    // flicker into a tool-call row until it settles.
    expect(container.querySelector('.pd-chain-step[data-kind="edit"]')).toBeNull();
    expect(container.querySelector('.pd-markdown')).not.toBeNull();
    await unmount();
  });
});
