import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCreateEventArgs,
  normalizeDateArg,
  normalizeListRange,
  parseEvents,
  runCalendarCreateEvent,
  runCalendarListEvents,
  toAppleDateString,
} from './calendar.js';
import {
  FIELD_SEP,
  type OsascriptProcessResult,
  type OsascriptRunner,
  type OsascriptRunOptions,
  RECORD_SEP,
} from './osascript.js';

const calendarOut = readFileSync(
  new URL('./fixtures/calendar-events.txt', import.meta.url),
  'utf8',
);

interface OsaCall {
  script: string[];
  args: string[];
  opts: OsascriptRunOptions;
}
function proc(stdout: string, over: Partial<OsascriptProcessResult> = {}): OsascriptProcessResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
}

/**
 * Script-aware fake: routes to a handler by inspecting which composed body it
 * received (the names probe vs a by-name vs a by-index event query).
 */
function fakeOsa(handlers: {
  names?: () => OsascriptProcessResult;
  byName?: () => OsascriptProcessResult;
  byIndex?: (idx: string) => OsascriptProcessResult;
}): { runner: OsascriptRunner; calls: OsaCall[] } {
  const calls: OsaCall[] = [];
  const runner: OsascriptRunner = {
    async run(script, args, opts) {
      calls.push({ script: [...script], args: [...args], opts });
      const s = script.join('\n');
      if (s.includes('(name of c) & rs')) return handlers.names?.() ?? proc('');
      if (s.includes('first calendar whose name is calName'))
        return handlers.byName?.() ?? proc('');
      if (s.includes('set c to calendar idx')) return handlers.byIndex?.(args[2] ?? '') ?? proc('');
      return proc('');
    },
  };
  return { runner, calls };
}
const darwin = { platform: 'darwin' as const };

describe('toAppleDateString', () => {
  it('formats local components as YYYY-MM-DD HH:MM:SS', () => {
    expect(toAppleDateString(new Date(2026, 6, 9, 9, 5, 3))).toBe('2026-07-09 09:05:03');
    expect(toAppleDateString(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01 00:00:00');
  });
});

describe('normalizeDateArg', () => {
  it('reads a bare date as local midnight (not UTC)', () => {
    expect(normalizeDateArg('2026-07-09', new Date())).toEqual({
      value: '2026-07-09 00:00:00',
      invalid: false,
    });
  });
  it('passes a full local datetime through', () => {
    expect(normalizeDateArg('2026-07-09T14:30:00', new Date()).value).toBe('2026-07-09 14:30:00');
  });
  it('falls back and flags an unparseable value', () => {
    const fallback = new Date(2026, 0, 2, 3, 4, 5);
    const r = normalizeDateArg('not-a-date', fallback);
    expect(r.invalid).toBe(true);
    expect(r.value).toBe('2026-01-02 03:04:05');
  });
});

describe('normalizeListRange', () => {
  it('defaults the window to [start of today, +30d] and clamps the limit', () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const r = normalizeListRange({ limit: 9999 }, now);
    expect(r.from).toBe('2026-07-09 00:00:00');
    expect(r.to).toBe('2026-08-08 00:00:00');
    expect(r.limit).toBe(200);
  });
  it('threads an explicit range', () => {
    const r = normalizeListRange(
      { from: '2026-07-01', to: '2026-07-31', limit: 10 },
      new Date(2026, 6, 9),
    );
    expect(r.from).toBe('2026-07-01 00:00:00');
    expect(r.to).toBe('2026-07-31 00:00:00');
    expect(r.limit).toBe(10);
  });
});

describe('parseEvents', () => {
  it('parses the delimited fixture, keeping location/notes only when present', () => {
    const events = parseEvents(calendarOut);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      title: 'Team Standup',
      start: '2026-07-09 09:30:00',
      end: '2026-07-09 09:45:00',
      calendar: 'Work',
      location: 'Zoom Room 2',
      notes: 'Daily sync',
    });
    expect(events[1]).toEqual({
      title: 'Dentist',
      start: '2026-07-10 14:00:00',
      end: '2026-07-10 15:00:00',
      calendar: 'Personal',
    });
  });
});

