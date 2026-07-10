import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildMailSearchArgs,
  MAIL_BODY_MAX_CHARS,
  parseMessages,
  runMailRead,
  runMailRecent,
  runMailSearch,
} from './mail.js';
import { FIELD_SEP, type OsascriptProcessResult, type OsascriptRunner } from './osascript.js';

const mailOut = readFileSync(new URL('./fixtures/mail.txt', import.meta.url), 'utf8');
const mailReadOut = readFileSync(new URL('./fixtures/mail-read.txt', import.meta.url), 'utf8');

interface Call {
  args: string[];
}
function fakeOsa(over: Partial<OsascriptProcessResult> = {}): {
  runner: OsascriptRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    runner: {
      async run(_script, args) {
        calls.push({ args: [...args] });
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
      },
    },
    calls,
  };
}
const darwin = { platform: 'darwin' as const };

describe('buildMailSearchArgs', () => {
  it('encodes query/mailbox/unread/limit', () => {
    expect(
      buildMailSearchArgs({ query: 'plan', mailbox: 'sent', unreadOnly: true, limit: 3 }),
    ).toEqual(['plan', 'sent', '1', '3']);
    expect(buildMailSearchArgs({})).toEqual(['', '', '0', '20']);
  });
});

describe('parseMessages', () => {
  it('parses id/subject/sender/date/mailbox headers', () => {
    const messages = parseMessages(mailOut);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      id: '428931',
      subject: 'Q3 planning',
      sender: 'Alice <alice@corp.example>',
      date: '2026-07-09 08:15:00',
      mailbox: 'INBOX',
    });
  });
});

describe('runMailRecent', () => {
  it('drives the search body with an empty query and unread=0', async () => {
    const { runner, calls } = fakeOsa({ stdout: mailOut });
    const outcome = await runMailRecent(runner, { mailbox: 'inbox', limit: 5 }, darwin);
    expect(outcome.messages).toHaveLength(2);
    expect(calls[0]?.args).toEqual(['', 'inbox', '0', '5']);
  });
});

describe('runMailSearch', () => {
  it('gates off non-darwin', async () => {
    const { runner } = fakeOsa();
    const outcome = await runMailSearch(runner, { query: 'x' }, { platform: 'linux' });
    expect(outcome.error).toContain('macOS-only');
  });
  it('returns parsed headers', async () => {
    const { runner } = fakeOsa({ stdout: mailOut });
    const outcome = await runMailSearch(runner, { query: 'plan' }, darwin);
    expect(outcome.messages[0]?.subject).toBe('Q3 planning');
  });
});

describe('runMailRead', () => {
  it('rejects a non-numeric id without spawning', async () => {
    const { runner, calls } = fakeOsa();
    const outcome = await runMailRead(runner, { id: 'not-a-number' }, darwin);
    expect(outcome.error).toContain('numeric message id');
    expect(calls).toHaveLength(0);
  });
  it('parses subject/sender/date/mailbox/body from the fixture', async () => {
    const { runner } = fakeOsa({ stdout: mailReadOut });
    const outcome = await runMailRead(runner, { id: '428931' }, darwin);
    expect(outcome.message?.subject).toBe('Q3 planning');
    expect(outcome.message?.body).toContain('Attached is the Q3 plan');
    expect(outcome.message?.truncated).toBe(false);
  });
  it('truncates an over-long body and flags it', async () => {
    const longBody = 'x'.repeat(MAIL_BODY_MAX_CHARS + 100);
    const stdout = ['Subj', 'S', '2026-07-09 08:15:00', 'INBOX', longBody].join(FIELD_SEP);
    const { runner } = fakeOsa({ stdout });
    const outcome = await runMailRead(runner, { id: '1' }, darwin);
    expect(outcome.message?.truncated).toBe(true);
    expect(outcome.message?.body.length).toBe(MAIL_BODY_MAX_CHARS);
  });
});
