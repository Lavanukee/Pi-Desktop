import { applyHtmlPatch } from './patcher.ts';
import { type FrameToHostMessage, isHostToFrameMessage, PD_CANVAS_CHANNEL } from './protocol.ts';

export interface StartHarnessOptions {
  /** Where patched content is mounted. Defaults to `win.document.body`. */
  root?: HTMLElement;
}

/**
 * Boot the in-iframe harness runtime against a window. Wires the `pd-canvas`
 * postMessage protocol to the morphdom patcher and announces readiness.
 *
 * Security: the frame runs sandboxed (`allow-scripts`, NO `allow-same-origin`)
 * so it has an opaque origin and cannot name the host origin; we therefore
 * accept messages only when `event.source === win.parent` (the embedder) rather
 * than by origin, and post replies with `targetOrigin: '*'`.
 *
 * Returns a disposer that removes the message listener.
 */
export function startHarness(win: Window, options: StartHarnessOptions = {}): () => void {
  const root = options.root ?? win.document.body;

  const post = (message: FrameToHostMessage): void => {
    win.parent.postMessage(message, '*');
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== win.parent) return;
    const data: unknown = event.data;
    if (!isHostToFrameMessage(data)) return;

    if (data.type === 'ping') {
      post({ channel: PD_CANVAS_CHANNEL, type: 'ready' });
      return;
    }
    if (data.type === 'reset') {
      root.replaceChildren();
      post({ channel: PD_CANVAS_CHANNEL, type: 'applied', seq: -1 });
      return;
    }
    // data.type === 'patch'
    try {
      applyHtmlPatch(root, data.html);
      post({ channel: PD_CANVAS_CHANNEL, type: 'applied', seq: data.seq });
      post({ channel: PD_CANVAS_CHANNEL, type: 'resize', height: root.scrollHeight });
    } catch (error) {
      post({
        channel: PD_CANVAS_CHANNEL,
        type: 'error',
        seq: data.seq,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  win.addEventListener('message', onMessage);
  // Announce readiness so the host can flush any patches queued before boot.
  post({ channel: PD_CANVAS_CHANNEL, type: 'ready' });

  return () => win.removeEventListener('message', onMessage);
}
