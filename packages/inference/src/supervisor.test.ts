import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  assembleServerArgs,
  findFreePort,
  type LlamaChildProcess,
  LlamaServerSupervisor,
  type SupervisorEvent,
} from './supervisor.js';

/** Minimal fake child: an EventEmitter with stdout/stderr + kill capture. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killed: string[] = [];
  constructor(
    readonly pid = 4242,
    private readonly linger = false,
  ) {
    super();
  }
  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.killed.push(signal);
    // A well-behaved child exits on SIGTERM; a lingering one only dies on
    // SIGKILL (used to exercise the dispose escalation timer).
    if (!this.linger || signal === 'SIGKILL') {
      queueMicrotask(() => this.emit('exit', 0, signal));
    }
  }
}

const asChild = (c: FakeChild): LlamaChildProcess => c as unknown as LlamaChildProcess;

const okFetch = (ok: () => boolean): typeof fetch =>
  (async () => ({ ok: ok() }) as unknown as Response) as unknown as typeof fetch;

describe('assembleServerArgs', () => {
  const base = { modelPath: '/m.gguf', host: '127.0.0.1', port: 8080 } as const;

  it('fast-text with MTP support + embedded head enables draft-mtp, single slot', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      mtpSupported: true,
      mtpEmbedded: true,
    });
    expect(args).toContain('--parallel');
    expect(args[args.indexOf('--parallel') + 1]).toBe('1');
    expect(args).toContain('--spec-type');
    expect(args[args.indexOf('--spec-type') + 1]).toBe('draft-mtp');
    expect(args).toContain('--spec-draft-n-max');
    expect(args).not.toContain('--mmproj');
  });

  it('fast-text passes a separate MTP head via --model-draft', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      mtpSupported: true,
      mtpPath: '/mtp.gguf',
    });
    expect(args).toContain('--model-draft');
    expect(args[args.indexOf('--model-draft') + 1]).toBe('/mtp.gguf');
  });

  it('fast-text omits draft-mtp when the build lacks MTP support', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      mtpSupported: false,
      mtpEmbedded: true,
    });
    expect(args).not.toContain('--spec-type');
    expect(args).toContain('--parallel');
  });

  it('fast-text EAGLE-3 enables draft-eagle3 + the draft model via --model-draft', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      specType: 'draft-eagle3',
      eagle3Supported: true,
      draftPath: '/eagle3.gguf',
    });
    expect(args).toContain('--spec-type');
    expect(args[args.indexOf('--spec-type') + 1]).toBe('draft-eagle3');
    expect(args).toContain('--model-draft');
    expect(args[args.indexOf('--model-draft') + 1]).toBe('/eagle3.gguf');
    expect(args).toContain('--spec-draft-n-max');
    // EAGLE-3 must NOT also emit the MTP spec-type.
    expect(args).not.toContain('draft-mtp');
    expect(args).not.toContain('--mmproj');
  });

  it('fast-text EAGLE-3 omits spec flags when the build lacks eagle3 support', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      specType: 'draft-eagle3',
      eagle3Supported: false,
      draftPath: '/eagle3.gguf',
    });
    expect(args).not.toContain('--spec-type');
    expect(args).not.toContain('--model-draft');
    expect(args).toContain('--parallel');
  });

  it('multimodal enables --mmproj, never draft-mtp, and honours --parallel', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'multimodal',
      mmprojPath: '/mmproj.gguf',
      parallel: 4,
    });
    expect(args).toContain('--mmproj');
    expect(args[args.indexOf('--mmproj') + 1]).toBe('/mmproj.gguf');
    expect(args[args.indexOf('--parallel') + 1]).toBe('4');
    expect(args).not.toContain('--spec-type');
  });

  it('adds --reasoning-preserve by default and omits it when disabled', () => {
    const on = assembleServerArgs({ ...base, launchMode: 'fast-text' });
    expect(on).toContain('--reasoning-preserve');
    const off = assembleServerArgs({ ...base, launchMode: 'fast-text', reasoningPreserve: false });
    expect(off).not.toContain('--reasoning-preserve');
  });

  it('defaults reasoning budget to unrestricted (-1) with the wrap-up message', () => {
    const args = assembleServerArgs({ ...base, launchMode: 'fast-text' });
    expect(args[args.indexOf('--reasoning-budget') + 1]).toBe('-1');
    expect(args[args.indexOf('--reasoning-budget-message') + 1]).toBe(
      'time limit for reasoning reached',
    );
  });

  it('honours an explicit reasoning budget + custom budget message', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      reasoningBudget: 2048,
      reasoningBudgetMessage: 'wrap it up',
    });
    expect(args[args.indexOf('--reasoning-budget') + 1]).toBe('2048');
    expect(args[args.indexOf('--reasoning-budget-message') + 1]).toBe('wrap it up');
  });

  it('throws on the fast-text + mmproj contradiction (MTP exclusivity)', () => {
    expect(() =>
      assembleServerArgs({ ...base, launchMode: 'fast-text', mmprojPath: '/x.gguf' }),
    ).toThrow(/mutually exclusive/);
  });

  it('throws on a multimodal launch missing its mmproj (would be vision-blind)', () => {
    // Symmetric invariant: a "vision" launch with no projector would come up
    // vision-blind while the app believes vision is on — fail loudly instead.
    expect(() => assembleServerArgs({ ...base, launchMode: 'multimodal' })).toThrow(
      /requires an --mmproj/,
    );
  });

  it('LAZY: a fast-text launch of a vision-capable model still emits no --mmproj', () => {
    // The default (text) launch of a model that HAS a projector must never load
    // it — full MTP speed, zero projector cost, even with the speed head present.
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      mtpSupported: true,
      mtpEmbedded: true,
    });
    expect(args).not.toContain('--mmproj');
    expect(args).toContain('--spec-type');
  });
});

describe('findFreePort', () => {
  it('returns a usable port', async () => {
    const port = await findFreePort('127.0.0.1');
    expect(port).toBeGreaterThan(0);
  });
});

function collect(sup: LlamaServerSupervisor): SupervisorEvent[] {
  const events: SupervisorEvent[] = [];
  sup.on((e) => events.push(e));
  return events;
}

describe('LlamaServerSupervisor lifecycle', () => {
  it('spawns, health-checks, and emits ready', async () => {
    let child: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9099,
      healthIntervalMs: 1,
      spawnFn: () => {
        child = new FakeChild();
        return asChild(child);
      },
      fetchImpl: okFetch(() => true),
    });
    const events = collect(sup);
    const result = await sup.start();
    expect(result.port).toBe(9099);
    expect(result.baseUrl).toBe('http://127.0.0.1:9099/v1');
    expect(events.some((e) => e.type === 'ready')).toBe(true);
    expect(child).toBeDefined();
    await sup.dispose();
  });

  it('extracts TPS from timings via recordTimings', async () => {
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9100,
      healthIntervalMs: 1,
      spawnFn: () => asChild(new FakeChild()),
      fetchImpl: okFetch(() => true),
    });
    const events = collect(sup);
    await sup.start();

    sup.recordTimings({ predicted_per_second: 42.5, predicted_n: 100 });
    expect(sup.metrics.lastTps).toBeCloseTo(42.5);
    expect(sup.metrics.totalPredictedTokens).toBe(100);
    expect(events.some((e) => e.type === 'metrics')).toBe(true);

    // Fallback: derive from predicted_n / predicted_ms.
    sup.recordTimings({ predicted_n: 50, predicted_ms: 500 });
    expect(sup.metrics.lastTps).toBeCloseTo(100);
    expect(sup.metrics.samples).toBe(2);
    await sup.dispose();
  });

  it('restarts with backoff after a crash', async () => {
    let spawnCount = 0;
    let lastChild: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9101,
      healthIntervalMs: 1,
      restartBaseDelayMs: 5,
      spawnFn: () => {
        spawnCount += 1;
        lastChild = new FakeChild();
        return asChild(lastChild);
      },
      fetchImpl: okFetch(() => true),
    });
    const events = collect(sup);
    await sup.start();
    expect(spawnCount).toBe(1);

    // Simulate a crash; wait for the restart to bring a new child up.
    const restarted = new Promise<void>((resolve) => {
      const off = sup.on((e) => {
        if (e.type === 'ready' && spawnCount >= 2) {
          off();
          resolve();
        }
      });
    });
    lastChild?.emit('exit', 1, null);
    await restarted;

    expect(spawnCount).toBe(2);
    expect(events.some((e) => e.type === 'crash')).toBe(true);
    const restart = events.find((e) => e.type === 'restart');
    expect(restart).toBeDefined();
    await sup.dispose();
  });

  it('killImmediately synchronously SIGKILLs the child and is idempotent', async () => {
    let child: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9103,
      healthIntervalMs: 1,
      // linger: even a child that ignores SIGTERM must die here.
      spawnFn: () => {
        child = new FakeChild(4242, true);
        return asChild(child);
      },
      fetchImpl: okFetch(() => true),
    });
    await sup.start();

    // The utilityProcess-teardown backstop: a single synchronous SIGKILL, no
    // async dispose ladder, so no orphaned llama-server survives quit.
    sup.killImmediately();
    expect(child?.killed).toEqual(['SIGKILL']);
    expect(sup.running).toBe(false);

    // Idempotent: the child is already cleared, so a second call is a no-op.
    sup.killImmediately();
    expect(child?.killed).toEqual(['SIGKILL']);
  });

  it('arms a parent-death watchdog with the child pid and stops it on dispose', async () => {
    const stops: number[] = [];
    const pids: number[] = [];
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9200,
      healthIntervalMs: 1,
      spawnFn: () => asChild(new FakeChild(7777)),
      fetchImpl: okFetch(() => true),
      watchdogFactory: (pid) => {
        pids.push(pid);
        const idx = pids.length - 1;
        return {
          stop() {
            stops.push(idx);
          },
        };
      },
    });
    await sup.start();
    expect(pids).toEqual([7777]);
    expect(stops).toEqual([]);
    await sup.dispose();
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });

  it('stops the watchdog synchronously on killImmediately', async () => {
    let stopped = 0;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9201,
      healthIntervalMs: 1,
      spawnFn: () => asChild(new FakeChild(8888, true)),
      fetchImpl: okFetch(() => true),
      watchdogFactory: () => ({
        stop() {
          stopped += 1;
        },
      }),
    });
    await sup.start();
    sup.killImmediately();
    expect(stopped).toBeGreaterThanOrEqual(1);
  });

  it('re-arms a fresh watchdog on crash-restart and stops the old one', async () => {
    const pids: number[] = [];
    const stops: number[] = [];
    let nextPid = 1000;
    let lastChild: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9202,
      healthIntervalMs: 1,
      restartBaseDelayMs: 5,
      spawnFn: () => {
        nextPid += 1;
        lastChild = new FakeChild(nextPid);
        return asChild(lastChild);
      },
      fetchImpl: okFetch(() => true),
      watchdogFactory: (pid) => {
        pids.push(pid);
        const idx = pids.length - 1;
        return {
          stop() {
            stops.push(idx);
          },
        };
      },
    });
    await sup.start();
    expect(pids).toHaveLength(1);

    const restarted = new Promise<void>((resolve) => {
      const off = sup.on((e) => {
        if (e.type === 'ready' && pids.length >= 2) {
          off();
          resolve();
        }
      });
    });
    lastChild?.emit('exit', 1, null);
    await restarted;

    expect(pids).toHaveLength(2);
    expect(pids[0]).not.toBe(pids[1]);
    expect(stops).toContain(0); // the crashed child's watchdog was disarmed
    await sup.dispose();
  });

  it('dispose escalates SIGTERM → SIGKILL when the child lingers', async () => {
    let child: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9102,
      healthIntervalMs: 1,
      killGraceMs: 20,
      spawnFn: () => {
        child = new FakeChild(4242, true);
        return asChild(child);
      },
      fetchImpl: okFetch(() => true),
    });
    const events = collect(sup);
    await sup.start();

    // Child never emits 'exit', forcing the SIGKILL escalation timer.
    await sup.dispose();
    expect(child?.killed).toContain('SIGTERM');
    expect(child?.killed).toContain('SIGKILL');
    expect(events.some((e) => e.type === 'exit')).toBe(true);
  });
});
