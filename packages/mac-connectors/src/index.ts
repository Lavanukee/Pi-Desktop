/**
 * @pi-desktop/mac-connectors — a pi extension exposing native macOS app data as
 * LLM-callable tools, following the same shape as @pi-desktop/web-tools
 * (registerTool + typebox params, injectable process runners, darwin gating like
 * spotlight_search).
 *
 * Tools (read unless noted):
 *   - calendar_list_events        Calendar.app events in a date range
 *   - calendar_create_event  (W)  create a Calendar event
 *   - reminders_list              Reminders.app reminders
 *   - reminders_create       (W)  create a reminder
 *   - contacts_search             Contacts.app people (emails/phones/org)
 *   - mail_search                 Mail.app message headers by subject/unread
 *   - mail_recent                 Mail.app newest message headers
 *   - mail_read                   full body of one Mail message by id
 *   - messages_recent             recent iMessages/SMS from chat.db (needs FDA)
 *   - messages_send          (W)  send an iMessage
 *
 * Every tool is darwin-gated and degrades gracefully off-platform / when a
 * permission (Automation consent, or Full Disk Access for messages_recent) is
 * missing — it returns an explanatory result and never throws. The AppleScript
 * runner and the chat.db sqlite reader are both injectable so the whole surface
 * unit-tests without touching real apps.
 *
 * The default export is the zero-config activation pi loads via `-e`;
 * `registerMacConnectors(pi, options)` is the configured seam (inject runners /
 * force platform in tests).
 */
import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { type CalendarEvent, runCalendarCreateEvent, runCalendarListEvents } from './calendar.js';
import { runContactsSearch } from './contacts.js';
import { type MailMessage, runMailRead, runMailRecent, runMailSearch } from './mail.js';
import {
  type Message,
  runMessagesRecent,
  runMessagesSend,
  type SqliteRunner,
  systemSqliteRunner,
} from './messages.js';
import { type OsascriptRunner, systemOsascriptRunner } from './osascript.js';
import { runRemindersCreate, runRemindersList } from './reminders.js';
// Stable tool names — the identifiers W5 gates on via pi's `tool_call` event —
// live in a dependency-free module so name-only consumers (the harness presets)
// can import them without dragging in this extension. Re-exported below.
import {
  CALENDAR_CREATE_EVENT_TOOL,
  CALENDAR_LIST_EVENTS_TOOL,
  CONTACTS_SEARCH_TOOL,
  MAIL_READ_TOOL,
  MAIL_RECENT_TOOL,
  MAIL_SEARCH_TOOL,
  MESSAGES_RECENT_TOOL,
  MESSAGES_SEND_TOOL,
  REMINDERS_CREATE_TOOL,
  REMINDERS_LIST_TOOL,
} from './tool-names.js';

export * from './calendar.js';
export * from './contacts.js';
export * from './exec.js';
export * from './mail.js';
export * from './messages.js';
export * from './osascript.js';
export * from './reminders.js';
export * from './tool-names.js';

