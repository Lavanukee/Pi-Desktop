import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAvailability } from './check.js';
import { type AfmChildProcess, type AfmSpawnFn, defaultSpawn } from './spawn.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-afm.mjs', import.meta.url));

/** Structural fake child that replays a canned stdout line then closes. */
class FakeCheckChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => {}, end: () => {}, on: () => {} };
  readonly pid = 111;
  kill(): void {}
}

function fakeSpawn(line: string | undefined, opts: { emitError?: boolean } = {}): AfmSpawnFn {
  return () => {
    const child = new FakeCheckChild();
    queueMicrotask(() => {
      if (opts.emitError === true) {
        child.emit('error', new Error('ENOENT'));
        return;
      }
      if (line !== undefined) child.stdout.emit('data', line);
      child.emit('close', 0, null);
    });
    return child as unknown as AfmChildProcess;
  };
}

/** Spawn the real Node fixture, standing in for the compiled binary. */
const fixtureSpawn: AfmSpawnFn = (_bin, args) => defaultSpawn(process.execPath, [FIXTURE, ...args]);

describe('checkAvailability (structural fake)', () => {
  it('parses an available line', async () => {
    const result = await checkAvailability({
      spawnFn: fakeSpawn(
        '{"available":true,"reason":"available","contextWindow":4096,"model":"apple-on-device"}\n',
      ),
    });
    expect(result).toEqual({
      available: true,
      reason: 'available',
      contextWindow: 4096,
      model: 'apple-on-device',
    });
  });

  it('maps an unavailable reason', async () => {
    const result = await checkAvailability({
      spawnFn: fakeSpawn(
        '{"available":false,"reason":"appleIntelligenceNotEnabled","contextWindow":4096,"model":"x"}\n',
      ),
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('appleIntelligenceNotEnabled');
  });

  it('coerces an unknown reason string to unsupportedOS', async () => {
    const result = await checkAvailability({
      spawnFn: fakeSpawn('{"available":false,"reason":"wat","contextWindow":4096,"model":"x"}\n'),
    });
    expect(result.reason).toBe('unsupportedOS');
  });

  it('resolves unavailable on garbage output', async () => {
    const result = await checkAvailability({ spawnFn: fakeSpawn('not json at all\n') });
    expect(result).toEqual({
      available: false,
      reason: 'unsupportedOS',
      contextWindow: 4096,
      model: '',
    });
  });

  it('resolves unavailable when the child emits an error', async () => {
    const result = await checkAvailability({ spawnFn: fakeSpawn(undefined, { emitError: true }) });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('unsupportedOS');
  });

  it('resolves unavailable when spawn throws', async () => {
    const throwingSpawn: AfmSpawnFn = () => {
      throw new Error('spawn EACCES');
    };
    const result = await checkAvailability({ spawnFn: throwingSpawn });
    expect(result.available).toBe(false);
  });
});

describe('checkAvailability (real spawned fixture)', () => {
  it('parses the fixture --check line', async () => {
    const result = await checkAvailability({ spawnFn: fixtureSpawn });
    expect(result).toEqual({
      available: true,
      reason: 'available',
      contextWindow: 4096,
      model: 'fake-afm',
    });
  });

  it('reflects an unavailable reason from the fixture env', async () => {
    const prev = process.env.FAKE_AFM_REASON;
    process.env.FAKE_AFM_REASON = 'deviceNotEligible';
    try {
      const result = await checkAvailability({ spawnFn: fixtureSpawn });
      expect(result.available).toBe(false);
      expect(result.reason).toBe('deviceNotEligible');
    } finally {
      if (prev === undefined) delete process.env.FAKE_AFM_REASON;
      else process.env.FAKE_AFM_REASON = prev;
    }
  });
});
