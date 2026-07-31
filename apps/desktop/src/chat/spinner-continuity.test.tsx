// @vitest-environment jsdom
/**
 * Loader visual continuity — jedd: "spinners a lot of the time snap back to
 * their initial state constantly instead of smoothly spinning".
 *
 * The Bobble loader is a pure CSS animation, so where the arc is pointing is
 * (now − animation start) − animation-delay. jsdom can't observe the rotation
 * itself, but it CAN pin the two things that were yanking that phase around:
 *
 *   1. the delay was re-derived from the clock on EVERY render, so every status
 *      row that re-renders while a turn runs (tool name, elapsed seconds, token
 *      count) re-aimed the arc several times a second — the snapping jedd saw;
 *   2. the delay was a fresh random offset per mount, so a row that gets
 *      re-keyed as its status text changes restarted its spinner at 0°.
 *
 * Both are fixed by pinning the delay ONCE, to the document clock, so the phase
 * is a pure function of wall time. Lives in apps/desktop rather than beside the
 * component because packages/ui's vitest has no DOM (renderToStaticMarkup only)
 * and these are re-render / remount assertions.
 */
import { CanvasProvider } from '@pi-desktop/canvas';
import type { ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import { Spinner, WorkingIndicator } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityBlock } from './activity-mapping';
import { ThreadActivityChain } from './ThreadActivity';

// React's act() warns unless this flag is set in a test environment.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The pd-loader spin (1100ms) and breathe (1600ms) periods, and their lcm. */
const SPIN_MS = 1100;
const LOADER_PERIOD_MS = 17_600;

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const mounted: Mounted[] = [];

/**
 * Mount at a PINNED clock reading. performance.now is what the component reads,
 * so freezing it (rather than sampling the real clock around the render) makes
 * the phase arithmetic exact instead of racing a period wrap. Holding it
 * constant is also safe for React's scheduler: zero elapsed time never yields.
 */
async function mountAt(ms: number, node: ReactNode): Promise<HTMLElement> {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(ms);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted.push({ container, root });
  clock.mockRestore();
  return container;
}

/** Re-render an already-mounted tree with the clock moved on. */
async function rerenderAt(ms: number, container: HTMLElement, node: ReactNode): Promise<void> {
  const entry = mounted.find((m) => m.container === container);
  if (entry === undefined) throw new Error('rerenderAt: container was never mounted');
  const clock = vi.spyOn(performance, 'now').mockReturnValue(ms);
  await act(async () => {
    entry.root.render(node);
  });
  clock.mockRestore();
}

/** The loader element's animation-delay, in ms (negative = started mid-cycle). */
function delayMs(container: HTMLElement): number {
  const loader = container.querySelector('.pd-loader');
  if (!(loader instanceof HTMLElement)) throw new Error('no .pd-loader rendered');
  const raw = loader.style.getPropertyValue('--pd-loader-delay');
  expect(raw).toMatch(/^-?\d+ms$/);
  return Number.parseInt(raw, 10);
}

function loaderNode(container: HTMLElement): Element {
  const loader = container.querySelector('.pd-loader');
  if (loader === null) throw new Error('no .pd-loader rendered');
  return loader;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const m of mounted.splice(0)) {
    await act(async () => {
      m.root.unmount();
    });
    m.container.remove();
  }
});