describe('runCalendarListEvents', () => {
  it('gates off non-darwin without touching the runner', async () => {
    const { runner, calls } = fakeOsa({});
    const outcome = await runCalendarListEvents(runner, {}, { platform: 'linux' });
    expect(outcome.error).toContain('macOS-only');
    expect(calls).toHaveLength(0);
  });

  it('uses the single by-name query when a calendar is specified', async () => {
    const { runner, calls } = fakeOsa({ byName: () => proc(calendarOut) });
    const outcome = await runCalendarListEvents(runner, { calendar: 'Work' }, darwin);
    expect(outcome.error).toBeUndefined();
    expect(outcome.events).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[2]).toBe('Work');
  });

  it('fans out per-calendar (by index) and merges + sorts results', async () => {
    const names = ['Work', 'Personal'].join(RECORD_SEP);
    const { runner, calls } = fakeOsa({
      names: () => proc(names),
      byIndex: () => proc(calendarOut),
    });
    const outcome = await runCalendarListEvents(runner, {}, darwin);
    // 2 calendars x 2 fixture events = 4, sorted ascending by start.
    expect(outcome.events).toHaveLength(4);
    expect(outcome.events[0]?.start).toBe('2026-07-09 09:30:00');
    const indexCalls = calls.filter((c) => c.script.join('\n').includes('set c to calendar idx'));
    expect(indexCalls).toHaveLength(2);
  });

  it('notes calendars that were skipped (timed out / errored)', async () => {
    const names = ['Work', 'Slow'].join(RECORD_SEP);
    const { runner } = fakeOsa({
      names: () => proc(names),
      byIndex: (idx) =>
        idx === '2' ? proc('', { exitCode: 1, timedOut: true }) : proc(calendarOut),
    });
    const outcome = await runCalendarListEvents(runner, {}, darwin);
    expect(outcome.events).toHaveLength(2);
    expect(outcome.truncated).toBe(true);
    expect(outcome.note).toContain('skipped');
    expect(outcome.note).toContain('Slow');
  });

  it('surfaces a names-probe permission error without throwing', async () => {
    const { runner } = fakeOsa({
      names: () => proc('', { exitCode: 1, stderr: 'Not authorized to send Apple events (-1743)' }),
    });
    const outcome = await runCalendarListEvents(runner, {}, darwin);
    expect(outcome.events).toEqual([]);
    expect(outcome.error).toContain('Automation');
  });
});

describe('calendar_create_event', () => {
  it('rejects unparseable dates before spawning', () => {
    const r = buildCreateEventArgs({ title: 'X', start: 'bad', end: '2026-07-09' });
    expect('error' in r).toBe(true);
  });
  it('builds argv in [title, start, end, cal, notes, location] order', () => {
    const r = buildCreateEventArgs({
      title: 'Sync',
      start: '2026-07-09T10:00:00',
      end: '2026-07-09T11:00:00',
      calendar: 'Work',
      notes: 'agenda',
      location: 'HQ',
    });
    expect('args' in r && r.args).toEqual([
      'Sync',
      '2026-07-09 10:00:00',
      '2026-07-09 11:00:00',
      'Work',
      'agenda',
      'HQ',
    ]);
  });
  it('requires a non-empty title (no runner call)', async () => {
    const { runner, calls } = fakeOsa({});
    const outcome = await runCalendarCreateEvent(
      runner,
      { title: '  ', start: '2026-07-09', end: '2026-07-09' },
      darwin,
    );
    expect(outcome.created).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('reports success and parses the confirmation record', async () => {
    const created = ['OK', 'ABC-123', 'Work', '2026-07-09 10:00:00'].join(FIELD_SEP);
    const runner: OsascriptRunner = {
      async run() {
        return proc(created);
      },
    };
    const outcome = await runCalendarCreateEvent(
      runner,
      { title: 'Sync', start: '2026-07-09T10:00:00', end: '2026-07-09T11:00:00' },
      darwin,
    );
    expect(outcome).toMatchObject({ created: true, uid: 'ABC-123', calendar: 'Work' });
  });
});
