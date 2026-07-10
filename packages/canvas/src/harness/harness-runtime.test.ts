import { describe, expect, it } from 'vitest';
import { startHarness } from './harness-runtime.ts';
import type { FrameToHostMessage, HostToFrameMessage } from './protocol.ts';

/** A fake window whose `parent` is distinct, so source-validation is exercised. */
function fakeWindow(root: HTMLElement) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const posted: FrameToHostMessage[] = [];
  const parent = {
    postMessage: (message: FrameToHostMessage) => {
      posted.push(message);
    },
  };
  const win = {
    parent,
    document: root.ownerDocument,
    addEventListener: (type: string, cb: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.push(cb);
    },
    removeEventListener: (type: string, cb: (event: MessageEvent) => void) => {
      if (type === 'message') {
        const i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      }
    },
  };
  const deliver = (data: HostToFrameMessage | unknown, source: unknown = parent): void => {
    for (const cb of listeners.slice()) {
      cb({ data, source } as unknown as MessageEvent);
    }
  };
  return { win: win as unknown as Window, posted, deliver, listenerCount: () => listeners.length };
}

describe('startHarness', () => {
  it('announces ready and applies a patch from the parent', () => {
    const root = document.createElement('div');
    const { win, posted, deliver } = fakeWindow(root);
    startHarness(win, { root });

    expect(posted.some((m) => m.type === 'ready')).toBe(true);

    deliver({ channel: 'pd-canvas', type: 'patch', seq: 7, html: '<p id="x">hi</p>' });
    expect(root.querySelector('#x')?.textContent).toBe('hi');
    expect(posted.some((m) => m.type === 'applied' && m.seq === 7)).toBe(true);
  });

  it('ignores messages that are not from the parent window', () => {
    const root = document.createElement('div');
    const { win, deliver } = fakeWindow(root);
    startHarness(win, { root });

    deliver(
      { channel: 'pd-canvas', type: 'patch', seq: 1, html: '<p>nope</p>' },
      { notParent: true },
    );
    expect(root.querySelector('p')).toBeNull();
  });

  it('replies to a ping with ready', () => {
    const root = document.createElement('div');
    const { win, posted, deliver } = fakeWindow(root);
    startHarness(win, { root });
    posted.length = 0;
    deliver({ channel: 'pd-canvas', type: 'ping' });
    expect(posted.some((m) => m.type === 'ready')).toBe(true);
  });

  it('dispose() removes the message listener', () => {
    const root = document.createElement('div');
    const state = fakeWindow(root);
    const dispose = startHarness(state.win, { root });
    expect(state.listenerCount()).toBe(1);
    dispose();
    expect(state.listenerCount()).toBe(0);
  });
});
