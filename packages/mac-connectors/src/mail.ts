/**
 * Mail.app connector: `mail_search` and `mail_recent` (read, headers only) plus
 * `mail_read` (read, full body). Listing deliberately does NOT fetch message
 * bodies — that would force IMAP downloads and is slow — so `snippet` is left
 * unset and callers pull a full body via `mail_read` using the numeric `id`
 * surfaced in the listing.
 *
 * `mail_recent` is just `mail_search` with an empty query and `unreadOnly=false`,
 * so both share one AppleScript body. A message `id` is scoped to the mailbox it
 * was listed from, so `mail_read` takes the same optional `mailbox`.
 */
import {
  AS_FIELD_SEP,
  AS_RECORD_SEP,
  boundLimit,
  type OsascriptRunner,
  parseRecords,
  type RunOsascriptOptions,
  runOsascript,
} from './osascript.js';

export const MAIL_DEFAULT_LIMIT = 20;
export const MAIL_MAX_LIMIT = 100;
export const MAIL_TIMEOUT_MS = 45_000;
/** Body char cap for `mail_read` (bounds a huge message; excess flagged truncated). */
export const MAIL_BODY_MAX_CHARS = 20_000;

export interface MailMessage {
  readonly id: string;
  readonly subject: string;
  readonly sender: string;
  /** Local `YYYY-MM-DD HH:MM:SS`. */
  readonly date: string;
  readonly mailbox: string;
  readonly snippet?: string;
}

/**
 * Resolve a mailbox name to a Mail reference. Special folders map to their
 * dedicated elements; anything else is looked up by name. Shared by every body.
 */
const RESOLVE_MAILBOX: readonly string[] = [
  'set mbName to item 2 of argv',
  'if mbName is "" or mbName is "inbox" or mbName is "Inbox" then',
  'set mb to inbox',
  'else if mbName is "sent" then',
  'set mb to sent mailbox',
  'else if mbName is "drafts" then',
  'set mb to drafts mailbox',
  'else if mbName is "trash" then',
  'set mb to trash mailbox',
  'else if mbName is "junk" then',
  'set mb to junk mailbox',
  'else',
  'set mb to first mailbox whose name is mbName',
  'end if',
];

export interface MailSearchParams {
  readonly query?: string;
  readonly mailbox?: string;
  readonly unreadOnly?: boolean;
  readonly limit?: number;
}

/** The `on run argv` body for `mail_search`/`mail_recent`. argv: [query, mailbox, unreadOnly, limit]. */
export function mailSearchBody(): string[] {
  return [
    `set fs to ${AS_FIELD_SEP}`,
    `set rs to ${AS_RECORD_SEP}`,
    'set q to item 1 of argv',
    'set unreadOnly to (item 3 of argv) is "1"',
    'set lim to (item 4 of argv) as integer',
    ...RESOLVE_MAILBOX,
    'tell mb',
    'if q is "" and unreadOnly then',
    'set theMsgs to (messages whose read status is false)',
    'else if q is "" then',
    'set theMsgs to messages',
    'else if unreadOnly then',
    'set theMsgs to (messages whose (subject contains q) and read status is false)',
    'else',
    'set theMsgs to (messages whose subject contains q)',
    'end if',
    'end tell',
    'set output to ""',
    'set total to count of theMsgs',
    'repeat with i from 1 to lim',
    'if i > total then exit repeat',
    'set m to item i of theMsgs',
    'set output to output & (id of m as text) & fs & my safeText(subject of m) & fs & my safeText(sender of m) & fs & my isoOf(date received of m) & fs & my safeText(name of mailbox of m) & rs',
    'end repeat',
    'return output',
  ];
}

export function buildMailSearchArgs(params: MailSearchParams): string[] {
  const limit = boundLimit(params.limit, MAIL_DEFAULT_LIMIT, MAIL_MAX_LIMIT);
  return [
    params.query?.trim() ?? '',
    params.mailbox?.trim() ?? '',
    params.unreadOnly === true ? '1' : '0',
    String(limit),
  ];
}

