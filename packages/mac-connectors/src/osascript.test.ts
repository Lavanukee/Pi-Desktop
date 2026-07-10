import { describe, expect, it } from 'vitest';
import {
  APPLESCRIPT_PRELUDE,
  boundLimit,
  buildOsascriptArgs,
  composeScript,
  FIELD_SEP,
  friendlyScriptError,
  macOnlyError,
  type OsascriptProcessResult,
  type OsascriptRunner,
  type OsascriptRunOptions,
  parseRecords,
  parseSubfields,
  RECORD_SEP,
  runOsascript,
  SUBFIELD_SEP,
} from './osascript.js';

interface OsaCall {
  script: string[];
  args: string[];
  opts: OsascriptRunOptions;
}

function fakeOsa(
  over: Partial<OsascriptProcessResult> = {},
  throwErr?: Error,
): { runner: OsascriptRunner; calls: OsaCall[] } {
  const calls: OsaCall[] = [];
  const runner: OsascriptRunner = {
    async run(script, args, opts) {
      calls.push({ script: [...script], args: [...args], opts });
      if (throwErr !== undefined) throw throwErr;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
    },
  };
  return { runner, calls };
}

const darwin = { platform: 'darwin' as const };

describe('delimiters', () => {
  it('are the ASCII US/RS/GS control characters', () => {
    expect(FIELD_SEP).toBe('\u001f');
    expect(RECORD_SEP).toBe('\u001e');
    expect(SUBFIELD_SEP).toBe('\u001d');
  });
});

describe('buildOsascriptArgs', () => {
  it('emits one -e per line and passes args after a -- guard', () => {
    const argv = buildOsascriptArgs(['on run argv', 'return item 1 of argv', 'end run'], ['-x']);
    expect(argv).toEqual([
      '-l',
      'AppleScript',
      '-e',
      'on run argv',
      '-e',
      'return item 1 of argv',
      '-e',
      'end run',
      '--',
      '-x',
    ]);
  });
});

describe('composeScript', () => {
  it('wraps a body in the shared prelude + on run argv/end run', () => {
    const s = composeScript(['return "hi"']);
    expect(s.slice(0, APPLESCRIPT_PRELUDE.length)).toEqual([...APPLESCRIPT_PRELUDE]);
    expect(s[APPLESCRIPT_PRELUDE.length]).toBe('on run argv');
    expect(s[s.length - 1]).toBe('end run');
  });
});

describe('parseRecords', () => {
  it('splits RS-delimited rows into US-delimited fields; ignores the trailing RS', () => {
    const stdout = `a${FIELD_SEP}b${FIELD_SEP}c${RECORD_SEP}d${FIELD_SEP}e${FIELD_SEP}f${RECORD_SEP}`;
    expect(parseRecords(stdout)).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  it('preserves newlines inside a field', () => {
    const stdout = `note${FIELD_SEP}line1\nline2${RECORD_SEP}`;
    expect(parseRecords(stdout)).toEqual([['note', 'line1\nline2']]);
  });

  it('returns [] for empty output', () => {
    expect(parseRecords('')).toEqual([]);
  });
});

describe('parseSubfields', () => {
  it('splits GS-joined values and drops empties', () => {
    expect(parseSubfields(`a@x.com${SUBFIELD_SEP}b@x.com`)).toEqual(['a@x.com', 'b@x.com']);
    expect(parseSubfields('')).toEqual([]);
    expect(parseSubfields(undefined)).toEqual([]);
  });
});

describe('boundLimit', () => {
  it('defaults and clamps to [1, max]', () => {
    expect(boundLimit(undefined, 20, 200)).toBe(20);
    expect(boundLimit(0, 20, 200)).toBe(1);
    expect(boundLimit(9999, 20, 200)).toBe(200);
    expect(boundLimit(7, 20, 200)).toBe(7);
    expect(boundLimit(Number.NaN, 20, 200)).toBe(20);
  });
});

describe('friendlyScriptError', () => {
  it('maps the -1743 automation-consent error to an actionable message', () => {
    const msg = friendlyScriptError(
      'execution error: Not authorized to send Apple events (-1743)',
      'calendar_list_events',
    );
    expect(msg).toContain('Automation');
    expect(msg).toContain('calendar_list_events');
  });

  it('maps a missing-object -1728 error', () => {
    expect(friendlyScriptError('execution error: Can’t get calendar "X" (-1728)', 'x')).toContain(
      'could not find',
    );
  });

  it('falls back to the raw stderr otherwise', () => {
    expect(friendlyScriptError('boom', 'x')).toContain('boom');
  });
});

describe('runOsascript', () => {
  it('gates off non-darwin without invoking the runner', async () => {
    const { runner, calls } = fakeOsa();
    const outcome = await runOsascript(runner, ['return "x"'], [], 'demo', { platform: 'linux' });
    expect(outcome.error).toBe(macOnlyError('demo', 'linux'));
    expect(calls).toHaveLength(0);
  });

  it('composes the prelude+body and forwards args on darwin', async () => {
    const { runner, calls } = fakeOsa({ stdout: 'ok' });
    const outcome = await runOsascript(runner, ['return "ok"'], ['a', 'b'], 'demo', darwin);
    expect(outcome.error).toBeUndefined();
    expect(outcome.stdout).toBe('ok');
    expect(calls[0]?.args).toEqual(['a', 'b']);
    expect(calls[0]?.script).toContain('on run argv');
    expect(calls[0]?.script).toContain('on isoOf(dt)');
  });

  it('surfaces a script error (non-zero exit) via friendlyScriptError', async () => {
    const { runner } = fakeOsa({
      exitCode: 1,
      stderr: 'Not authorized to send Apple events (-1743)',
    });
    const outcome = await runOsascript(runner, ['boom'], [], 'demo', darwin);
    expect(outcome.stdout).toBe('');
    expect(outcome.error).toContain('Automation');
  });

  it('reports a timeout distinctly', async () => {
    const { runner } = fakeOsa({ timedOut: true });
    const outcome = await runOsascript(runner, ['x'], [], 'demo', darwin);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.error).toContain('timed out');
  });

  it('never throws when the runner cannot spawn osascript', async () => {
    const { runner } = fakeOsa({}, new Error('spawn osascript ENOENT'));
    const outcome = await runOsascript(runner, ['x'], [], 'demo', darwin);
    expect(outcome.error).toContain('could not start osascript');
  });
});
