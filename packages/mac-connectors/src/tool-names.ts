/**
 * The canonical macOS-connector tool NAMES, in one dependency-free module.
 *
 * These are the single source of truth for the connector tool identifiers. They
 * live apart from {@link ./index.ts} (which pulls in typebox + the AppleScript /
 * sqlite runners) so other packages — notably `@pi-desktop/harness`'s toolset
 * presets — can import the names WITHOUT dragging in the whole extension.
 * Importing the constant (vs. hand-typing the string) makes a rename a COMPILE
 * error instead of a silent runtime miss (the same discipline as
 * `@pi-desktop/browser-use/tool-names`).
 *
 * Re-exported from `./index.ts` and exposed as the
 * `@pi-desktop/mac-connectors/tool-names` subpath for cheap name-only imports.
 */

export const CALENDAR_LIST_EVENTS_TOOL = 'calendar_list_events';
export const CALENDAR_CREATE_EVENT_TOOL = 'calendar_create_event';
export const REMINDERS_LIST_TOOL = 'reminders_list';
export const REMINDERS_CREATE_TOOL = 'reminders_create';
export const CONTACTS_SEARCH_TOOL = 'contacts_search';
export const MAIL_SEARCH_TOOL = 'mail_search';
export const MAIL_RECENT_TOOL = 'mail_recent';
export const MAIL_READ_TOOL = 'mail_read';
export const MESSAGES_RECENT_TOOL = 'messages_recent';
export const MESSAGES_SEND_TOOL = 'messages_send';

/** Every tool name this extension registers, in registration order. */
export const MAC_CONNECTOR_TOOLS = [
  CALENDAR_LIST_EVENTS_TOOL,
  CALENDAR_CREATE_EVENT_TOOL,
  REMINDERS_LIST_TOOL,
  REMINDERS_CREATE_TOOL,
  CONTACTS_SEARCH_TOOL,
  MAIL_SEARCH_TOOL,
  MAIL_RECENT_TOOL,
  MAIL_READ_TOOL,
  MESSAGES_RECENT_TOOL,
  MESSAGES_SEND_TOOL,
] as const;
