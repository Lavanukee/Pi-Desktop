import { describe, expect, it } from 'vitest';
import type { HostToFrameMessage } from '../harness/protocol.ts';
import { HtmlSurfaceController } from './html-surface.tsx';

function collector() {
  const posted: HostToFrameMessage[] = [];
  const controller = new HtmlSurfaceController({ postToFrame: (m) => posted.push(m) });
  return { posted, controller };
}

describe('HtmlSurfaceController', () => {
  it('buffers HTML until the frame reports ready, then flushes the latest', () => {
    const { posted, controller } = collector();
    controller.setHtml('<p>1</p>');
    expect(posted).toHaveLength(0);
    expect(controller.isReady).toBe(false);

    controller.handleFrameMessage({ channel: 'pd-canvas', type: 'ready' });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'patch', seq: 1, html: '<p>1</p>' });
  });

  it('coalesces bursts before ready to a single newest snapshot', () => {
    const { posted, controller } = collector();
    controller.setHtml('a');
    controller.setHtml('b');
    controller.setHtml('c');
    controller.handleFrameMessage({ channel: 'pd-canvas', type: 'ready' });
    const patches = posted.filter((m) => m.type === 'patch');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ html: 'c', seq: 1 });
  });

  it('sends immediately and increments seq once ready', () => {
    const { posted, controller } = collector();
    controller.handleFrameMessage({ channel: 'pd-canvas', type: 'ready' });
    controller.setHtml('one');
    controller.setHtml('two');
    expect(posted.filter((m) => m.type === 'patch')).toMatchObject([
      { html: 'one', seq: 1 },
      { html: 'two', seq: 2 },
    ]);
    expect(controller.lastSeq).toBe(2);
  });

  it('ignores non-protocol frame messages', () => {
    const { posted, controller } = collector();
    controller.handleFrameMessage({ nope: true });
    controller.setHtml('x');
    expect(posted).toHaveLength(0);
  });
});