export function parseMessages(stdout: string): MailMessage[] {
  return parseRecords(stdout).map((f) => {
    const msg: MailMessage = {
      id: f[0] ?? '',
      subject: f[1] ?? '',
      sender: f[2] ?? '',
      date: f[3] ?? '',
      mailbox: f[4] ?? '',
    };
    return msg;
  });
}

export interface MailSearchOutcome {
  readonly messages: MailMessage[];
  readonly truncated: boolean;
  readonly error?: string;
}

export async function runMailSearch(
  runner: OsascriptRunner,
  params: MailSearchParams,
  opts: RunOsascriptOptions = {},
): Promise<MailSearchOutcome> {
  const outcome = await runOsascript(
    runner,
    mailSearchBody(),
    buildMailSearchArgs(params),
    'mail_search',
    {
      ...opts,
      timeoutMs: opts.timeoutMs ?? MAIL_TIMEOUT_MS,
    },
  );
  if (outcome.error !== undefined) {
    return { messages: [], truncated: outcome.truncated, error: outcome.error };
  }
  return { messages: parseMessages(outcome.stdout), truncated: outcome.truncated };
}

export interface MailRecentParams {
  readonly mailbox?: string;
  readonly limit?: number;
}

/** `mail_recent` — the newest messages in a mailbox (empty query, all read states). */
export async function runMailRecent(
  runner: OsascriptRunner,
  params: MailRecentParams,
  opts: RunOsascriptOptions = {},
): Promise<MailSearchOutcome> {
  const outcome = await runOsascript(
    runner,
    mailSearchBody(),
    buildMailSearchArgs({
      query: '',
      mailbox: params.mailbox,
      unreadOnly: false,
      limit: params.limit,
    }),
    'mail_recent',
    { ...opts, timeoutMs: opts.timeoutMs ?? MAIL_TIMEOUT_MS },
  );
  if (outcome.error !== undefined) {
    return { messages: [], truncated: outcome.truncated, error: outcome.error };
  }
  return { messages: parseMessages(outcome.stdout), truncated: outcome.truncated };
}

export interface MailReadParams {
  readonly id: string;
  readonly mailbox?: string;
}

export interface MailBody {
  readonly subject: string;
  readonly sender: string;
  readonly date: string;
  readonly mailbox: string;
  readonly body: string;
  readonly truncated: boolean;
}

/** The `on run argv` body for `mail_read`. argv: [id, mailbox]. */
export function readBody(): string[] {
  return [
    `set fs to ${AS_FIELD_SEP}`,
    'set idNum to (item 1 of argv) as integer',
    ...RESOLVE_MAILBOX,
    'tell mb',
    'set m to first message whose id is idNum',
    'return my safeText(subject of m) & fs & my safeText(sender of m) & fs & my isoOf(date received of m) & fs & my safeText(name of mailbox of m) & fs & my safeText(content of m)',
    'end tell',
  ];
}

export interface MailReadOutcome {
  readonly message?: MailBody;
  readonly error?: string;
}

export async function runMailRead(
  runner: OsascriptRunner,
  params: MailReadParams,
  opts: RunOsascriptOptions = {},
): Promise<MailReadOutcome> {
  if (!/^\d+$/.test(params.id.trim())) {
    return {
      error: 'mail_read: id must be the numeric message id from a mail_search/mail_recent result.',
    };
  }
  const args = [params.id.trim(), params.mailbox?.trim() ?? ''];
  const outcome = await runOsascript(runner, readBody(), args, 'mail_read', {
    ...opts,
    timeoutMs: opts.timeoutMs ?? MAIL_TIMEOUT_MS,
  });
  if (outcome.error !== undefined) return { error: outcome.error };
  const rec = parseRecords(outcome.stdout)[0];
  if (rec === undefined) return { error: 'mail_read: message not found in the given mailbox.' };
  const rawBody = rec[4] ?? '';
  const truncated = rawBody.length > MAIL_BODY_MAX_CHARS;
  return {
    message: {
      subject: rec[0] ?? '',
      sender: rec[1] ?? '',
      date: rec[2] ?? '',
      mailbox: rec[3] ?? '',
      body: truncated ? rawBody.slice(0, MAIL_BODY_MAX_CHARS) : rawBody,
      truncated,
    },
  };
}