export interface MacConnectorsOptions {
  /** Injected AppleScript runner; defaults to the real `osascript`-backed runner. */
  readonly osascript?: OsascriptRunner;
  /** Injected chat.db reader; defaults to the real `sqlite3`-backed runner. */
  readonly sqlite?: SqliteRunner;
  /** Platform override (test seam / force-enable); defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

function textResult<D>(text: string, details: D): AgentToolResult<D> {
  return { content: [{ type: 'text', text }], details };
}

function withTruncationNote(text: string, truncated: boolean): string {
  return truncated ? `${text}\n(note: output was capped; results may be partial)` : text;
}

// --- details shapes --------------------------------------------------------

interface CalendarListDetails {
  readonly count: number;
  readonly truncated: boolean;
  readonly events: CalendarEvent[];
  readonly note?: string;
  readonly error?: string;
}
interface CalendarCreateDetails {
  readonly created: boolean;
  readonly uid?: string;
  readonly calendar?: string;
  readonly error?: string;
}
interface RemindersListDetails {
  readonly count: number;
  readonly truncated: boolean;
  readonly reminders: unknown[];
  readonly error?: string;
}
interface RemindersCreateDetails {
  readonly created: boolean;
  readonly list?: string;
  readonly error?: string;
}
interface ContactsDetails {
  readonly count: number;
  readonly truncated: boolean;
  readonly contacts: unknown[];
  readonly error?: string;
}
interface MailListDetails {
  readonly count: number;
  readonly truncated: boolean;
  readonly messages: MailMessage[];
  readonly error?: string;
}
interface MailReadDetails {
  readonly found: boolean;
  readonly truncated: boolean;
  readonly error?: string;
}
interface MessagesRecentDetails {
  readonly count: number;
  readonly truncated: boolean;
  readonly needsFullDiskAccess: boolean;
  readonly messages: Message[];
  readonly error?: string;
}
interface MessagesSendDetails {
  readonly sent: boolean;
  readonly error?: string;
}

function fmtEvents(events: readonly CalendarEvent[]): string {
  return events
    .map((e, i) => {
      const loc = e.location !== undefined ? ` @ ${e.location}` : '';
      const cal = ` [${e.calendar}]`;
      return `[${i + 1}] ${e.title}${cal}\n    ${e.start} → ${e.end}${loc}`;
    })
    .join('\n');
}

function fmtMessages(messages: readonly MailMessage[]): string {
  return messages
    .map(
      (m, i) =>
        `[${i + 1}] (id ${m.id}) ${m.subject}\n    from ${m.sender} · ${m.date} · ${m.mailbox}`,
    )
    .join('\n');
}

/** Register all macOS connector tools onto `pi`. */
export function registerMacConnectors(pi: ExtensionAPI, options: MacConnectorsOptions = {}): void {
  const osa = options.osascript ?? systemOsascriptRunner();
  const sqlite = options.sqlite ?? systemSqliteRunner();
  const platform = options.platform;

  // --- calendar_list_events (read) -----------------------------------------
  pi.registerTool({
    name: CALENDAR_LIST_EVENTS_TOOL,
    label: 'List Calendar Events',
    description:
      'List events from macOS Calendar.app in a date range. Dates are local ' +
      '"YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"; defaults to the next 30 days. Optionally ' +
      'restrict to one calendar by name. Returns title, start, end, calendar, and ' +
      'optional location/notes. macOS only.',
    promptSnippet: "List the user's Calendar events in a date range",
    parameters: Type.Object({
      from: Type.Optional(
        Type.String({ description: 'Start of range (local date/time). Default: start of today.' }),
      ),
      to: Type.Optional(
        Type.String({ description: 'End of range (local date/time). Default: +30 days.' }),
      ),
      calendar: Type.Optional(Type.String({ description: 'Restrict to this calendar name.' })),
      limit: Type.Optional(
        Type.Number({ description: 'Max events (default 50, max 200).', minimum: 1, maximum: 200 }),
      ),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<CalendarListDetails>> {
      const outcome = await runCalendarListEvents(osa, params, { signal, platform });
      if (outcome.error !== undefined) {
        return textResult(outcome.error, {
          count: 0,
          truncated: false,
          events: [],
          error: outcome.error,
        });
      }
      const header =
        outcome.events.length > 0
          ? `${outcome.events.length} event(s)`
          : 'No events in that range.';
      const note = outcome.note !== undefined ? `\n(note: ${outcome.note})` : '';
      const text = withTruncationNote(
        `${header}${note}\n\n${fmtEvents(outcome.events)}`.trim(),
        outcome.truncated,
      );
      return textResult(text, {
        count: outcome.events.length,
        truncated: outcome.truncated,
        events: outcome.events,
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      });
    },
  });

  // --- calendar_create_event (WRITE) ---------------------------------------
  pi.registerTool({
    name: CALENDAR_CREATE_EVENT_TOOL,
    label: 'Create Calendar Event',
    description:
      'Create an event in macOS Calendar.app. start/end are local "YYYY-MM-DD" or ' +
      '"YYYY-MM-DD HH:MM:SS". Optionally choose the calendar (defaults to the first), ' +
      'and add notes/location. This modifies the calendar. macOS only.',
    promptSnippet: 'Create a Calendar event',
    parameters: Type.Object({
      title: Type.String({ description: 'Event title/summary.' }),
      start: Type.String({ description: 'Start (local date/time).' }),
      end: Type.String({ description: 'End (local date/time).' }),
      calendar: Type.Optional(
        Type.String({ description: 'Target calendar name (default: first calendar).' }),
      ),
      notes: Type.Optional(Type.String({ description: 'Event notes/description.' })),
      location: Type.Optional(Type.String({ description: 'Event location.' })),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<CalendarCreateDetails>> {
      const outcome = await runCalendarCreateEvent(osa, params, { signal, platform });
      if (!outcome.created) {
        const err = outcome.error ?? 'calendar_create_event: unknown failure.';
        return textResult(err, { created: false, error: err });
      }
      const where = outcome.calendar !== undefined ? ` in "${outcome.calendar}"` : '';
      const when = outcome.start !== undefined ? ` starting ${outcome.start}` : '';
      return textResult(`Created event "${params.title}"${where}${when}.`, {
        created: true,
        ...(outcome.uid !== undefined ? { uid: outcome.uid } : {}),
        ...(outcome.calendar !== undefined ? { calendar: outcome.calendar } : {}),
      });
    },
  });

  // --- reminders_list (read) -----------------------------------------------
  pi.registerTool({
    name: REMINDERS_LIST_TOOL,
    label: 'List Reminders',
    description:
      'List reminders from macOS Reminders.app. Incomplete only by default; set ' +
      'includeCompleted to include done items. Optionally restrict to one list by ' +
      'name. Returns name, list, completed, and optional due/notes. macOS only.',
    promptSnippet: "List the user's reminders",
    parameters: Type.Object({
      list: Type.Optional(Type.String({ description: 'Restrict to this reminders list name.' })),
      includeCompleted: Type.Optional(
        Type.Boolean({ description: 'Include completed reminders (default false).' }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'Max reminders (default 50, max 200).',
          minimum: 1,
          maximum: 200,
        }),
      ),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<RemindersListDetails>> {
      const outcome = await runRemindersList(osa, params, { signal, platform });
      if (outcome.error !== undefined) {
        return textResult(outcome.error, {
          count: 0,
          truncated: false,
          reminders: [],
          error: outcome.error,
        });
      }
      const lines = outcome.reminders.map((r, i) => {
        const box = r.completed ? '[x]' : '[ ]';
        const due = r.due !== undefined ? ` (due ${r.due})` : '';
        return `[${i + 1}] ${box} ${r.name} — ${r.list}${due}`;
      });
      const header =
        outcome.reminders.length > 0 ? `${outcome.reminders.length} reminder(s)` : 'No reminders.';
      const text = withTruncationNote(`${header}\n\n${lines.join('\n')}`.trim(), outcome.truncated);
      return textResult(text, {
        count: outcome.reminders.length,
        truncated: outcome.truncated,
        reminders: outcome.reminders,
      });
    },
  });

  // --- reminders_create (WRITE) --------------------------------------------
  pi.registerTool({
    name: REMINDERS_CREATE_TOOL,
    label: 'Create Reminder',
    description:
      'Create a reminder in macOS Reminders.app. Optionally choose the list (defaults ' +
      'to the default list), a due date ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"), and ' +
      'notes. This modifies Reminders. macOS only.',
    promptSnippet: 'Create a reminder',
    parameters: Type.Object({
      title: Type.String({ description: 'Reminder title.' }),
      list: Type.Optional(
        Type.String({ description: 'Target list name (default: the default list).' }),
      ),
      due: Type.Optional(Type.String({ description: 'Due date/time (local).' })),
      notes: Type.Optional(Type.String({ description: 'Reminder notes/body.' })),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<RemindersCreateDetails>> {
      const outcome = await runRemindersCreate(osa, params, { signal, platform });
      if (!outcome.created) {
        const err = outcome.error ?? 'reminders_create: unknown failure.';
        return textResult(err, { created: false, error: err });
      }
      const where = outcome.list !== undefined ? ` in "${outcome.list}"` : '';
      return textResult(`Created reminder "${params.title}"${where}.`, {
        created: true,
        ...(outcome.list !== undefined ? { list: outcome.list } : {}),
      });
    },
  });

  // --- contacts_search (read) ----------------------------------------------
  pi.registerTool({
    name: CONTACTS_SEARCH_TOOL,
    label: 'Search Contacts',
    description:
      'Search macOS Contacts.app for people whose name contains the query. Returns ' +
      'name, emails, phones, and organization. macOS only.',
    promptSnippet: "Search the user's contacts",
    parameters: Type.Object({
      query: Type.String({ description: 'Name text to match.' }),
      limit: Type.Optional(
        Type.Number({ description: 'Max people (default 25, max 100).', minimum: 1, maximum: 100 }),
      ),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<ContactsDetails>> {
      const outcome = await runContactsSearch(osa, params, { signal, platform });
      if (outcome.error !== undefined) {
        return textResult(outcome.error, {
          count: 0,
          truncated: false,
          contacts: [],
          error: outcome.error,
        });
      }
      const lines = outcome.contacts.map((c, i) => {
        const org = c.org !== undefined ? ` · ${c.org}` : '';
        const em = c.emails.length > 0 ? `\n    emails: ${c.emails.join(', ')}` : '';
        const ph = c.phones.length > 0 ? `\n    phones: ${c.phones.join(', ')}` : '';
        return `[${i + 1}] ${c.name}${org}${em}${ph}`;
      });
      const header =
        outcome.contacts.length > 0
          ? `${outcome.contacts.length} contact(s)`
          : 'No matching contacts.';
      const text = withTruncationNote(`${header}\n\n${lines.join('\n')}`.trim(), outcome.truncated);
      return textResult(text, {
        count: outcome.contacts.length,
        truncated: outcome.truncated,
        contacts: outcome.contacts,
      });
    },
  });

  // --- mail_search (read) --------------------------------------------------
  pi.registerTool({
    name: MAIL_SEARCH_TOOL,
    label: 'Search Mail',
    description:
      'Search macOS Mail.app for messages whose subject contains the query (or all ' +
      'messages when no query), optionally unread-only, in a mailbox (default inbox; ' +
      'also "sent"/"drafts"/"trash"/"junk" or a mailbox name). Returns headers only ' +
      '(subject, sender, date, mailbox, id) — use mail_read for the body. macOS only.',
    promptSnippet: "Search the user's Mail by subject / unread",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: 'Subject text to match. Omit to list all.' }),
      ),
      mailbox: Type.Optional(Type.String({ description: 'Mailbox name (default "inbox").' })),
      unreadOnly: Type.Optional(
        Type.Boolean({ description: 'Only unread messages (default false).' }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'Max messages (default 20, max 100).',
          minimum: 1,
          maximum: 100,
        }),
      ),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<MailListDetails>> {
      const outcome = await runMailSearch(osa, params, { signal, platform });
      if (outcome.error !== undefined) {
        return textResult(outcome.error, {
          count: 0,
          truncated: false,
          messages: [],
          error: outcome.error,
        });
      }
      const header =
        outcome.messages.length > 0
          ? `${outcome.messages.length} message(s)`
          : 'No matching messages.';
      const text = withTruncationNote(
        `${header}\n\n${fmtMessages(outcome.messages)}`.trim(),
        outcome.truncated,
      );
      return textResult(text, {
        count: outcome.messages.length,
        truncated: outcome.truncated,
        messages: outcome.messages,
      });
    },
  });

  // --- mail_recent (read) --------------------------------------------------
  pi.registerTool({
    name: MAIL_RECENT_TOOL,
    label: 'Recent Mail',
    description:
      'List the newest messages in a macOS Mail.app mailbox (default inbox). Returns ' +
      'headers only (subject, sender, date, mailbox, id) — use mail_read for the body. ' +
      'macOS only.',
    promptSnippet: "List the user's most recent Mail",
    parameters: Type.Object({
      mailbox: Type.Optional(Type.String({ description: 'Mailbox name (default "inbox").' })),
      limit: Type.Optional(
        Type.Number({
          description: 'Max messages (default 20, max 100).',
          minimum: 1,
          maximum: 100,
        }),
      ),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<MailListDetails>> {
      const outcome = await runMailRecent(osa, params, { signal, platform });
      if (outcome.error !== undefined) {
        return textResult(outcome.error, {
          count: 0,
          truncated: false,
          messages: [],
          error: outcome.error,
        });
      }
      const header =
        outcome.messages.length > 0 ? `${outcome.messages.length} message(s)` : 'Mailbox is empty.';
      const text = withTruncationNote(
        `${header}\n\n${fmtMessages(outcome.messages)}`.trim(),
        outcome.truncated,
      );
      return textResult(text, {
        count: outcome.messages.length,
        truncated: outcome.truncated,
        messages: outcome.messages,
      });
    },
  });

  // --- mail_read (read) ----------------------------------------------------
  pi.registerTool({
    name: MAIL_READ_TOOL,
    label: 'Read Mail Message',
    description:
      'Read the full body of one macOS Mail.app message by its numeric id (from a ' +
      'mail_search/mail_recent result). Pass the same mailbox the id was listed from ' +
      '(default inbox). Body is length-capped. macOS only.',
    promptSnippet: 'Read a full Mail message body by id',
    parameters: Type.Object({
      id: Type.String({ description: 'Numeric message id from a listing result.' }),
      mailbox: Type.Optional(
        Type.String({ description: 'Mailbox the id came from (default "inbox").' }),
      ),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<MailReadDetails>> {
      const outcome = await runMailRead(osa, params, { signal, platform });
      if (outcome.error !== undefined || outcome.message === undefined) {
        const err = outcome.error ?? 'mail_read: message not found.';
        return textResult(err, { found: false, truncated: false, error: err });
      }
      const m = outcome.message;
      const head = `Subject: ${m.subject}\nFrom: ${m.sender}\nDate: ${m.date}\nMailbox: ${m.mailbox}`;
      const text = withTruncationNote(`${head}\n\n${m.body}`.trim(), m.truncated);
      return textResult(text, { found: true, truncated: m.truncated });
    },
  });

  // --- messages_recent (read; needs Full Disk Access) ----------------------
  pi.registerTool({
    name: MESSAGES_RECENT_TOOL,
    label: 'Recent Messages',
    description:
      'Read recent iMessage/SMS messages from the macOS Messages database ' +
      '(~/Library/Messages/chat.db), newest first. Optionally filter to a chat by ' +
      'group name, contact name/number, or email. Requires Full Disk Access; if not ' +
      'granted it returns a clear instruction instead of failing. macOS only.',
    promptSnippet: "Read the user's recent iMessages/SMS",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          description: 'Max messages (default 30, max 200).',
          minimum: 1,
          maximum: 200,
        }),
      ),
      chat: Type.Optional(
        Type.String({ description: 'Filter by chat name, contact, number, or email.' }),
      ),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<MessagesRecentDetails>> {
      const outcome = await runMessagesRecent(sqlite, params, { signal, platform });
      if (outcome.error !== undefined) {
        return textResult(outcome.error, {
          count: 0,
          truncated: false,
          needsFullDiskAccess: outcome.needsFullDiskAccess === true,
          messages: [],
          error: outcome.error,
        });
      }
      const lines = outcome.messages.map((m) => {
        const who = m.isFromMe ? 'me' : m.sender;
        return `${m.date}  ${who} → ${m.chat}\n    ${m.text}`;
      });
      const header =
        outcome.messages.length > 0
          ? `${outcome.messages.length} message(s)`
          : 'No messages found.';
      const text = withTruncationNote(`${header}\n\n${lines.join('\n')}`.trim(), outcome.truncated);
      return textResult(text, {
        count: outcome.messages.length,
        truncated: outcome.truncated,
        needsFullDiskAccess: false,
        messages: outcome.messages,
      });
    },
  });

  // --- messages_send (WRITE) -----------------------------------------------
  pi.registerTool({
    name: MESSAGES_SEND_TOOL,
    label: 'Send Message',
    description:
      'Send an iMessage via macOS Messages.app to a phone number or email. This sends ' +
      'a real message. macOS only.',
    promptSnippet: 'Send an iMessage',
    parameters: Type.Object({
      to: Type.String({ description: 'Recipient phone number or email (iMessage).' }),
      text: Type.String({ description: 'Message body to send.' }),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<MessagesSendDetails>> {
      const outcome = await runMessagesSend(osa, params, { signal, platform });
      if (!outcome.sent) {
        const err = outcome.error ?? 'messages_send: unknown failure.';
        return textResult(err, { sent: false, error: err });
      }
      return textResult(`Sent message to ${params.to}.`, { sent: true });
    },
  });
}

/** pi extension factory (zero-config; real osascript + sqlite runners). */
export default function activate(pi: ExtensionAPI): void {
  registerMacConnectors(pi);
}
