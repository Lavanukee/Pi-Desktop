import type { PiBridgeEvent } from '@pi-desktop/engine';
import { describe, expect, it, vi } from 'vitest';
import { type ChildBridge, createChildAgents } from './child-agents';

/** A fake child bridge that captures its onEvent and lets a test drive events. */
function fakeBridge(onEvent: (e: PiBridgeEvent) => void, pid = 1234) {
  let alive = true;
  const dispose = vi.fn(() => {
    alive = false;
  });
  const prompt = vi.fn(() => Promise.resolve());
  const bridge: ChildBridge & { emit: (e: PiBridgeEvent) => void } = {
    get alive() {
      return alive;
    },
    pid,
    ready: () => Promise.resolve(),
    prompt,
    abort: () => Promise.resolve(),
    send: () => Promise.resolve({ success: true, data: { messages: [] } }),
    whenExited: () => Promise.resolve(),
    killNow: () => {},
    dispose,
    emit: (e) => onEvent(e),
  };
  return bridge;
}

const sender = { id: 7, isDestroyed: () => false } as never;
const log = { info: () => {}, warn: () => {} };

describe('createChildAgents', () => {
  it('spawns a child, tags + forwards its events, lists it, disposes it', async () => {
    const sent: Array<{
      childId: string;
      parentId: string;
      title: string;
      event: PiBridgeEvent;
    }> = [];
    let captured: ((e: PiBridgeEvent) => void) | null = null;
    const bridge = fakeBridge((e) => captured?.(e));

    const agents = createChildAgents({
      createChildBridge: (_opts, onEvent) => {
        captured = onEvent;
        return bridge;
      },
      sendChildEvent: (_s, msg) => sent.push(msg),
      log,
    });

    const res = await agents.spawn(sender, {
      childId: 'c1',
      parentId: 'p1',
      title: 'Sub',
      goal: 'do it',
    });
    expect(res.success).toBe(true);
    expect(res.pid).toBe(1234);
    expect(bridge.prompt).toHaveBeenCalledWith('do it');

    // An event from the child is forwarded, tagged with childId/parentId.
    bridge.emit({ type: 'agent_start' } as PiBridgeEvent);
    expect(sent).toEqual([
      {
        childId: 'c1',
        parentId: 'p1',
        title: 'Sub',
        goal: 'do it',
        event: { type: 'agent_start' },
      },
    ]);

    expect(agents.list(7)).toEqual([{ childId: 'c1', parentId: 'p1', title: 'Sub' }]);
    expect(agents.list(999)).toEqual([]); // scoped to the owning window

    expect(agents.disposeChild('c1').success).toBe(true);
    expect(bridge.dispose).toHaveBeenCalled();
    expect(agents.list(7)).toEqual([]); // gone after dispose
  });

  it('reports failure when the child pi exits at startup', async () => {
    const bridge = fakeBridge(() => {});
    bridge.dispose(); // dead before ready
    const agents = createChildAgents({
      createChildBridge: () => bridge,
      sendChildEvent: () => {},
      log,
    });
    const res = await agents.spawn(sender, {
      childId: 'c2',
      parentId: 'p1',
      title: 'x',
      goal: 'g',
    });
    expect(res.success).toBe(false);
    expect(agents.list(7)).toEqual([]);
  });

  it('disposeForSender reaps only that window’s children', async () => {
    const agents = createChildAgents({
      createChildBridge: () => fakeBridge(() => {}),
      sendChildEvent: () => {},
      log,
    });
    await agents.spawn({ id: 1, isDestroyed: () => false } as never, {
      childId: 'a',
      parentId: 'p',
      title: 't',
      goal: 'g',
    });
    await agents.spawn({ id: 2, isDestroyed: () => false } as never, {
      childId: 'b',
      parentId: 'p',
      title: 't',
      goal: 'g',
    });
    agents.disposeForSender(1);
    expect(agents.list(1)).toEqual([]);
    expect(agents.list(2).map((c) => c.childId)).toEqual(['b']);
  });
});
