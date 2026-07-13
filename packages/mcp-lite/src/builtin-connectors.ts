/**
 * Built-in ("preinstalled") connectors — pi's own bundled tool surfaces that
 * ship inside the app rather than launching an external MCP server. They are
 * always on (never installed, never removed, never spawned), so they carry
 * `kind:'builtin'` + a sentinel empty `command`; the connectors-main IPC no-ops
 * install/remove/enable for them, and the gallery renders a static "Preinstalled"
 * affordance instead of the "+" add button.
 *
 * The set spans two provenance tiers (this distinction drives the gallery
 * sections — see connector-sections.ts):
 *   - Video editing + the macOS connectors are genuinely OURS (`firstParty:true`)
 *     — the "By us" section.
 *   - HyperFrames is HeyGen's official tool (github.com/heygen-com/hyperframes),
 *     bundled/preinstalled but NOT authored by us. It is `firstParty:false` +
 *     `official:true`, so it lands under "Official / Verified", never "By us".
 *
 * Their static {@link KnownConnector.tools} lists are the "real content" the
 * detail view shows — no schema fetch / server spawn is needed to describe what
 * a builtin does. HyperFrames renders motion-graphics scenes to MP4 on-device
 * (its runtime tool is `motion_graphics_render`); Video editing is a typed
 * ffmpeg façade (`video_edit` / `extract_frames` / `probe`).
 *
 * {@link MAC_CONNECTORS} surface the first-party macOS integrations that ship in
 * the `@pi-desktop/mac-connectors` pi extension (always loaded via `-e`, so their
 * calendar/mail/messages/contacts/reminders tools are ALWAYS live). They were
 * previously invisible in the gallery — a user had no way to discover that the
 * agent can read their Calendar or Mail — so they are exposed here as
 * `kind:'builtin'` "Preinstalled" cards. Their tool NAMES mirror
 * `@pi-desktop/mac-connectors/tool-names` (kept as literals so the registry does
 * not take a dependency on a specific connector extension).
 *
 * Merged to the FRONT of {@link KNOWN_CONNECTORS} so they cross the connectors
 * IPC in `catalog` and land first in their sections.
 */
import type { KnownConnector } from './detect-apps';

const HYPERFRAMES_DESCRIPTION =
  'Motion-graphics video — the agent authors HTML/CSS/JS and renders it to MP4 ' +
  '(ffmpeg + headless Chrome). Deterministic, on-device, no model weights.';

const VIDEO_EDITING_DESCRIPTION =
  'A typed ffmpeg façade — trim, concat, overlay, extract frames, and probe ' +
  'video, with safe argv (no shell).';

/** One first-party macOS connector card: an always-on `kind:'builtin'` gallery
 * entry for a `@pi-desktop/mac-connectors` app surface. `command:''` (never a
 * server); a static tool list drives the detail view. */
function macConnector(
  card: Pick<KnownConnector, 'id' | 'name' | 'icon' | 'category' | 'description' | 'tools'>,
): KnownConnector {
  return {
    ...card,
    kind: 'builtin',
    // Authored by us (the mac-connectors pi extension) → the "By us" section.
    firstParty: true,
    official: true,
    template: {
      id: card.id,
      name: card.name,
      icon: card.icon,
      description: card.description,
      command: '',
    },
  };
}

/**
 * The first-party macOS connectors, surfaced so the calendar/mail/messages/
 * contacts/reminders tools (always live via the `@pi-desktop/mac-connectors`
 * extension) are DISCOVERABLE in the gallery. Tool names mirror
 * `@pi-desktop/mac-connectors/tool-names`.
 */
export const MAC_CONNECTORS: KnownConnector[] = [
  macConnector({
    id: 'mac-calendar',
    name: 'Calendar',
    icon: '📅',
    category: 'meetings',
    description: 'Read and create events in your macOS Calendar.',
    tools: [
      { name: 'calendar_list_events', description: 'List Calendar events in a date range.' },
      { name: 'calendar_create_event', description: 'Create an event in Calendar.' },
    ],
  }),
  macConnector({
    id: 'mac-mail',
    name: 'Mail',
    icon: '📧',
    category: 'comms',
    description: 'Search, list, and read messages in macOS Mail.',
    tools: [
      { name: 'mail_search', description: 'Search Mail messages by subject or unread state.' },
      { name: 'mail_recent', description: 'List the newest messages in a Mail mailbox.' },
      { name: 'mail_read', description: 'Read the full body of one Mail message by id.' },
    ],
  }),
  macConnector({
    id: 'mac-messages',
    name: 'Messages',
    icon: '💬',
    category: 'comms',
    description: 'Read recent iMessage/SMS conversations and send messages.',
    tools: [
      {
        name: 'messages_recent',
        description: 'Read recent iMessage/SMS (needs Full Disk Access).',
      },
      { name: 'messages_send', description: 'Send an iMessage to a number or email.' },
    ],
  }),
  macConnector({
    id: 'mac-contacts',
    name: 'Contacts',
    icon: '👤',
    category: 'comms',
    description: 'Search people, emails, and phone numbers in macOS Contacts.',
    tools: [
      {
        name: 'contacts_search',
        description: 'Search Contacts people by name (emails, phones, org).',
      },
    ],
  }),
  macConnector({
    id: 'mac-reminders',
    name: 'Reminders',
    icon: '☑️',
    category: 'project',
    description: 'List and create reminders in macOS Reminders.',
    tools: [
      { name: 'reminders_list', description: 'List reminders from Reminders.' },
      { name: 'reminders_create', description: 'Create a reminder in Reminders.' },
    ],
  }),
];

/**
 * The built-in connectors. Each has an empty `template.command` sentinel (it
 * never runs as a server) and a static tool list for the detail view. Icons are
 * neutral line-art glyphs from `connector-icons`.
 */
export const BUILTIN_CONNECTORS: KnownConnector[] = [
  {
    id: 'hyperframes',
    name: 'HyperFrames',
    kind: 'builtin',
    // HeyGen's tool — bundled/preinstalled, but NOT authored by us. Official
    // (Verified), never "By us".
    firstParty: false,
    official: true,
    category: 'creative',
    icon: '🎞️',
    homepage: 'https://github.com/heygen-com/hyperframes',
    description: HYPERFRAMES_DESCRIPTION,
    tools: [
      {
        name: 'motion_graphics_render',
        description: 'Render an HTML/CSS/JS motion-graphics scene to an MP4 clip.',
      },
    ],
    template: {
      id: 'hyperframes',
      name: 'HyperFrames',
      icon: '🎞️',
      description: HYPERFRAMES_DESCRIPTION,
      command: '',
    },
  },
  {
    id: 'video-editing',
    name: 'Video editing',
    kind: 'builtin',
    // Genuinely ours — the "By us" section.
    firstParty: true,
    official: true,
    category: 'media',
    icon: '✂️',
    description: VIDEO_EDITING_DESCRIPTION,
    tools: [
      {
        name: 'video_edit',
        description: 'Trim / concat / overlay / burn subtitles via a safe ffmpeg façade.',
      },
      { name: 'extract_frames', description: 'Extract still frames from a clip.' },
      { name: 'probe', description: 'Read a media file’s streams and metadata.' },
    ],
    template: {
      id: 'video-editing',
      name: 'Video editing',
      icon: '✂️',
      description: VIDEO_EDITING_DESCRIPTION,
      command: '',
    },
  },
  ...MAC_CONNECTORS,
];

/** Ids of the built-in connectors (stable set). */
export const BUILTIN_CONNECTOR_IDS: readonly string[] = BUILTIN_CONNECTORS.map((c) => c.id);
