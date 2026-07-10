/**
 * Calendar.app connector: `calendar_list_events` (read) and
 * `calendar_create_event` (write), both over `osascript`.
 *
 * Dates cross the boundary as locale-independent `YYYY-MM-DD HH:MM:SS` local
 * strings: Node normalizes the caller's `from`/`to`/`start`/`end` into that
 * shape (see {@link toAppleDateString}) and the shared `parseISO`/`isoOf`
 * prelude handlers rebuild/emit AppleScript dates component-by-component, side-
 * stepping AppleScript's locale-dependent `date "…"` literals entirely.
 *
 * Listing avoids one script scanning every calendar: Calendar's `whose start
 * date …` filter is pathologically slow on subscribed calendars that expand
 * recurring events (Holidays/Birthdays/Siri Suggestions), and AppleScript's own
 * `with timeout` does not interrupt it. Instead we fetch calendar names, then
 * query each calendar in its own parallel osascript that the Node runner
 * SIGKILLs at a per-calendar bound — a slow calendar is skipped (and noted)
 * rather than wedging the tool. A caller-named `calendar` takes a single fast
 * query.
 */
import {
  AS_FIELD_SEP,
  AS_RECORD_SEP,
  boundLimit,
  macOnlyError,
  type OsascriptRunner,
  parseRecords,
  type RunOsascriptOptions,
  runOsascript,
} from './osascript.js';

export const CALENDAR_DEFAULT_LIMIT = 50;
export const CALENDAR_MAX_LIMIT = 200;
/** Default look-ahead window (days) when the caller omits `to`. */
export const CALENDAR_DEFAULT_WINDOW_DAYS = 30;
/**
 * Per-calendar wall-clock kill (ms). Calendar's `whose` event filter is
 * pathologically slow on subscribed calendars that expand recurring events
 * (Holidays/Birthdays/Siri Suggestions), and AppleScript's own `with timeout`
 * does NOT interrupt it. So instead of one script scanning every calendar, we
 * query each calendar in its OWN osascript process which the Node runner can
 * SIGKILL at this bound — a slow calendar is dropped (and noted) rather than
 * wedging the whole tool. The queries run sequentially (Calendar serializes
 * concurrent Apple Events, so a parallel fan-out just makes them all contend).
 */
export const CALENDAR_PER_CAL_TIMEOUT_MS = 10_000;
/**
 * A caller-named calendar is a single deliberate request, so it gets a more
 * generous timeout than one leg of the all-calendars sweep — a heavy calendar
 * that the sweep would skip still returns when asked for by name.
 */
export const CALENDAR_NAMED_TIMEOUT_MS = 20_000;
/** Timeout for the "list calendar names" probe (also absorbs Calendar's cold start). */
export const CALENDAR_NAMES_TIMEOUT_MS = 12_000;
/** Overall wall-clock budget for the sequential per-calendar sweep. */
export const CALENDAR_TOTAL_BUDGET_MS = 40_000;
/** Timeout for a single create-event write. */
export const CALENDAR_WRITE_TIMEOUT_MS = 15_000;

export interface CalendarEvent {
  readonly title: string;
  /** Local `YYYY-MM-DD HH:MM:SS`. */
  readonly start: string;
  /** Local `YYYY-MM-DD HH:MM:SS`. */
  readonly end: string;
  readonly calendar: string;
  readonly location?: string;
  readonly notes?: string;
}

