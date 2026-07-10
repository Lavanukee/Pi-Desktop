import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildRecentQuery,
  escapeSqlString,
  isAccessError,
  parseMessagesJson,
  runMessagesRecent,
  runMessagesSend,
  type SqliteProcessResult,
  type SqliteRunner,
  sendBody,
} from './messages.js';
import type { OsascriptProcessResult, OsascriptRunner } from './osascript.js';

const messagesJson = readFileSync(new URL('./fixtures/messages.json', import.meta.url), 'utf8');

interface SqlCall {
  dbPath: string;
  sql: string;
}
function fakeSqlite(
  over: Partial<SqliteProcessResult> = {},
  throwErr?: Error,
): { runner: SqliteRunner; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const runner: SqliteRunner = {
    async query(dbPath, sql) {
      calls.push({ dbPath, sql });
      if (throwErr !== undefined) throw throwErr;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
    },
  };
  return { runner, calls };
}
function fakeOsa(over: Partial<OsascriptProcessResult> = {}): OsascriptRunner {
  return {
    async run() {
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
    },
  };
}
const darwin = { platform: 'darwin' as const };

describe('escapeSqlString', () => {
  it('doubles single quotes to neutralize injection in a quoted literal', () => {
    expect(escapeSqlString("O'Brien")).toBe("O''Brien");
    expect(escapeSqlString("x' OR '1'='1")).toBe("x'' OR ''1''=''1");
  });
});

describe('buildRecentQuery', () => {
  it('omits the WHERE clause and clamps the limit when no chat filter', () => {
    const sql = buildRecentQuery({ limit: 9999 });
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('LIMIT 200');
    expect(sql).toContain('ORDER BY m.date DESC');
  });
  it('adds an escaped LIKE filter for a chat, matching name/identifier/handle', () => {
    const sql = buildRecentQuery({ chat: "Mom's group", limit: 10 });
    expect(sql).toContain('WHERE');
    expect(sql).toContain("LIKE '%Mom''s group%'");
    expect(sql).toContain('c.display_name');
    expect(sql).toContain('c.chat_identifier');
    expect(sql).toContain('h.id LIKE');
    expect(sql).toContain('LIMIT 10');
  });
});

describe('parseMessagesJson', () => {
  it('parses sqlite -json rows and maps is_from_me to a boolean', () => {
    const messages = parseMessagesJson(messagesJson);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({
      date: '2026-07-09 05:59:16',
      sender: '+12014108963',
      text: 'See you at six!',
      chat: 'Weekend Trip',
      isFromMe: false,
    });
    expect(messages[1]?.isFromMe).toBe(true);
  });
  it('substitutes honest placeholders for empty text (attachment vs none)', () => {
    const messages = parseMessagesJson(messagesJson);
    expect(messages[2]?.text).toBe('[attachment]');
    expect(messages[3]?.text).toBe('[no text content]');
  });
  it('returns [] for empty or malformed output', () => {
    expect(parseMessagesJson('')).toEqual([]);
    expect(parseMessagesJson('not json')).toEqual([]);
  });
});

describe('isAccessError', () => {
  it('flags the "unable to open" / "not authorized" failures', () => {
    expect(
      isAccessError({
        stdout: '',
        stderr: 'Error: unable to open database file',
        exitCode: 1,
        timedOut: false,
        truncated: false,
      }),
    ).toBe(true);
    expect(
      isAccessError({
        stdout: '',
        stderr: 'authorization denied',
        exitCode: 1,
        timedOut: false,
        truncated: false,
      }),
    ).toBe(true);
  });
  it('is false on a clean exit', () => {
    expect(
      isAccessError({ stdout: '[]', stderr: '', exitCode: 0, timedOut: false, truncated: false }),
    ).toBe(false);
  });
});

describe('runMessagesRecent', () => {
  it('gates off non-darwin without querying', async () => {
    const { runner, calls } = fakeSqlite();
    const outcome = await runMessagesRecent(runner, {}, { platform: 'linux' });
    expect(outcome.error).toContain('macOS-only');
    expect(calls).toHaveLength(0);
  });
  it('degrades to a Full Disk Access message when the DB cannot be opened', async () => {
    const { runner } = fakeSqlite({ exitCode: 1, stderr: 'Error: unable to open database file' });
    const outcome = await runMessagesRecent(runner, {}, { ...darwin, dbPath: '/x/chat.db' });
    expect(outcome.needsFullDiskAccess).toBe(true);
    expect(outcome.error).toContain('Full Disk Access');
    expect(outcome.messages).toEqual([]);
  });
  it('parses messages on a successful read', async () => {
    const { runner, calls } = fakeSqlite({ stdout: messagesJson });
    const outcome = await runMessagesRecent(
      runner,
      { chat: 'Weekend' },
      { ...darwin, dbPath: '/x/chat.db' },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.messages).toHaveLength(4);
    expect(calls[0]?.dbPath).toBe('/x/chat.db');
    expect(calls[0]?.sql).toContain("LIKE '%Weekend%'");
  });
  it('never throws when sqlite3 cannot spawn', async () => {
    const { runner } = fakeSqlite({}, new Error('spawn sqlite3 ENOENT'));
    const outcome = await runMessagesRecent(runner, {}, { ...darwin, dbPath: '/x/chat.db' });
    expect(outcome.error).toContain('could not run sqlite3');
  });
});

describe('messages_send', () => {
  it('composes an iMessage send body', () => {
    const body = sendBody();
    expect(body.join('\n')).toContain('tell application "Messages"');
    expect(body.join('\n')).toContain('send (item 2 of argv) to targetBuddy');
  });
  it('requires non-empty to/text', async () => {
    expect((await runMessagesSend(fakeOsa(), { to: '', text: 'hi' }, darwin)).sent).toBe(false);
    expect((await runMessagesSend(fakeOsa(), { to: '+1555', text: '' }, darwin)).sent).toBe(false);
  });
  it('confirms a send when osascript returns OK', async () => {
    const outcome = await runMessagesSend(
      fakeOsa({ stdout: 'OK\n' }),
      { to: '+1555', text: 'hi' },
      darwin,
    );
    expect(outcome.sent).toBe(true);
  });
  it('gates off non-darwin', async () => {
    const outcome = await runMessagesSend(
      fakeOsa(),
      { to: '+1555', text: 'hi' },
      { platform: 'linux' },
    );
    expect(outcome.sent).toBe(false);
    expect(outcome.error).toContain('macOS-only');
  });
});
