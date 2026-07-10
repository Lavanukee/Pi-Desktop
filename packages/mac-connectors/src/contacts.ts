/**
 * Contacts.app connector: `contacts_search` (read). Matches people whose display
 * name contains the query and returns each person's several emails/phones as
 * GS-joined sub-lists (parsed back into arrays on the Node side).
 */
import {
  AS_FIELD_SEP,
  AS_RECORD_SEP,
  AS_SUBFIELD_SEP,
  boundLimit,
  type OsascriptRunner,
  parseRecords,
  parseSubfields,
  type RunOsascriptOptions,
  runOsascript,
} from './osascript.js';

export const CONTACTS_DEFAULT_LIMIT = 25;
export const CONTACTS_MAX_LIMIT = 100;
export const CONTACTS_TIMEOUT_MS = 30_000;

export interface Contact {
  readonly name: string;
  readonly emails: string[];
  readonly phones: string[];
  readonly org?: string;
}

export interface ContactsSearchParams {
  readonly query: string;
  readonly limit?: number;
}

/** The `on run argv` body for `contacts_search`. argv: [query, limit]. */
export function searchBody(): string[] {
  return [
    `set fs to ${AS_FIELD_SEP}`,
    `set rs to ${AS_RECORD_SEP}`,
    `set gs to ${AS_SUBFIELD_SEP}`,
    'set q to item 1 of argv',
    'set lim to (item 2 of argv) as integer',
    'set output to ""',
    'set n to 0',
    'tell application "Contacts"',
    'set ppl to (every person whose name contains q)',
    'repeat with p in ppl',
    'if n >= lim then exit repeat',
    'set em to ""',
    'repeat with e in (emails of p)',
    'if em is not "" then set em to em & gs',
    'set em to em & (value of e)',
    'end repeat',
    'set ph to ""',
    'repeat with t in (phones of p)',
    'if ph is not "" then set ph to ph & gs',
    'set ph to ph & (value of t)',
    'end repeat',
    'set output to output & my safeText(name of p) & fs & em & fs & ph & fs & my safeText(organization of p) & rs',
    'set n to n + 1',
    'end repeat',
    'end tell',
    'return output',
  ];
}

export function buildSearchArgs(params: ContactsSearchParams): string[] {
  const limit = boundLimit(params.limit, CONTACTS_DEFAULT_LIMIT, CONTACTS_MAX_LIMIT);
  return [params.query, String(limit)];
}

export function parseContacts(stdout: string): Contact[] {
  return parseRecords(stdout).map((f) => {
    const contact: Contact = {
      name: f[0] ?? '',
      emails: parseSubfields(f[1]),
      phones: parseSubfields(f[2]),
      ...(f[3] !== undefined && f[3].length > 0 ? { org: f[3] } : {}),
    };
    return contact;
  });
}

export interface ContactsSearchOutcome {
  readonly contacts: Contact[];
  readonly truncated: boolean;
  readonly error?: string;
}

export async function runContactsSearch(
  runner: OsascriptRunner,
  params: ContactsSearchParams,
  opts: RunOsascriptOptions = {},
): Promise<ContactsSearchOutcome> {
  if (params.query.trim().length === 0) {
    return { contacts: [], truncated: false, error: 'contacts_search requires a non-empty query.' };
  }
  const outcome = await runOsascript(
    runner,
    searchBody(),
    buildSearchArgs(params),
    'contacts_search',
    {
      ...opts,
      timeoutMs: opts.timeoutMs ?? CONTACTS_TIMEOUT_MS,
    },
  );
  if (outcome.error !== undefined) {
    return { contacts: [], truncated: outcome.truncated, error: outcome.error };
  }
  return { contacts: parseContacts(outcome.stdout), truncated: outcome.truncated };
}
