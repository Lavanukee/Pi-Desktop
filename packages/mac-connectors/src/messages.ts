/**
 * Messages connector, split by capability along the clean-vs-privileged line:
 *
 *  - **`messages_recent` (read)** queries `~/Library/Messages/chat.db` directly
 *    via the `sqlite3` CLI in read-only mode. That database is TCC-protected, so
 *    a process without **Full Disk Access** cannot open it — we detect the open
 *    failure and degrade to a clear "grant Full Disk Access" message rather than
 *    throwing. The `sqlite3` reader is injectable so parsing/query-building
 *    unit-test without the real DB. Modern macOS stores `date` as nanoseconds
 *    since 2001-01-01; some rows keep their text in `attributedBody` (a binary
 *    blob) with an empty `text` column, which we surface honestly as a
 *    placeholder rather than trying to decode.
 *
 *  - **`messages_send` (write)** goes through AppleScript/`osascript` (no special
 *    DB access needed) and is intentionally left to the normal tool-permission
 *    flow — sending is powerful, but no extra gating lives here.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnCapture } from './exec.js';
import {
  boundLimit,
  macOnlyError,
  type OsascriptRunner,
  parseRecords,
  type RunOsascriptOptions,
  runOsascript,
} from './osascript.js';

export const MESSAGES_DEFAULT_LIMIT = 30;
export const MESSAGES_MAX_LIMIT = 200;
export const MESSAGES_TIMEOUT_MS = 15_000;
export const MESSAGES_MAX_OUTPUT_BYTES = 2_000_000;

/** Default path to the Messages SQLite database. */
export function defaultChatDbPath(): string {
  return join(homedir(), 'Library', 'Messages', 'chat.db');
}

export interface SqliteRunOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface SqliteProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

/** Injectable read-only SQLite seam so unit tests never touch the real chat.db. */
export interface SqliteRunner {
  query(dbPath: string, sql: string, opts: SqliteRunOptions): Promise<SqliteProcessResult>;
}

/** A {@link SqliteRunner} backed by the `sqlite3` CLI, opened read-only. */
export function systemSqliteRunner(): SqliteRunner {
  return {
    async query(dbPath, sql, opts) {
      const r = await spawnCapture(
        'sqlite3',
        ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql],
        { timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes, signal: opts.signal },
      );
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        truncated: r.stdoutTruncated,
      };
    },
  };
}

/** Escape a value for safe embedding in a single-quoted SQL string literal. */
export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

export interface MessagesRecentParams {
  readonly limit?: number;
  readonly chat?: string;
}

/**
 * Build the read-only SELECT for recent messages. The optional `chat` filter is
 * embedded as an escaped LIKE against the chat's display name / identifier and
 * the handle id; `limit` is coerced to a bounded integer. (Read-only DB, no
 * ATTACH — the escaped literal is the containment boundary.)
 */
export function buildRecentQuery(params: MessagesRecentParams): string {
  const limit = boundLimit(params.limit, MESSAGES_DEFAULT_LIMIT, MESSAGES_MAX_LIMIT);
  const chat = params.chat?.trim();
  const where =
    chat !== undefined && chat.length > 0
      ? `WHERE (c.display_name LIKE '%${escapeSqlString(chat)}%' ` +
        `OR c.chat_identifier LIKE '%${escapeSqlString(chat)}%' ` +
        `OR h.id LIKE '%${escapeSqlString(chat)}%')`
      : '';
  return (
    'SELECT ' +
    "datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS date, " +
    "CASE WHEN m.is_from_me = 1 THEN 'me' ELSE COALESCE(h.id, 'unknown') END AS sender, " +
    'm.is_from_me AS is_from_me, ' +
    "COALESCE(NULLIF(c.display_name, ''), NULLIF(c.chat_identifier, ''), h.id, 'unknown') AS chat, " +
    "COALESCE(m.text, '') AS text, " +
    'COALESCE(m.cache_has_attachments, 0) AS has_attachment ' +
    'FROM message m ' +
    'LEFT JOIN handle h ON m.handle_id = h.ROWID ' +
    'LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID ' +
    'LEFT JOIN chat c ON c.ROWID = cmj.chat_id ' +
    `${where} ` +
    `ORDER BY m.date DESC LIMIT ${limit};`
  ).replace(/\s+/g, ' ');
}

export interface Message {
  /** Local `YYYY-MM-DD HH:MM:SS`. */
  readonly date: string;
  /** Handle id (phone/email) of the other party, or `"me"`. */
  readonly sender: string;
  readonly text: string;
  /** Group display name / chat identifier / handle. */
  readonly chat: string;
  readonly isFromMe: boolean;
}

interface RawRow {
  readonly date?: string;
  readonly sender?: string;
  readonly is_from_me?: number;
  readonly chat?: string;
  readonly text?: string;
  readonly has_attachment?: number;
}

