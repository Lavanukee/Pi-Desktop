import { describe, expect, it } from 'vitest';
import { JobQueue, type JobRunner, type JobStatus } from './job-queue.ts';
import type { GenJob, GenOutput } from './protocol.ts';

function imageJob(id: string): GenJob {
  return {
    id,
    modality: 'image',
    backend: 'mflux',
    outputDir: `/out/${id}`,
    image: {
      prompt: 'x',
      modelId: 'z-image-turbo',
      mfluxCommand: 'mflux-generate-z-image-turbo',
      seeds: [1],
    },
  };
}

function output(id: string): GenOutput[] {
  return [{ outputPath: `/out/${id}/o.png`, modality: 'image', model: 'z-image-turbo', seed: 1 }];
}

/**
 * A controllable runner: each started job hangs until the test resolves/rejects
 * it by id, and it records start order + exposes the AbortSignal it received.
 */
function controllableRunner(): {
  runner: JobRunner;
  started: string[];
  finish(id: string): void;
  fail(id: string, message: string): void;
  signalFor(id: string): AbortSignal | undefined;
} {
  const started: string[] = [];
  const resolvers = new Map<string, (o: GenOutput[]) => void>();
  const rejectors = new Map<string, (e: Error) => void>();
  const signals = new Map<string, AbortSignal | undefined>();
  const runner: JobRunner = (job, opts) => {
    started.push(job.id);
    signals.set(job.id, opts.signal);
    return new Promise<GenOutput[]>((resolve, reject) => {
      resolvers.set(job.id, resolve);
      rejectors.set(job.id, reject);
      // If aborted, reject like the real client does.
      opts.signal?.addEventListener('abort', () => reject(new Error('generation aborted')), {
        once: true,
      });
    });
  };
  return {
    runner,
    started,
    finish: (id) => resolvers.get(id)?.(output(id)),
    fail: (id, message) => rejectors.get(id)?.(new Error(message)),
    signalFor: (id) => signals.get(id),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('JobQueue concurrency', () => {
  it('runs up to maxConcurrent light jobs in parallel and queues the rest', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 2, runner: c.runner });
    q.enqueue(imageJob('a'));
    q.enqueue(imageJob('b'));
    q.enqueue(imageJob('c'));
    await tick();

    expect(c.started).toEqual(['a', 'b']); // c is queued
    expect(q.runningCount).toBe(2);
    expect(q.queuedCount).toBe(1);

    c.finish('a');
    await tick();
    expect(c.started).toEqual(['a', 'b', 'c']); // c starts when a slot frees
  });

  it('resolves each handle with the job outputs', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 2, runner: c.runner });
    const h = q.enqueue(imageJob('a'));
    await tick();
    c.finish('a');
    await expect(h.result).resolves.toEqual(output('a'));
  });

  it('rejects the handle and marks error status on runner failure', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 1, runner: c.runner });
    const statuses: JobStatus[] = [];
    q.on((e) => {
      if (e.type === 'status' && e.jobId === 'a') statuses.push(e.status);
    });
    const h = q.enqueue(imageJob('a'));
    await tick();
    c.fail('a', 'metal oom');
    await expect(h.result).rejects.toThrow('metal oom');
    expect(statuses).toEqual(['queued', 'running', 'error']);
  });
});

describe('JobQueue heavy (unified-memory) serialization', () => {
  it('runs a heavy job ALONE — it waits for running jobs to drain', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 2, runner: c.runner });
    q.enqueue(imageJob('light1'));
    q.enqueue(imageJob('heavy'), { heavy: true });
    q.enqueue(imageJob('light2'));
    await tick();

    // Only light1 runs; heavy must wait for the machine to be empty, and light2
    // is FIFO-behind the heavy job so it cannot jump ahead.
    expect(c.started).toEqual(['light1']);

    c.finish('light1');
    await tick();
    expect(c.started).toEqual(['light1', 'heavy']); // heavy now runs alone
    expect(q.runningCount).toBe(1);

    c.finish('heavy');
    await tick();
    expect(c.started).toEqual(['light1', 'heavy', 'light2']);
  });

  it('blocks new light jobs from starting while a heavy job runs', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 2, runner: c.runner });
    q.enqueue(imageJob('heavy'), { heavy: true });
    q.enqueue(imageJob('light'));
    await tick();
    expect(c.started).toEqual(['heavy']);
    expect(q.queuedCount).toBe(1);
    c.finish('heavy');
    await tick();
    expect(c.started).toEqual(['heavy', 'light']);
  });
});

describe('JobQueue cancel', () => {
  it('cancels a queued job before it starts', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 1, runner: c.runner });
    q.enqueue(imageJob('a'));
    const h = q.enqueue(imageJob('b'));
    await tick();
    expect(c.started).toEqual(['a']);

    expect(q.cancel('b')).toBe(true);
    await expect(h.result).rejects.toThrow(/canceled/);
    expect(q.statusOf('b')).toBeUndefined(); // removed
    // b never runs even after a frees.
    c.finish('a');
    await tick();
    expect(c.started).toEqual(['a']);
  });

  it('cancels a running job by aborting its signal', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 1, runner: c.runner });
    const h = q.enqueue(imageJob('a'));
    await tick();
    const signal = c.signalFor('a');
    expect(signal?.aborted).toBe(false);

    expect(q.cancel('a')).toBe(true);
    expect(signal?.aborted).toBe(true);
    await expect(h.result).rejects.toThrow(/canceled/);
  });

  it('frees the slot after cancelling a running job so the next starts', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 1, runner: c.runner });
    const ha = q.enqueue(imageJob('a'));
    ha.result.catch(() => {}); // the cancel rejects this handle; swallow it
    q.enqueue(imageJob('b'));
    await tick();
    expect(c.started).toEqual(['a']);
    q.cancel('a');
    await expect(ha.result).rejects.toThrow(/canceled/);
    await tick();
    expect(c.started).toEqual(['a', 'b']);
  });

  it('rejects a duplicate job id', () => {
    const c = controllableRunner();
    const q = new JobQueue({ runner: c.runner });
    q.enqueue(imageJob('dup'));
    expect(() => q.enqueue(imageJob('dup'))).toThrow(/already in queue/);
  });
});
