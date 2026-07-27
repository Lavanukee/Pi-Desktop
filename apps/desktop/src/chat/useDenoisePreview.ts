/**
 * The renderer's subscription to live denoising frames.
 *
 * ## Correlating a frame with the tool row that is waiting for it
 * A `gen3d:job` preview carries a jobId, and the chat's `generate_image` tool
 * row carries a toolCallId; nothing connects the two, and plumbing a shared id
 * would mean threading a new field through the tool → app bridge → sidecar →
 * worker → event stream, five layers deep, to identify something there is only
 * ever one of.
 *
 * Because there IS only ever one. The engine refuses to start a second job
 * while one is running — a hard 24 GB invariant enforced in gen3d-main's
 * `runImageJob` (`jobPlans.size > 0` → "only one runs at a time on this
 * machine") and mirrored by the sidecar's single worker. So "the in-flight
 * image job" and "the in-flight generate_image tool call" are the same event by
 * construction, and matching them by liveness is exact rather than a guess.
 *
 * The guard that keeps it exact: only a MOUNTED placeholder subscribes, and the
 * chat mounts one only while an image tool row is actually running. A
 * generation the user started in the 3D studio's Image panel therefore animates
 * nothing in the chat — there is no chat row waiting on it — even though it
 * publishes the same preview events.
 *
 * ## Why this is a plain function and not a hook
 * It used to be `useDenoisePreview`, holding the frames in React state. That
 * put a `setState` on the render path of every arriving frame, which re-rendered
 * the whole assistant group — markdown, the activity chain, everything — five
 * times per image, and remounted the frame elements each time. jedd saw the
 * result as a flash across the window on every step. The frames now drive the
 * DOM directly (see ThreadImagePlaceholder), so nothing about a new frame
 * reaches React at all.
 */

import type { Gen3dJobPreview } from '../../electron/gen3d/gen3d-contract';

export interface DenoiseListener {
  readonly onFrame: (jobId: string, preview: Gen3dJobPreview) => void;
  readonly onDone: (jobId: string) => void;
}

/** Listen to the live denoise stream. Returns an unsubscribe, or null when
 * there is no app bridge (a browser-hosted render of the chat). */
export function subscribeToDenoise(listener: DenoiseListener): (() => void) | null {
  const bridge = window.piDesktop;
  if (bridge === undefined) return null;
  return bridge.onEvent('gen3d:job', (update) => {
    if (update.preview !== undefined) {
      listener.onFrame(update.jobId, update.preview);
      return;
    }
    // Keep the last frame on screen and let the card settle at fully resolved
    // rather than freezing mid-tween while the finished PNG loads.
    if (update.done) listener.onDone(update.jobId);
  });
}
