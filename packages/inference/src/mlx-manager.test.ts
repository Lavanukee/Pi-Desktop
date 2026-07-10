import { describe, expect, it } from 'vitest';
import {
  assembleMlxServerArgs,
  createMlxSupervisor,
  ensureMlx,
  isMlxSupported,
  MLX_LM_PIN,
} from './mlx-manager.js';
import type { LlamaChildProcess } from './supervisor.js';

describe('assembleMlxServerArgs', () => {
  it('builds the `uv run … mlx_lm.server` argv with model/host/port', () => {
    const args = assembleMlxServerArgs({
      repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
      host: '127.0.0.1',
      port: 9999,
    });
    expect(args).toContain('run');
    expect(args).toContain('mlx_lm.server');
    // uv resolves + caches the pinned mlx-lm on first run. Both pins are needed:
    // a naked mlx-lm pulls a too-new transformers that import-breaks the server.
    expect(args).toContain(`mlx-lm==${MLX_LM_PIN}`);
    expect(args.some((a) => a.startsWith('transformers=='))).toBe(true);
    // --model <repo> --host <h> --port <p> in order.
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'mlx-community/Qwen3.5-4B-MLX-4bit',
    ]);
    expect(args.slice(args.indexOf('--port'), args.indexOf('--port') + 2)).toEqual([
      '--port',
      '9999',
    ]);
    // No draft-model unless requested (no MTP/EAGLE on MLX).
    expect(args).not.toContain('--draft-model');
  });

  it('adds classic draft-model speculative decoding when a draft repo is given', () => {
    const args = assembleMlxServerArgs({
      repo: 'mlx-community/Qwen3.6-27B-OptiQ-4bit',
      host: '127.0.0.1',
      port: 8000,
      draftRepo: 'mlx-community/Qwen3.5-2B-MLX-4bit',
      numDraftTokens: 4,
    });
    expect(args.slice(args.indexOf('--draft-model'), args.indexOf('--draft-model') + 2)).toEqual([
      '--draft-model',
      'mlx-community/Qwen3.5-2B-MLX-4bit',
    ]);
    expect(args).toContain('--num-draft-tokens');
    expect(args[args.indexOf('--num-draft-tokens') + 1]).toBe('4');
  });
});

describe('isMlxSupported', () => {
  it('is true only on darwin + arm64', () => {
    expect(isMlxSupported('darwin', 'arm64')).toBe(true);
    expect(isMlxSupported('darwin', 'x64')).toBe(false);
    expect(isMlxSupported('linux', 'arm64')).toBe(false);
    expect(isMlxSupported('win32', 'arm64')).toBe(false);
  });
});

describe('ensureMlx', () => {
  it('resolves uv from PATH', async () => {
    // Point the probe at a fake PATH dir that (by name) contains no uv → error…
    await expect(ensureMlx({ pathEnv: '/nonexistent-path-xyz' })).rejects.toThrow(/uv is required/);
  });
});

describe('createMlxSupervisor', () => {
  it('reuses the supervisor with MLX argv (uv command) + a /v1/models health probe', async () => {
    let spawnedCmd = '';
    let spawnedArgs: string[] = [];
    const fetched: string[] = [];

    const fakeChild = {
      pid: 4242,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {},
    } as unknown as LlamaChildProcess;

    const sup = createMlxSupervisor({
      uvPath: '/usr/local/bin/uv',
      repo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
      port: 8123,
      spawnFn: (cmd, args) => {
        spawnedCmd = cmd;
        spawnedArgs = args;
        return fakeChild;
      },
      fetchImpl: (async (url: string) => {
        fetched.push(String(url));
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });

    await sup.start();
    // Health URL uses /v1/models (mlx_lm.server has no /health); the fixed port
    // is assigned at start().
    expect(sup.healthUrl).toBe('http://127.0.0.1:8123/v1/models');
    // The command spawned is `uv`, with the mlx_lm.server argv.
    expect(spawnedCmd).toBe('/usr/local/bin/uv');
    expect(spawnedArgs).toContain('mlx_lm.server');
    expect(spawnedArgs).toContain('mlx-community/Qwen3.5-4B-MLX-4bit');
    expect(fetched.some((u) => u.endsWith('/v1/models'))).toBe(true);
    await sup.dispose();
  });
});
