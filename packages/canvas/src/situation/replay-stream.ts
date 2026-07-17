/**
 * Replayable event stream — the seam that makes the situation room survive
 * remounts (docs/harness-architecture.md §11).
 *
 * A `TaskHandle.events` iterable is a SINGLE ordered pass, but the canvas
 * unmounts a tab's surface whenever another tab is focused. Wrapping the
 * handle's stream once (app-side, where the handle lives) buffers everything
 * seen so far, so every fresh subscriber first replays history — rebuilding
 * the room's state instantly — and then tails the live run. Events are small
 * DTOs; a full corp run is a few hundred of them, so buffering is cheap.
 */

import type { CoordinationEvent } from '@pi-desktop/coordination';

/**
 * Wrap a single-pass event stream into a re-iterable one. The source is
 * consumed lazily (on first iteration) and exactly once; any number of
 * concurrent or subsequent iterations replay history then follow live.
 */
export function replayableEvents(
  source: AsyncIterable<CoordinationEvent>,
): AsyncIterable<CoordinationEvent> {
  const history: CoordinationEvent[] = [];
  const waiters: Array<() => void> = [];
  let started = false;
  let ended = false;

  const notify = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  const pump = (): void => {
    if (started) return;
    started = true;
    void (async () => {
      try {
        for await (const event of source) {
          history.push(event);
          notify();
        }
      } catch {
        // A broken source simply ends the replayable stream.
      } finally {
        ended = true;
        notify();
      }
    })();
  };

  return {
    [Symbol.asyncIterator]() {
      pump();
      let cursor = 0;
      return {
        async next(): Promise<IteratorResult<CoordinationEvent>> {
          for (;;) {
            const buffered = history[cursor];
            if (buffered !== undefined) {
              cursor += 1;
              return { value: buffered, done: false };
            }
            if (ended) return { value: undefined, done: true };
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
        },
      };
    },
  };
}
