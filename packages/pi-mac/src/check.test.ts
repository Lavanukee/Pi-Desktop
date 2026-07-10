import { describe, expect, it } from 'vitest';
import { checkTcc, parseCheckLine } from './check.js';
import type { MacChildProcess, MacSpawnFn } from './spawn.js';

/** A fake child whose stdout/close the test drives synchronously. */
function fakeChild(): {
  child: MacChildProcess;
  emit: (chunk: string) => void;
  close: () => void;
  error: (err: Error) => void;
} {
  const listeners: {
    data: Array<(c: string) => void>;
    close: Array<() => void>;
    error: Array<(e: Error) => void>;
  } = {
    data: [],
    close: [],
    error: [],
  };
  const child: MacChildProcess = {
    pid: 1,
    stdin: null,
    stdout: { on: (_e, cb) => listeners.data.push(cb as (c: string) => void) },
    stderr: { on: () => undefined },
    on: (event, cb) => {
      if (event === 'close') listeners.close.push(cb as () => void);
      if (event === 'error') listeners.error.push(cb as (e: Error) => void);
    },
    kill: () => undefined,
  };
  return {
    child,
    emit: (chunk) => {
      for (const cb of listeners.data) cb(chunk);
    },
    close: () => {
      for (const cb of listeners.close) cb();
    },
    error: (err) => {
      for (const cb of listeners.error) cb(err);
    },
  };
}

describe('parseCheckLine', () => {
  it('parses both grants true', () => {
    expect(parseCheckLine('{"accessibility":true,"screenRecording":true}')).toEqual({
      accessibility: true,
      screenRecording: true,
    });
  });

  it('treats missing/false fields as denied and takes the last line', () => {
    expect(parseCheckLine('noise\n{"accessibility":true}')).toEqual({
      accessibility: true,
      screenRecording: false,
    });
  });

  it('returns undefined on garbage', () => {
    expect(parseCheckLine('not json')).toBeUndefined();
    expect(parseCheckLine('')).toBeUndefined();
  });
});

describe('checkTcc', () => {
  it('resolves the parsed status from the helper line', async () => {
    const fake = fakeChild();
    const spawnFn: MacSpawnFn = () => fake.child;
    const p = checkTcc({ spawnFn, helperPath: '/bin/pi-mac' });
    fake.emit('{"accessibility":true,"screenRecording":false}\n');
    fake.close();
    expect(await p).toEqual({ accessibility: true, screenRecording: false });
  });

  it('resolves denied when the helper errors', async () => {
    const fake = fakeChild();
    const spawnFn: MacSpawnFn = () => fake.child;
    const p = checkTcc({ spawnFn, helperPath: '/bin/pi-mac' });
    fake.error(new Error('ENOENT'));
    expect(await p).toEqual({ accessibility: false, screenRecording: false });
  });

  it('resolves denied when spawn throws', async () => {
    const spawnFn: MacSpawnFn = () => {
      throw new Error('no binary');
    };
    expect(await checkTcc({ spawnFn })).toEqual({
      accessibility: false,
      screenRecording: false,
    });
  });
});
