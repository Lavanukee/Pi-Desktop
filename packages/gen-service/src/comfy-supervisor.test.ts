import { EventEmitter } from 'node:events';
import type { LlamaChildProcess } from '@pi-desktop/inference';
import { describe, expect, it } from 'vitest';
import { buildComfyArgs, createComfySupervisor } from './comfy-supervisor.ts';

/** Minimal fake child (mirrors inference/supervisor.test.ts). */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killed: string[] = [];
  constructor(readonly pid = 4242) {
    super();
  }
  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.killed.push(signal);
    queueMicrotask(() => this.emit('exit', 0, signal));
  }
}

const asChild = (c: FakeChild): LlamaChildProcess => c as unknown as LlamaChildProcess;
const okFetch = (): typeof fetch =>
  (async () => ({ ok: true }) as unknown as Response) as unknown as typeof fetch;

describe('buildComfyArgs', () => {
  const base = { mainPy: '/app/ComfyUI/main.py' } as const;

  it('builds the macOS headless argv (listen/port/disable-auto-launch/force-upcast)', () => {
    const args = buildComfyArgs({ ...base, extraModelPathsYaml: '/app/models.yaml' }, 8188);
    expect(args[0]).toBe('/app/ComfyUI/main.py');
    expect(args).toContain('--listen');
    expect(args[args.indexOf('--listen') + 1]).toBe('127.0.0.1');
    expect(args[args.indexOf('--port') + 1]).toBe('8188');
    expect(args).toContain('--disable-auto-launch');
    expect(args[args.indexOf('--extra-model-paths-config') + 1]).toBe('/app/models.yaml');
    expect(args).toContain('--force-upcast-attention');
  });

  it('omits --extra-model-paths-config when no yaml is given', () => {
    const args = buildComfyArgs(base, 9000);
    expect(args).not.toContain('--extra-model-paths-config');
  });

  it('honours a non-default host and can drop --force-upcast-attention', () => {
    const args = buildComfyArgs(
      { ...base, host: '0.0.0.0', forceUpcastAttention: false, extraArgs: ['--lowvram'] },
      7000,
    );
    expect(args[args.indexOf('--listen') + 1]).toBe('0.0.0.0');
    expect(args).not.toContain('--force-upcast-attention');
    expect(args).toContain('--lowvram');
  });
});

describe('createComfySupervisor', () => {
  it('starts via the reused supervisor, health-probes /system_stats, and resolves the bare origin', async () => {
    let spawnCount = 0;
    let spawnedArgs: string[] = [];
    const { supervisor, resolveOrigin } = createComfySupervisor({
      pythonPath: '/app/venv/bin/python',
      mainPy: '/app/ComfyUI/main.py',
      extraModelPathsYaml: '/app/models.yaml',
      port: 8188,
      healthTimeoutMs: 1000,
      spawnFn: (_cmd, args) => {
        spawnCount += 1;
        spawnedArgs = args;
        return asChild(new FakeChild());
      },
      fetchImpl: okFetch(),
    });

    const origin = await resolveOrigin();
    expect(origin).toBe('http://127.0.0.1:8188'); // bare origin, NO /v1
    expect(supervisor.healthUrl).toBe('http://127.0.0.1:8188/system_stats');
    // Spawn used buildComfyArgs (main.py + headless flags).
    expect(spawnedArgs[0]).toBe('/app/ComfyUI/main.py');
    expect(spawnedArgs).toContain('--disable-auto-launch');
    expect(spawnedArgs).toContain('--force-upcast-attention');

    // resolveOrigin is memoized — a second call does not re-spawn.
    expect(await resolveOrigin()).toBe(origin);
    expect(spawnCount).toBe(1);

    await supervisor.dispose();
  });

  it('disposes the underlying server (SIGTERM to the child)', async () => {
    let child: FakeChild | undefined;
    const { supervisor, resolveOrigin } = createComfySupervisor({
      pythonPath: '/app/venv/bin/python',
      mainPy: '/app/ComfyUI/main.py',
      port: 8200,
      spawnFn: () => {
        child = new FakeChild();
        return asChild(child);
      },
      fetchImpl: okFetch(),
    });
    await resolveOrigin();
    await supervisor.dispose();
    expect(child?.killed).toContain('SIGTERM');
  });
});