describe('Bobble loader continuity', () => {
  it('holds its animation phase while the status text beside it changes', async () => {
    const container = await mountAt(
      4_000,
      <WorkingIndicator label="Thinking" elapsedSeconds={1} />,
    );
    const first = delayMs(container);
    const node = loaderNode(container);

    // The status row's whole reason for existing is that it churns: the label
    // swaps as the model moves tool to tool and the counter ticks every second.
    await rerenderAt(
      4_240,
      container,
      <WorkingIndicator label="Running bash" elapsedSeconds={4} />,
    );
    await rerenderAt(
      5_007,
      container,
      <WorkingIndicator label="Reading a file" elapsedSeconds={5} />,
    );
    await rerenderAt(5_998, container, <WorkingIndicator label="Editing" elapsedSeconds={6} />);

    // Same element (no remount) and the same delay: the arc kept turning.
    expect(loaderNode(container)).toBe(node);
    expect(delayMs(container)).toBe(first);
    expect(container.textContent).toContain('Editing');
  });

  it('does not re-aim the arc when unrelated props change', async () => {
    const container = await mountAt(9_100, <Spinner size={13} className="a" />);
    const first = delayMs(container);
    await rerenderAt(12_650, container, <Spinner size={13} className="b" />);
    expect(delayMs(container)).toBe(first);
  });

  it('resumes mid-turn after a remount instead of snapping back to 0deg', async () => {
    // A row re-keyed by its changing status text throws the old loader away.
    // Because the delay is clock-derived, the replacement is handed the phase
    // its predecessor would have had: exactly one spin later, same angle.
    const before = await mountAt(0, <Spinner />);
    const after = await mountAt(SPIN_MS, <Spinner />);
    expect(delayMs(before) - delayMs(after)).toBe(SPIN_MS);
  });

  it('puts every loader on one clock phase, however late it mounts', async () => {
    // A full lcm(spin, breathe) later, both animations are back where they
    // started — so the delay is identical and loaders on screen turn together.
    const early = await mountAt(2_345, <Spinner />);
    const late = await mountAt(2_345 + LOADER_PERIOD_MS, <Spinner />);
    expect(delayMs(late)).toBe(delayMs(early));
  });
});

const call = (id: string, name: string, args: Record<string, unknown>): ActivityBlock =>
  ({ type: 'toolCall', id, name, arguments: args }) as Extract<ContentBlock, { type: 'toolCall' }>;

const toolResult = (id: string, out: string): ToolResultMsg => ({
  kind: 'toolResult',
  id,
  toolCallId: id,
  toolName: 'x',
  text: out,
  isError: false,
  timestamp: 0,
});

async function renderChain(
  container: HTMLElement | undefined,
  blocks: ActivityBlock[],
  results: ToolResultMsg[],
  running: string[],
): Promise<HTMLElement> {
  const tree = (
    <CanvasProvider>
      <ThreadActivityChain
        blocks={blocks}
        resultForBlock={new Map(results.map((r) => [r.toolCallId, r]))}
        runningToolCalls={running}
        streaming
      />
    </CanvasProvider>
  );
  if (container === undefined) return mountAt(1_000, tree);
  await rerenderAt(2_500, container, tree);
  return container;
}

describe('activity chain step identity', () => {
  it('keeps a still-running row mounted when the row above it settles', async () => {
    // Two same-kind reads: the classic case where the fallback key's duplicate
    // suffix reshuffled. c1 finishes; c2 is still running and MUST keep its
    // element — its spinner is mid-turn.
    const blocks = [
      call('c1', 'read', { path: '/repo/a.ts' }),
      call('c2', 'read', { path: '/repo/b.ts' }),
    ];
    const container = await renderChain(undefined, blocks, [], ['c1', 'c2']);
    const rows = () => [...container.querySelectorAll('.pd-chain-step')];
    expect(container.querySelectorAll('.pd-loader')).toHaveLength(2);
    const runningRow = rows()[1];

    // c1 lands: its label flips tense ("Reading a file" → "Read a file") and its
    // spinner is replaced by an icon. c2 is untouched.
    await renderChain(container, blocks, [toolResult('c1', 'ok')], ['c2']);

    expect(rows()[1]).toBe(runningRow);
    expect(runningRow?.querySelectorAll('.pd-loader')).toHaveLength(1);
    // …and it is the ONLY loader left, so the settled row really did settle.
    expect(container.querySelectorAll('.pd-loader')).toHaveLength(1);
  });
});