/** Parse `sqlite3 -json` stdout (chronological-desc rows) into {@link Message}s. */
export function parseMessagesJson(stdout: string): Message[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let rows: RawRow[];
  try {
    rows = JSON.parse(trimmed) as RawRow[];
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const rawText = typeof r.text === 'string' ? r.text : '';
    const text =
      rawText.length > 0 ? rawText : r.has_attachment === 1 ? '[attachment]' : '[no text content]';
    const msg: Message = {
      date: r.date ?? '',
      sender: r.sender ?? 'unknown',
      text,
      chat: r.chat ?? 'unknown',
      isFromMe: r.is_from_me === 1,
    };
    return msg;
  });
}

/** The message shown when chat.db cannot be opened (almost always missing FDA). */
export function fullDiskAccessError(dbPath: string): string {
  return (
    `messages_recent could not open the Messages database (${dbPath}). This almost ` +
    'always means Full Disk Access is not granted to this app. Grant it under System ' +
    'Settings › Privacy & Security › Full Disk Access, then retry. (If Messages has ' +
    'never been set up on this Mac, the database will not exist.)'
  );
}

/** Detect the sqlite "cannot open / not authorized" failure that signals missing FDA. */
export function isAccessError(result: SqliteProcessResult): boolean {
  if (result.exitCode === 0) return false;
  return /unable to open|not authorized|authorization denied|operation not permitted|disk i\/o|permission denied|no such file/i.test(
    result.stderr,
  );
}

export interface MessagesRecentOutcome {
  readonly messages: Message[];
  readonly truncated: boolean;
  /** True when the failure was specifically a Full Disk Access / open problem. */
  readonly needsFullDiskAccess?: boolean;
  readonly error?: string;
}

export interface RunMessagesRecentOptions extends RunOsascriptOptions {
  /** Override the chat.db path (test seam). */
  readonly dbPath?: string;
}

export async function runMessagesRecent(
  runner: SqliteRunner,
  params: MessagesRecentParams,
  opts: RunMessagesRecentOptions = {},
): Promise<MessagesRecentOutcome> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { messages: [], truncated: false, error: macOnlyError('messages_recent', platform) };
  }
  const dbPath = opts.dbPath ?? defaultChatDbPath();
  const sql = buildRecentQuery(params);

  let result: SqliteProcessResult;
  try {
    result = await runner.query(dbPath, sql, {
      timeoutMs: opts.timeoutMs ?? MESSAGES_TIMEOUT_MS,
      maxOutputBytes: opts.maxOutputBytes ?? MESSAGES_MAX_OUTPUT_BYTES,
      signal: opts.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      messages: [],
      truncated: false,
      error: `messages_recent could not run sqlite3: ${message}`,
    };
  }

  if (result.timedOut) {
    return {
      messages: [],
      truncated: result.truncated,
      error:
        'messages_recent timed out reading the Messages database (it may be locked by Messages.app).',
    };
  }

  if (isAccessError(result)) {
    return {
      messages: [],
      truncated: result.truncated,
      needsFullDiskAccess: true,
      error: fullDiskAccessError(dbPath),
    };
  }

  if (result.exitCode !== 0) {
    return {
      messages: [],
      truncated: result.truncated,
      error: `messages_recent failed to read the database: ${result.stderr.trim() || 'unknown sqlite error'}`,
    };
  }

  return { messages: parseMessagesJson(result.stdout), truncated: result.truncated };
}

// --- messages_send (write, AppleScript) ------------------------------------

export interface MessagesSendParams {
  readonly to: string;
  readonly text: string;
}

/** The `on run argv` body for `messages_send`. argv: [to, text]. */
export function sendBody(): string[] {
  return [
    'tell application "Messages"',
    'set targetService to 1st service whose service type = iMessage',
    'set targetBuddy to buddy (item 1 of argv) of targetService',
    'send (item 2 of argv) to targetBuddy',
    'end tell',
    'return "OK"',
  ];
}

export interface MessagesSendOutcome {
  readonly sent: boolean;
  readonly error?: string;
}

export async function runMessagesSend(
  runner: OsascriptRunner,
  params: MessagesSendParams,
  opts: RunOsascriptOptions = {},
): Promise<MessagesSendOutcome> {
  if (params.to.trim().length === 0) {
    return { sent: false, error: 'messages_send: a non-empty "to" (phone or email) is required.' };
  }
  if (params.text.length === 0) {
    return { sent: false, error: 'messages_send: a non-empty "text" is required.' };
  }
  const outcome = await runOsascript(
    runner,
    sendBody(),
    [params.to.trim(), params.text],
    'messages_send',
    { ...opts, timeoutMs: opts.timeoutMs ?? MESSAGES_TIMEOUT_MS },
  );
  if (outcome.error !== undefined) return { sent: false, error: outcome.error };
  const rec = parseRecords(outcome.stdout)[0];
  const ok = (rec?.[0] ?? outcome.stdout.trim()) === 'OK' || outcome.stdout.includes('OK');
  return ok ? { sent: true } : { sent: false, error: 'messages_send: send did not confirm.' };
}
