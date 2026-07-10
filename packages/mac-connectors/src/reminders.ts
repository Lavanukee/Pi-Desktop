/**
 * Reminders.app connector: `reminders_list` (read) and `reminders_create`
 * (write), over `osascript`. Incomplete reminders only by default; pass
 * `includeCompleted` to see everything. Due dates cross the boundary as the
 * shared `YYYY-MM-DD HH:MM:SS` string.
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

export const REMINDERS_DEFAULT_LIMIT = 50;
export const REMINDERS_MAX_LIMIT = 200;
export const REMINDERS_TIMEOUT_MS = 30_000;

export interface Reminder {
  readonly name: string;
  readonly list: string;
  readonly completed: boolean;
  readonly due?: string;
  readonly notes?: string;
}

export interface RemindersListParams {
  readonly list?: string;
  readonly includeCompleted?: boolean;
  readonly limit?: number;
}

/** The `on run argv` body for `reminders_list`. argv: [list, includeCompleted, limit]. */
export function listBody(): string[] {
  return [
    `set fs to ${AS_FIELD_SEP}`,
    `set rs to ${AS_RECORD_SEP}`,
    'set listName to item 1 of argv',
    'set inclDone to (item 2 of argv) is "1"',
    'set lim to (item 3 of argv) as integer',
    'set output to ""',
    'set n to 0',
    'tell application "Reminders"',
    'if listName is "" then',
    'set theLists to lists',
    'else',
    'set theLists to (lists whose name is listName)',
    'end if',
    'repeat with L in theLists',
    'repeat with r in reminders of L',
    'if n >= lim then exit repeat',
    'if inclDone or (completed of r is false) then',
    'set dueVal to ""',
    'if due date of r is not missing value then set dueVal to my isoOf(due date of r)',
    'set output to output & my safeText(name of r) & fs & (name of L) & fs & (completed of r as text) & fs & dueVal & fs & my safeText(body of r) & rs',
    'set n to n + 1',
    'end if',
    'end repeat',
    'if n >= lim then exit repeat',
    'end repeat',
    'end tell',
    'return output',
  ];
}

export function buildListArgs(params: RemindersListParams): string[] {
  const limit = boundLimit(params.limit, REMINDERS_DEFAULT_LIMIT, REMINDERS_MAX_LIMIT);
  return [params.list?.trim() ?? '', params.includeCompleted === true ? '1' : '0', String(limit)];
}

export function parseReminders(stdout: string): Reminder[] {
  return parseRecords(stdout).map((f) => {
    const reminder: Reminder = {
      name: f[0] ?? '',
      list: f[1] ?? '',
      completed: (f[2] ?? 'false') === 'true',
      ...(f[3] !== undefined && f[3].length > 0 ? { due: f[3] } : {}),
      ...(f[4] !== undefined && f[4].length > 0 ? { notes: f[4] } : {}),
    };
    return reminder;
  });
}

export interface RemindersListOutcome {
  readonly reminders: Reminder[];
  readonly truncated: boolean;
  readonly error?: string;
}

export async function runRemindersList(
  runner: OsascriptRunner,
  params: RemindersListParams,
  opts: RunOsascriptOptions = {},
): Promise<RemindersListOutcome> {
  const outcome = await runOsascript(runner, listBody(), buildListArgs(params), 'reminders_list', {
    ...opts,
    timeoutMs: opts.timeoutMs ?? REMINDERS_TIMEOUT_MS,
  });
  if (outcome.error !== undefined) {
    return { reminders: [], truncated: outcome.truncated, error: outcome.error };
  }
  return { reminders: parseReminders(outcome.stdout), truncated: outcome.truncated };
}

export interface RemindersCreateParams {
  readonly title: string;
  readonly list?: string;
  readonly due?: string;
  readonly notes?: string;
}

/** The `on run argv` body for `reminders_create`. argv: [title, list, due, notes]. */
export function createBody(): string[] {
  return [
    `set fs to ${AS_FIELD_SEP}`,
    'set listName to item 2 of argv',
    'set dueStr to item 3 of argv',
    'tell application "Reminders"',
    'if listName is "" then',
    'set theList to default list',
    'else',
    'set theList to first list whose name is listName',
    'end if',
    'tell theList',
    'set newR to make new reminder with properties {name:(item 1 of argv)}',
    'if (item 4 of argv) is not "" then set body of newR to (item 4 of argv)',
    'if dueStr is not "" then set due date of newR to my parseISO(dueStr)',
    'return "OK" & fs & (name of theList) & fs & my safeText(name of newR)',
    'end tell',
    'end tell',
  ];
}

export function buildCreateArgs(
  params: RemindersCreateParams,
): { args: string[] } | { error: string } {
  const dueRaw = params.due?.trim() ?? '';
  let due = '';
  if (dueRaw.length > 0) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? `${dueRaw}T09:00:00` : dueRaw;
    const parsed = new Date(dateOnly);
    if (Number.isNaN(parsed.getTime())) {
      return { error: `reminders_create: could not parse due date "${params.due}"` };
    }
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    due =
      `${p(parsed.getFullYear(), 4)}-${p(parsed.getMonth() + 1)}-${p(parsed.getDate())} ` +
      `${p(parsed.getHours())}:${p(parsed.getMinutes())}:${p(parsed.getSeconds())}`;
  }
  return { args: [params.title, params.list?.trim() ?? '', due, params.notes ?? ''] };
}

export interface RemindersCreateOutcome {
  readonly created: boolean;
  readonly list?: string;
  readonly name?: string;
  readonly error?: string;
}

export async function runRemindersCreate(
  runner: OsascriptRunner,
  params: RemindersCreateParams,
  opts: RunOsascriptOptions = {},
): Promise<RemindersCreateOutcome> {
  if (params.title.trim().length === 0) {
    return { created: false, error: 'reminders_create: a non-empty title is required.' };
  }
  const built = buildCreateArgs(params);
  if ('error' in built) return { created: false, error: built.error };
  const outcome = await runOsascript(runner, createBody(), built.args, 'reminders_create', {
    ...opts,
    timeoutMs: opts.timeoutMs ?? REMINDERS_TIMEOUT_MS,
  });
  if (outcome.error !== undefined) return { created: false, error: outcome.error };
  const rec = parseRecords(outcome.stdout)[0] ?? [];
  return {
    created: true,
    ...(rec[1] !== undefined && rec[1].length > 0 ? { list: rec[1] } : {}),
    ...(rec[2] !== undefined && rec[2].length > 0 ? { name: rec[2] } : {}),
  };
}
