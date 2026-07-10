import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OsascriptProcessResult, OsascriptRunner } from './osascript.js';
import { FIELD_SEP } from './osascript.js';
import {
  buildCreateArgs,
  buildListArgs,
  parseReminders,
  runRemindersCreate,
  runRemindersList,
} from './reminders.js';

const remindersOut = readFileSync(new URL('./fixtures/reminders.txt', import.meta.url), 'utf8');

function fakeOsa(over: Partial<OsascriptProcessResult> = {}): OsascriptRunner {
  return {
    async run() {
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
    },
  };
}
const darwin = { platform: 'darwin' as const };

describe('buildListArgs', () => {
  it('encodes list, includeCompleted flag, and clamped limit', () => {
    expect(buildListArgs({ list: 'Work', includeCompleted: true, limit: 5 })).toEqual([
      'Work',
      '1',
      '5',
    ]);
    expect(buildListArgs({})).toEqual(['', '0', '50']);
  });
});

describe('parseReminders', () => {
  it('parses name/list/completed and optional due/notes', () => {
    const reminders = parseReminders(remindersOut);
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toEqual({
      name: 'Buy milk',
      list: 'Groceries',
      completed: false,
      due: '2026-07-09 18:00:00',
      notes: '2% organic',
    });
    expect(reminders[1]).toEqual({ name: 'Ship package', list: 'Work', completed: true });
  });
});

describe('runRemindersList', () => {
  it('gates off non-darwin', async () => {
    const outcome = await runRemindersList(fakeOsa(), {}, { platform: 'win32' });
    expect(outcome.error).toContain('macOS-only');
  });
  it('returns parsed reminders', async () => {
    const outcome = await runRemindersList(fakeOsa({ stdout: remindersOut }), {}, darwin);
    expect(outcome.reminders).toHaveLength(2);
    expect(outcome.reminders[0]?.completed).toBe(false);
  });
});

describe('buildCreateArgs', () => {
  it('normalizes a bare due date to 09:00 local', () => {
    const r = buildCreateArgs({ title: 'Call', due: '2026-07-09' });
    expect('args' in r && r.args).toEqual(['Call', '', '2026-07-09 09:00:00', '']);
  });
  it('rejects an unparseable due date', () => {
    expect('error' in buildCreateArgs({ title: 'Call', due: 'whenever' })).toBe(true);
  });
});

describe('runRemindersCreate', () => {
  it('requires a non-empty title', async () => {
    const outcome = await runRemindersCreate(fakeOsa(), { title: '' }, darwin);
    expect(outcome.created).toBe(false);
  });
  it('reports success from the confirmation record', async () => {
    const stdout = ['OK', 'Groceries', 'Buy milk'].join(FIELD_SEP);
    const outcome = await runRemindersCreate(fakeOsa({ stdout }), { title: 'Buy milk' }, darwin);
    expect(outcome).toMatchObject({ created: true, list: 'Groceries', name: 'Buy milk' });
  });
});