/** Format a `Date` as the local `YYYY-MM-DD HH:MM:SS` the prelude's `parseISO` expects. */
export function toAppleDateString(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * Normalize a caller-supplied date string to `YYYY-MM-DD HH:MM:SS` (local),
 * falling back when absent/unparseable. A bare `YYYY-MM-DD` is read as local
 * midnight (not UTC), which is what a user means by "on that day".
 */
export function normalizeDateArg(
  input: string | undefined,
  fallback: Date,
): { value: string; invalid: boolean } {
  if (input === undefined || input.trim().length === 0) {
    return { value: toAppleDateString(fallback), invalid: false };
  }
  const raw = input.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw;
  const parsed = new Date(dateOnly);
  if (Number.isNaN(parsed.getTime())) {
    return { value: toAppleDateString(fallback), invalid: true };
  }
  return { value: toAppleDateString(parsed), invalid: false };
}

export function startOfToday(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

export interface CalendarListParams {
  readonly from?: string;
  readonly to?: string;
  readonly calendar?: string;
  readonly limit?: number;
}

/** The per-calendar event-emit loop, shared by the by-index and by-name bodies. */
const EMIT_EVENTS: readonly string[] = [
  'set evs to (every event of c whose start date >= fromDate and start date <= toDate)',
  'repeat with e in evs',
  'if n >= lim then exit repeat',
  'set output to output & my safeText(summary of e) & fs & my isoOf(start date of e) & fs & my isoOf(end date of e) & fs & (name of c) & fs & my safeText(location of e) & fs & my safeText(description of e) & rs',
  'set n to n + 1',
  'end repeat',
];

/** `on run argv` body: list calendar names, one per RECORD_SEP (fast, no event scan). */
export function calendarNamesBody(): string[] {
  return [
    `set rs to ${AS_RECORD_SEP}`,
    'set output to ""',
    'tell application "Calendar"',
    'repeat with c in calendars',
    'set output to output & (name of c) & rs',
    'end repeat',
    'end tell',
    'return output',
  ];
}

/** `on run argv` body for ONE calendar by 1-based index. argv: [from, to, index, limit]. */
export function eventsByIndexBody(): string[] {
  return [
    `set fs to ${AS_FIELD_SEP}`,
    `set rs to ${AS_RECORD_SEP}`,
    'set fromDate to my parseISO(item 1 of argv)',
    'set toDate to my parseISO(item 2 of argv)',
    'set idx to (item 3 of argv) as integer',
    'set lim to (item 4 of argv) as integer',
    'set output to ""',
    'set n to 0',
    'tell application "Calendar"',
    'set c to calendar idx',
    ...EMIT_EVENTS,
    'end tell',
    'return output',
  ];
}

/** `on run argv` body for ONE calendar by name. argv: [from, to, name, limit]. */
export function eventsByNameBody(): string[] {
  return [
    `set fs to ${AS_FIELD_SEP}`,
    `set rs to ${AS_RECORD_SEP}`,
    'set fromDate to my parseISO(item 1 of argv)',
    'set toDate to my parseISO(item 2 of argv)',
    'set calName to item 3 of argv',
    'set lim to (item 4 of argv) as integer',
    'set output to ""',
    'set n to 0',
    'tell application "Calendar"',
    'set c to first calendar whose name is calName',
    ...EMIT_EVENTS,
    'end tell',
    'return output',
  ];
}

/** Normalize the caller's date range + limit, collecting any parse notes. */
export function normalizeListRange(
  params: CalendarListParams,
  now: Date = new Date(),
): { from: string; to: string; limit: number; notes: string[] } {
  const notes: string[] = [];
  const fromNorm = normalizeDateArg(params.from, startOfToday(now));
  if (fromNorm.invalid) notes.push('could not parse "from"; defaulted to start of today');
  const toFallback = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  toFallback.setDate(toFallback.getDate() + CALENDAR_DEFAULT_WINDOW_DAYS);
  const toNorm = normalizeDateArg(params.to, toFallback);
  if (toNorm.invalid)
    notes.push(`could not parse "to"; defaulted to +${CALENDAR_DEFAULT_WINDOW_DAYS}d`);
  const limit = boundLimit(params.limit, CALENDAR_DEFAULT_LIMIT, CALENDAR_MAX_LIMIT);
  return { from: fromNorm.value, to: toNorm.value, limit, notes };
}

/** Parse the delimited list-events output into structured events. */
export function parseEvents(stdout: string): CalendarEvent[] {
  return parseRecords(stdout).map((f) => {
    const event: CalendarEvent = {
      title: f[0] ?? '',
      start: f[1] ?? '',
      end: f[2] ?? '',
      calendar: f[3] ?? '',
      ...(f[4] !== undefined && f[4].length > 0 ? { location: f[4] } : {}),
      ...(f[5] !== undefined && f[5].length > 0 ? { notes: f[5] } : {}),
    };
    return event;
  });
}

export interface CalendarListOutcome {
  readonly events: CalendarEvent[];
  readonly truncated: boolean;
  readonly note?: string;
  readonly error?: string;
}

function sortByStart(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

export async function runCalendarListEvents(
  runner: OsascriptRunner,
  params: CalendarListParams,
  opts: RunOsascriptOptions = {},
): Promise<CalendarListOutcome> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { events: [], truncated: false, error: macOnlyError('calendar_list_events', platform) };
  }

  const { from, to, limit, notes } = normalizeListRange(params);
  const perCalTimeout = opts.timeoutMs ?? CALENDAR_PER_CAL_TIMEOUT_MS;

  // Fast path: a specific calendar was named — one bounded query, with a more
  // generous timeout than a sweep leg (this is a deliberate single request).
  const targetCalendar = params.calendar?.trim();
  if (targetCalendar !== undefined && targetCalendar.length > 0) {
    const outcome = await runOsascript(
      runner,
      eventsByNameBody(),
      [from, to, targetCalendar, String(limit)],
      'calendar_list_events',
      { ...opts, timeoutMs: opts.timeoutMs ?? CALENDAR_NAMED_TIMEOUT_MS },
    );
    if (outcome.error !== undefined) {
      return { events: [], truncated: outcome.truncated, error: outcome.error };
    }
    const events = sortByStart(parseEvents(outcome.stdout)).slice(0, limit);
    return {
      events,
      truncated: outcome.truncated,
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    };
  }

  // General path: fetch calendar names (this also warms Calendar.app past its
  // slow cold start), then query each calendar in its own bounded osascript,
  // SEQUENTIALLY. Sequential is deliberate: Calendar.app serializes concurrent
  // Apple Events, so a parallel fan-out just makes every query contend and time
  // out together, whereas warm sequential per-calendar queries are fast
  // (sub-second to ~2s each). A slow calendar is SIGKILLed at the per-calendar
  // bound and skipped; an overall budget caps the total and notes any remainder.
  const namesOutcome = await runOsascript(runner, calendarNamesBody(), [], 'calendar_list_events', {
    ...opts,
    timeoutMs: opts.timeoutMs ?? CALENDAR_NAMES_TIMEOUT_MS,
  });
  if (namesOutcome.error !== undefined) {
    return { events: [], truncated: namesOutcome.truncated, error: namesOutcome.error };
  }
  const names = parseRecords(namesOutcome.stdout).map((r) => r[0] ?? '');

  const collected: CalendarEvent[] = [];
  const skipped: string[] = [];
  const unscanned: string[] = [];
  const deadline = Date.now() + CALENDAR_TOTAL_BUDGET_MS;
  for (let i = 0; i < names.length; i += 1) {
    if (Date.now() > deadline) {
      unscanned.push(...names.slice(i));
      break;
    }
    const o = await runOsascript(
      runner,
      eventsByIndexBody(),
      [from, to, String(i + 1), String(limit)],
      'calendar_list_events',
      { ...opts, timeoutMs: perCalTimeout },
    );
    if (o.error !== undefined) {
      skipped.push(names[i] ?? String(i + 1));
      continue;
    }
    collected.push(...parseEvents(o.stdout));
  }

  const sorted = sortByStart(collected);
  const events = sorted.slice(0, limit);
  const truncated = sorted.length > limit || skipped.length > 0 || unscanned.length > 0;
  if (skipped.length > 0) {
    notes.push(
      `skipped ${skipped.length} slow/large calendar(s): ${skipped.join(', ')} ` +
        '(query one by name to give it a longer timeout)',
    );
  }
  if (unscanned.length > 0) {
    notes.push(`time budget reached; ${unscanned.length} calendar(s) not scanned`);
  }
  return {
    events,
    truncated,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

export interface CalendarCreateParams {
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly calendar?: string;
  readonly notes?: string;
  readonly location?: string;
}

/** The `on run argv` body for `calendar_create_event`. argv: [title, start, end, cal, notes, location]. */
export function createEventBody(): string[] {
  return [
    `set fs to ${AS_FIELD_SEP}`,
    'set startDate to my parseISO(item 2 of argv)',
    'set endDate to my parseISO(item 3 of argv)',
    'set calName to item 4 of argv',
    'tell application "Calendar"',
    'if calName is "" then',
    'set theCal to item 1 of calendars',
    'else',
    'set theCal to first calendar whose name is calName',
    'end if',
    'tell theCal',
    'set newEvent to make new event with properties {summary:(item 1 of argv), start date:startDate, end date:endDate}',
    'if (item 5 of argv) is not "" then set description of newEvent to (item 5 of argv)',
    'if (item 6 of argv) is not "" then set location of newEvent to (item 6 of argv)',
    'return "OK" & fs & my safeText(uid of newEvent) & fs & (name of theCal) & fs & my isoOf(start date of newEvent)',
    'end tell',
    'end tell',
  ];
}

/** Build the argv for `calendar_create_event`. Returns an error string if required dates are unparseable. */
export function buildCreateEventArgs(
  params: CalendarCreateParams,
): { args: string[] } | { error: string } {
  const start = normalizeDateArg(params.start, new Date());
  if (start.invalid)
    return { error: `calendar_create_event: could not parse start date "${params.start}"` };
  const end = normalizeDateArg(params.end, new Date());
  if (end.invalid)
    return { error: `calendar_create_event: could not parse end date "${params.end}"` };
  return {
    args: [
      params.title,
      start.value,
      end.value,
      params.calendar?.trim() ?? '',
      params.notes ?? '',
      params.location ?? '',
    ],
  };
}

export interface CalendarCreateOutcome {
  readonly created: boolean;
  readonly uid?: string;
  readonly calendar?: string;
  readonly start?: string;
  readonly error?: string;
}

export async function runCalendarCreateEvent(
  runner: OsascriptRunner,
  params: CalendarCreateParams,
  opts: RunOsascriptOptions = {},
): Promise<CalendarCreateOutcome> {
  if (params.title.trim().length === 0) {
    return { created: false, error: 'calendar_create_event: a non-empty title is required.' };
  }
  const built = buildCreateEventArgs(params);
  if ('error' in built) return { created: false, error: built.error };
  const outcome = await runOsascript(
    runner,
    createEventBody(),
    built.args,
    'calendar_create_event',
    {
      ...opts,
      timeoutMs: opts.timeoutMs ?? CALENDAR_WRITE_TIMEOUT_MS,
    },
  );
  if (outcome.error !== undefined) return { created: false, error: outcome.error };
  const rec = parseRecords(outcome.stdout)[0] ?? [];
  return {
    created: true,
    ...(rec[1] !== undefined && rec[1].length > 0 ? { uid: rec[1] } : {}),
    ...(rec[2] !== undefined && rec[2].length > 0 ? { calendar: rec[2] } : {}),
    ...(rec[3] !== undefined && rec[3].length > 0 ? { start: rec[3] } : {}),
  };
}
