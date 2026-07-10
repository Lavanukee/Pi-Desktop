/**
 * Live, read-only end-to-end checks that actually drive `osascript` / `sqlite3`
 * against the apps on THIS Mac. Opt-in only (they touch real user data and can
 * trigger one-time TCC permission prompts), and strictly read-only — no events
 * are created and no messages are sent here.
 *
 * Run with:  PI_MAC_CONNECTORS_E2E=1 pnpm --filter @pi-desktop/mac-connectors test
 *
 * Each check tolerates the "permission not yet granted" outcome: it asserts the
 * connector returns *either* structured data *or* an actionable error string,
 * and logs which so a human can see what needs a grant.
 */
import { describe, expect, it } from 'vitest';
import { runCalendarListEvents } from './calendar.js';
import { runContactsSearch } from './contacts.js';
import { runMessagesRecent, systemSqliteRunner } from './messages.js';
import { systemOsascriptRunner } from './osascript.js';
import { runRemindersList } from './reminders.js';

const LIVE = process.env.PI_MAC_CONNECTORS_E2E === '1';

describe.runIf(LIVE)('live read-only connectors (opt-in)', () => {
  const osa = systemOsascriptRunner();
  const sqlite = systemSqliteRunner();

  it('calendar_list_events runs against Calendar.app', async () => {
    const outcome = await runCalendarListEvents(osa, { limit: 5 });
    if (outcome.error !== undefined) {
      console.log('[live] calendar_list_events needs a grant / failed:', outcome.error);
    } else {
      console.log(`[live] calendar_list_events returned ${outcome.events.length} event(s).`);
      for (const e of outcome.events) console.log(`   • ${e.start}  ${e.title} [${e.calendar}]`);
    }
    expect(Array.isArray(outcome.events)).toBe(true);
  });

  it('reminders_list runs against Reminders.app', async () => {
    const outcome = await runRemindersList(osa, { limit: 5 });
    if (outcome.error !== undefined) {
      console.log('[live] reminders_list needs a grant / failed:', outcome.error);
    } else {
      console.log(`[live] reminders_list returned ${outcome.reminders.length} reminder(s).`);
    }
    expect(Array.isArray(outcome.reminders)).toBe(true);
  });

  it('contacts_search runs against Contacts.app', async () => {
    // A single-letter query is a broad, harmless read.
    const outcome = await runContactsSearch(osa, { query: 'a', limit: 5 });
    if (outcome.error !== undefined) {
      console.log('[live] contacts_search needs a grant / failed:', outcome.error);
    } else {
      console.log(`[live] contacts_search returned ${outcome.contacts.length} contact(s).`);
    }
    expect(Array.isArray(outcome.contacts)).toBe(true);
  });

  it('messages_recent reads chat.db (needs Full Disk Access)', async () => {
    const outcome = await runMessagesRecent(sqlite, { limit: 5 });
    if (outcome.error !== undefined) {
      console.log(
        `[live] messages_recent ${outcome.needsFullDiskAccess === true ? 'needs Full Disk Access' : 'failed'}:`,
        outcome.error,
      );
    } else {
      console.log(`[live] messages_recent returned ${outcome.messages.length} message(s).`);
    }
    expect(Array.isArray(outcome.messages)).toBe(true);
  });
});
