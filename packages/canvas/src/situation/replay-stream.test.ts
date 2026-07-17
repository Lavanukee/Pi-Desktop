import type { CoordinationEvent } from '@pi-desktop/coordination';
import { describe, expect, it } from 'vitest';
import { replayableEvents } from './replay-stream.ts';

function status(detail: string): CoordinationEvent {
  return { type: 'status', status: 'working', detail };
}

async function* slowSource(
  events: readonly CoordinationEvent[],
): AsyncGenerator<CoordinationEvent> {
  for (const event of events) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    yield event;
  }
}

async function collect(
  iterable: AsyncIterable<CoordinationEvent>,
  take?: number,
): Promise<CoordinationEvent[]> {
  const out: CoordinationEvent[] = [];
  for await (const event of iterable) {
    out.push(event);
    if (take !== undefined && out.length >= take) break;
  }
  return out;
}

describe('replayableEvents', () => {
  const events = [status('a'), status('b'), status('c')];

  it('replays full history to a late second subscriber (tab-switch remount)', async () => {
    const replayable = replayableEvents(slowSource(events));
    const first = await collect(replayable);
    expect(first).toEqual(events);
    // The source is exhausted — a plain single-pass stream would now be empty.
    const second = await collect(replayable);
    expect(second).toEqual(events);
  });

  it('lets a partial reader abandon without losing events for the next one', async () => {
    const replayable = replayableEvents(slowSource(events));
    const partial = await collect(replayable, 1);
    expect(partial).toEqual([status('a')]);
    const full = await collect(replayable);
    expect(full).toEqual(events);
  });

  it('supports two concurrent readers over one source pass', async () => {
    const replayable = replayableEvents(slowSource(events));
    const [a, b] = await Promise.all([collect(replayable), collect(replayable)]);
    expect(a).toEqual(events);
    expect(b).toEqual(events);
  });
});
