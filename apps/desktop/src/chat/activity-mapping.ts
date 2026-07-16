/**
 * Pure mapping from pi-slice message blocks → the design system's
 * `ActivityStepData` (THEME 3 chains). One assistant turn's consecutive
 * thinking + tool-call blocks become a collapsed ActivityChain; each block maps
 * to a step whose kind drives the icon, past/present-tense label, and inline
 * content (bash command+output / edit diff / file preview / web-search results).
 * Media/preview kinds (image/pdf) carry `opensInCanvas` + a `tabSpec` the app
 * routes to a canvas tab instead of expanding inline. No React here — unit-testable.
 */

import type { CanvasTabSpec } from '@pi-desktop/canvas';
import type { AssistantMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import type {
  ActivityStepData,
  ActivityStepKind,
  DiffFileData,
  DiffLine,
  WebSearchResultData,
} from '@pi-desktop/ui';
// Deep source import of the PURE connector-icons module (only pulls
// `simple-icons`), NOT the `@pi-desktop/mcp-lite` barrel — value-importing the
// barrel would drag the MCP/pi SDK into the renderer bundle and break `vite build`
// (the renderer-barrel gotcha). Same sanctioned deep-path seam
// `HarnessStatus.tsx`/`composer-bar-logic.ts` use for harness/src.
import { connectorIconSvg } from '../../../../packages/mcp-lite/src/connector-icons.ts';
import { type DetectedArtifact, segmentMessageText } from './canvas/artifacts';

type ToolCallBlock = Extract<ContentBlock, { type: 'toolCall' }>;
type ThinkingBlock = Extract<ContentBlock, { type: 'thinking' }>;
/** The blocks a chain is built from — thinking + tool calls, no visible text. */
export type ActivityBlock = Extract<ContentBlock, { type: 'thinking' | 'toolCall' }>;

/** Ordered render units for one assistant turn. */
export type ThreadSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thoughts'; blocks: ThinkingBlock[] }
  | { kind: 'chain'; blocks: ActivityBlock[] };

/**
 * Split assistant blocks into text / standalone-thought / chain segments.
 * GROUPING RULE: a maximal run of consecutive thinking + tool-call blocks with
 * NO text between them (and no user turn — turns are separate messages)
 * coalesces into one chain; a run with at least one tool call is a `chain`, a
 * run of only thoughts is standalone `thoughts`. Pure + unit-tested.
 */
export function segmentBlocks(blocks: ContentBlock[]): ThreadSegment[] {
  const segments: ThreadSegment[] = [];
  let buffer: ActivityBlock[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    if (buffer.some((b) => b.type === 'toolCall')) {
      segments.push({ kind: 'chain', blocks: buffer });
    } else {
      segments.push({ kind: 'thoughts', blocks: buffer as ThinkingBlock[] });
    }
    buffer = [];
  };

  for (const block of blocks) {
    if (block.type === 'text') {
      flush();
      if (block.text.length > 0) segments.push({ kind: 'text', text: block.text });
    } else {
      buffer.push(block);
    }
  }
  flush();
  return segments;
}

/** A render unit for one assistant response GROUP: the {@link ThreadSegment}s
 * plus inline artifacts spliced in at their SOURCE position (A1). */
export type GroupSegment = ThreadSegment | { kind: 'artifact'; artifact: DetectedArtifact };

/**
 * Segment a whole assistant response group (coalesced messages) into ordered
 * render units, interleaving inline artifacts (```svg / ```html) exactly where
 * their fence appeared between the surrounding text — NOT bunched at the foot.
 *
 * Chains/thoughts still coalesce ACROSS message boundaries (a chain is a
 * maximal run of thinking + tool-call blocks with no text between, and pi
 * splits one response into several messages), so the fence counter is tracked
 * per message id to keep artifact ids aligned with `detectArtifacts`.
 */
export function segmentGroup(group: AssistantMsg[]): GroupSegment[] {
  const segments: GroupSegment[] = [];
  let buffer: ActivityBlock[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    if (buffer.some((b) => b.type === 'toolCall')) {
      segments.push({ kind: 'chain', blocks: buffer });
    } else {
      segments.push({ kind: 'thoughts', blocks: buffer as ThinkingBlock[] });
    }
    buffer = [];
  };

  const fenceCounts = new Map<string, number>();
  for (const message of group) {
    for (const block of message.blocks) {
      if (block.type === 'text') {
        flush();
        if (block.text.length === 0) continue;
        const start = fenceCounts.get(message.id) ?? 0;
        const { segments: parts, nextIndex } = segmentMessageText(
          block.text,
          message.id,
          message.isStreaming === true,
          start,
        );
        fenceCounts.set(message.id, nextIndex);
        for (const part of parts) {
          if (part.kind === 'markdown') segments.push({ kind: 'text', text: part.text });
          else segments.push({ kind: 'artifact', artifact: part.artifact });
        }
      } else {
        buffer.push(block);
      }
    }
  }
  flush();
  return segments;
}

/** A mapped step plus the optional canvas tab it opens (image/pdf/preview). */
export interface MappedStep {
  data: ActivityStepData;
  /** When set, this step's `opensInCanvas` is true; activating it opens this tab. */
  tabSpec?: CanvasTabSpec;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickPath(args: Record<string, unknown>): string | undefined {
  return (
    str(args.path) ??
    str(args.file_path) ??
    str(args.filename) ??
    str(args.file) ??
    str(args.target_file) ??
    str(args.url)
  );
}

function baseName(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  return path.split(/[/\\]/).pop() || path;
}

/**
 * True when a read targets a pi SKILL / tool-instructions file (Wave B #3a) —
 * so the chain renders it as "Read a skill" (own glyph), NOT a plain file read.
 *
 * A pi skill is a `SKILL.md` playbook auto-discovered under the agent skills
 * dir (`~/.pi/agent/skills/<name>/SKILL.md`) or the project dir
 * (`<cwd>/.pi/skills/<name>/SKILL.md`); a skill's supporting files live beside
 * it under that same `.pi/(agent/)skills/` tree. We detect BOTH the canonical
 * playbook (basename `SKILL.md`) and anything under a pi skills dir. Kept in
 * lock-step with the harness framing detector (skill-instructions.ts).
 */
export function isSkillPath(path: string | undefined): boolean {
  if (path === undefined || path.length === 0) return false;
  const norm = path.replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? '';
  if (base.toLowerCase() === 'skill.md') return true;
  return /(^|\/)\.pi\/(agent\/)?skills\//.test(norm);
}

/** Present-tense (running) / past-tense (done) label per step kind. Connector +
 * generic-tool rows override this with a name-derived label (see {@link labelFor}). */
const STEP_LABELS: Record<ActivityStepKind, [running: string, done: string]> = {
  thinking: ['Thinking…', 'Thought'],
  bash: ['Running a command', 'Ran a command'],
  python: ['Running Python', 'Ran Python'],
  edit: ['Editing a file', 'Edited a file'],
  read: ['Reading a file', 'Read a file'],
  file: ['Presenting a file', 'Presented a file'],
  skill: ['Reading a skill', 'Read a skill'],
  search: ['Searching the web', 'Searched the web'],
  'tool-search': ['Searching tools', 'Searched tools'],
  'browser-navigate': ['Navigating', 'Visited a page'],
  'browser-click': ['Clicking', 'Clicked'],
  'browser-type': ['Typing', 'Typed'],
  'browser-read': ['Reading the page', 'Read the page'],
  connector: ['Using a connector', 'Used a connector'],
  tool: ['Running a tool', 'Used a tool'],
  image: ['Generating an image', 'Generated an image'],
  pdf: ['Creating a PDF', 'Created a PDF'],
  'canvas-open': ['Opening the canvas', 'Opened the canvas'],
};

function stepLabel(kind: ActivityStepKind, running: boolean): string {
  return STEP_LABELS[kind][running ? 0 : 1];
}

/**
 * How one tool NAME resolves: its step kind plus (for connector / generic-tool
 * rows) a display name, a specific label pair, and a connector id for the brand
 * icon. This is the heart of the tool → {icon, label, verb} REGISTRY — a tool the
 * registry knows gets its OWN glyph + phrasing; an unknown tool gets the NEUTRAL
 * generic `tool` kind (puzzle glyph + humanized name), NEVER the file read.
 */
export interface ToolResolution {
  readonly kind: ActivityStepKind;
  /** Overrides the kind's default [running, done] label pair (e.g. "Set a reminder"). */
  readonly label?: readonly [running: string, done: string];
  /** For `connector`: the connector id used to resolve the brand icon SVG. */
  readonly connectorId?: string;
  /** Display name for the label ("Reminders", "Linear", or a humanized tool name). */
  readonly displayName?: string;
}

/** A connector-kind resolution, wiring an action label to a connector's brand icon. */
function connectorTool(
  connectorId: string,
  displayName: string,
  label: readonly [string, string],
): ToolResolution {
  return { kind: 'connector', connectorId, displayName, label };
}

/**
 * EXACT tool-name → resolution registry. First-party builtins + the macOS
 * connectors get a distinct glyph, label, and (for connectors) their brand mark.
 * Everything not matched here falls through to the heuristics + the neutral
 * generic fallback in {@link resolveTool}.
 */
const TOOL_REGISTRY: Record<string, ToolResolution> = {
  // file read
  read: { kind: 'read' },
  view: { kind: 'read' },
  open_file: { kind: 'read' },
  read_file: { kind: 'read' },
  cat: { kind: 'read' },
  // shell
  bash: { kind: 'bash' },
  shell: { kind: 'bash' },
  run: { kind: 'bash' },
  exec: { kind: 'bash' },
  run_command: { kind: 'bash' },
  // python / code execution
  python_run: { kind: 'python' },
  python: { kind: 'python' },
  run_python: { kind: 'python' },
  execute_python: { kind: 'python' },
  // tool search (the harness `tool_search` builtin — the tool registry, not the web)
  tool_search: { kind: 'tool-search' },
  search_tools: { kind: 'tool-search' },
  // web search
  web_search: { kind: 'search' },
  brave_search: { kind: 'search' },
  google: { kind: 'search' },
  search_web: { kind: 'search' },
  // macOS Calendar
  calendar_create_event: connectorTool('mac-calendar', 'Calendar', [
    'Creating an event',
    'Created an event',
  ]),
  calendar_list_events: connectorTool('mac-calendar', 'Calendar', [
    'Reading the calendar',
    'Read the calendar',
  ]),
  // macOS Mail
  mail_send: connectorTool('mac-mail', 'Mail', ['Sending an email', 'Sent an email']),
  mail_search: connectorTool('mac-mail', 'Mail', ['Searching Mail', 'Searched Mail']),
  mail_recent: connectorTool('mac-mail', 'Mail', ['Reading Mail', 'Read Mail']),
  mail_read: connectorTool('mac-mail', 'Mail', ['Reading a message', 'Read a message']),
  // macOS Messages
  messages_send: connectorTool('mac-messages', 'Messages', ['Sending a message', 'Sent a message']),
  messages_recent: connectorTool('mac-messages', 'Messages', ['Reading messages', 'Read messages']),
  // macOS Contacts
  contacts_search: connectorTool('mac-contacts', 'Contacts', [
    'Searching Contacts',
    'Searched Contacts',
  ]),
  // macOS Reminders
  reminders_create: connectorTool('mac-reminders', 'Reminders', [
    'Setting a reminder',
    'Set a reminder',
  ]),
  reminders_list: connectorTool('mac-reminders', 'Reminders', [
    'Reading reminders',
    'Read reminders',
  ]),
};

/** Tool-name prefix (before the first `_`/`.`) → its macOS connector identity. */
const CONNECTOR_PREFIXES: Record<string, { id: string; name: string }> = {
  calendar: { id: 'mac-calendar', name: 'Calendar' },
  mail: { id: 'mac-mail', name: 'Mail' },
  messages: { id: 'mac-messages', name: 'Messages' },
  contacts: { id: 'mac-contacts', name: 'Contacts' },
  reminders: { id: 'mac-reminders', name: 'Reminders' },
};

/** Title-case a connector id/slug for display ("google-calendar" → "Google Calendar"). */
function humanizeConnectorId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Humanize a raw tool name for the neutral fallback ("mcp__srv__do_thing" →
 * "Do thing", "summarize_document" → "Summarize document"). */
function humanizeToolName(name: string): string {
  const tail = name.split(/__|\./).filter(Boolean).pop() ?? name;
  const words = tail.replace(/[_-]+/g, ' ').trim();
  if (words.length === 0) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Resolve an MCP-namespaced tool (`mcp__<server>__<tool>`, `<server>__<tool>`,
 * `<server>.<tool>`) to a connector row: its brand mark when `simple-icons` has
 * the server, else a neutral connector row named after the server. Returns null
 * for a non-namespaced name.
 */
function resolveMcpConnector(name: string): ToolResolution | null {
  const parts = name.split(/__|\./).filter(Boolean);
  if (parts.length < 2) return null;
  let server = (parts[0] ?? '').toLowerCase();
  if (server === 'mcp' && parts.length >= 3) server = (parts[1] ?? '').toLowerCase();
  if (server.length === 0) return null;
  const hasBrand = connectorIconSvg(server) !== undefined;
  return {
    kind: 'connector',
    ...(hasBrand ? { connectorId: server } : {}),
    displayName: humanizeConnectorId(server),
  };
}

/**
 * Resolve a tool name to its {@link ToolResolution}. Exact registry first, then
 * name heuristics (edit/write, browser namespace, image/pdf, read-ish file
 * inspection), then connector-prefix + MCP-namespace detection, and finally the
 * NEUTRAL generic `tool` fallback. Crucially the fallback is `tool`, NOT `read`:
 * an unrecognized tool never masquerades as "Read a file".
 */
export function resolveTool(rawName: string): ToolResolution {
  const name = rawName ?? '';
  const n = name.toLowerCase();

  const exact = TOOL_REGISTRY[n];
  if (exact !== undefined) return exact;

  // Edit/write family (before read-ish, so write_file → edit not read).
  if (
    n.includes('edit') ||
    n.includes('write') ||
    n === 'create' ||
    n === 'update' ||
    n === 'str_replace' ||
    n === 'str_replace_editor' ||
    n.includes('apply_patch') ||
    n.includes('patch')
  )
    return { kind: 'edit' };

  if (n.includes('web_search') || n.includes('search_web')) return { kind: 'search' };
  if (n === 'tool_search' || n.includes('search_tools') || n.includes('find_tools'))
    return { kind: 'tool-search' };
  if (/(^|_)python(_|$)/.test(n)) return { kind: 'python' };

  // Browser-use tool steps (round-10 #17/#9): keep them OFF the generic file
  // "read" glyph. Detected inside the browser/playwright/puppeteer namespace, then
  // split by verb so each renders its own icon + label (compass/pointer/keyboard/
  // eye) instead of a wrong "Read a file" row.
  if (n.includes('browser') || n.includes('playwright') || n.includes('puppeteer')) {
    if (/navigate|goto|go_to|open|visit|url|back|forward|reload|refresh/.test(n))
      return { kind: 'browser-navigate' };
    if (/type|fill|input|press|key|sendkeys|clear/.test(n)) return { kind: 'browser-type' };
    if (/click|tap|hover|select|choose|drag|check|scroll|swipe|mouse/.test(n))
      return { kind: 'browser-click' };
    return { kind: 'browser-read' };
  }

  if (n.includes('image') || n === 'dalle' || n === 'generate_image' || n === 'imagegen')
    return { kind: 'image' };
  if (n.includes('pdf')) return { kind: 'pdf' };

  // Genuinely read-ish FILE inspection (the authoritative read op names +
  // cat/ls/glob/grep/find/head/tail/stat/tree): a file-preview step that expands
  // its output inline. NOT a catch-all — an unknown tool never lands here.
  if (/(^|_)(read|cat|ls|list|glob|grep|rg|ripgrep|find|head|tail|stat|tree|read_dir)(_|$)/.test(n))
    return { kind: 'read' };

  // Connector by tool-name prefix (calendar_/mail_/reminders_/…).
  const prefix = n.split(/[_.]/)[0] ?? '';
  const pfx = CONNECTOR_PREFIXES[prefix];
  if (pfx !== undefined) return { kind: 'connector', connectorId: pfx.id, displayName: pfx.name };

  // MCP-namespaced (server__tool / server.tool / mcp__server__tool).
  const mcp = resolveMcpConnector(name);
  if (mcp !== null) return mcp;

  // NEUTRAL fallback: a generic tool row, humanized name + puzzle glyph.
  return { kind: 'tool', displayName: humanizeToolName(name) };
}

/** Classify a tool name into a step kind (drives icon + summary phrasing). */
export function toolStepKind(name: string): ActivityStepKind {
  return resolveTool(name).kind;
}

/** The row label for a resolved tool, past/present tense. Connector + generic
 * rows read from the resolved display name; the rest use {@link STEP_LABELS}. */
function labelFor(kind: ActivityStepKind, resolution: ToolResolution, running: boolean): string {
  if (resolution.label !== undefined) return resolution.label[running ? 0 : 1];
  if (kind === 'connector') {
    const nm = resolution.displayName ?? 'a connector';
    return running ? `Using ${nm}` : `Used ${nm}`;
  }
  if (kind === 'tool') return resolution.displayName ?? stepLabel('tool', running);
  return stepLabel(kind, running);
}

/** Pretty-print a tool call's arguments for the generic reveal (Input block). */
function formatArgs(args: Record<string, unknown>): string | undefined {
  if (Object.keys(args).length === 0) return undefined;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return undefined;
  }
}

/** The most meaningful single arg to surface inline for a connector/tool row. */
function primaryArg(args: Record<string, unknown>): string | undefined {
  return (
    str(args.query) ??
    str(args.q) ??
    str(args.title) ??
    str(args.name) ??
    str(args.subject) ??
    str(args.url) ??
    pickPath(args)
  );
}

/** Build a best-effort DiffFileData[] from an edit tool's arguments. */
function editDiff(args: Record<string, unknown>): DiffFileData[] | undefined {
  const path = pickPath(args) ?? 'file';
  const oldText = str(args.old_string ?? args.oldText ?? args.old ?? args.oldStr);
  const newText = str(
    args.new_string ??
      args.newText ??
      args.new ??
      args.newStr ??
      args.content ??
      args.contents ??
      args.text ??
      args.file_text,
  );
  if (oldText === undefined && newText === undefined) return undefined;
  const lines: DiffLine[] = [];
  if (oldText !== undefined)
    for (const l of oldText.split('\n')) lines.push({ kind: 'del', text: l });
  if (newText !== undefined)
    for (const l of newText.split('\n')) lines.push({ kind: 'add', text: l });
  return [
    {
      path,
      added: newText !== undefined ? newText.split('\n').length : 0,
      deleted: oldText !== undefined ? oldText.split('\n').length : 0,
      lines,
    },
  ];
}

/** Rows + an optional backend note parsed from a web-search tool result. */
interface ParsedSearch {
  results: WebSearchResultData[];
  note?: string;
}

function toSearchRow(r: Record<string, unknown>): WebSearchResultData {
  const url = str(r.url) ?? str(r.link);
  return {
    title: str(r.title) ?? str(r.name) ?? url ?? 'Result',
    url,
    domain: str(r.domain) ?? hostOf(url),
    snippet: str(r.snippet) ?? str(r.description) ?? str(r.content) ?? str(r.text),
  };
}

/** JSON array / `{ results: [...] }` shapes (what MCP + API search tools emit). */
function tryJsonRows(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    const rows = (parsed as { results?: unknown } | null)?.results;
    return Array.isArray(rows) ? rows : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the built-in web_search text body — a header, an optional "(note: …)"
 * line, then "[n] title / url / snippet" blocks — into rows + note. This is the
 * real path in the app: the engine forwards only the tool's TEXT (not its
 * structured `details`), and that text is a human-readable list, not JSON — so a
 * JSON-only parser always yielded [] and every search rendered "0 results".
 */
function parseSearchText(text: string): ParsedSearch {
  const rows: WebSearchResultData[] = [];
  let note: string | undefined;
  let cur: { title: string; url?: string; snippet?: string } | undefined;
  const flush = (): void => {
    if (cur === undefined) return;
    rows.push({ title: cur.title, url: cur.url, domain: hostOf(cur.url), snippet: cur.snippet });
    cur = undefined;
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const head = /^\[(?:\d+)\]\s+(.*)$/.exec(line);
    if (head !== null) {
      flush();
      cur = { title: head[1] ?? '' };
      continue;
    }
    if (cur === undefined) {
      const m = /^\(note:\s*(.*?)\)\s*$/.exec(line);
      if (m !== null) note = m[1];
      continue; // header / note / blank lines before the first result
    }
    if (line.length === 0) continue;
    if (cur.url === undefined && /^https?:\/\//i.test(line)) {
      cur.url = line;
      continue;
    }
    cur.snippet = cur.snippet !== undefined ? `${cur.snippet} ${line}` : line;
  }
  flush();
  return { results: rows.slice(0, 20), note };
}

/** Parse a web-search tool result into rows + note, tolerant of JSON and text. */
function parseSearchOutcome(result: ToolResultMsg | undefined): ParsedSearch {
  if (result === undefined || result.text.length === 0) return { results: [] };
  const rows = tryJsonRows(result.text);
  if (rows !== undefined) {
    return {
      results: rows.slice(0, 20).map((raw) => toSearchRow((raw ?? {}) as Record<string, unknown>)),
    };
  }
  return parseSearchText(result.text);
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** A media/preview src the canvas tab shows (data URI, http(s), else undefined). */
function pickMediaSrc(
  args: Record<string, unknown>,
  result: ToolResultMsg | undefined,
): string | undefined {
  const fromResult = str(result?.text);
  if (fromResult && /^(data:|https?:)/.test(fromResult.trim())) return fromResult.trim();
  const fromArgs = str(args.url) ?? str(args.src) ?? pickPath(args);
  return fromArgs;
}

/**
 * The renderable src for a generated-IMAGE tool result, or undefined when the
 * result isn't an inline-displayable image. Round-5 #7: generated images render
 * INLINE in the thread (a bounded thumbnail → click for a fullscreen preview),
 * diverging from the reference apps that route them to the canvas. Only `data:`
 * / `http(s):` srcs qualify (a bare path can't be shown inline).
 */
export function generatedImageSrc(
  block: ToolCallBlock,
  result: ToolResultMsg | undefined,
): string | undefined {
  if (toolStepKind(block.name) !== 'image') return undefined;
  const src = pickMediaSrc(block.arguments ?? {}, result);
  return src !== undefined && /^(data:|https?:)/.test(src.trim()) ? src.trim() : undefined;
}

/** Map one tool-call block (+ its result) to a chain step and optional canvas tab. */
export function mapToolStep(
  block: ToolCallBlock,
  result: ToolResultMsg | undefined,
  running: boolean,
): MappedStep {
  const args = block.arguments ?? {};
  // Resolve the tool through the registry (its OWN icon + label + verb), then —
  // for a read whose target is a SKILL / tool-instructions file — reclassify the
  // generic `read` to the distinct `skill` kind (Wave B #3a). Only a read-ish
  // tool is promoted; an edit to a skill file stays an edit.
  const resolution = resolveTool(block.name);
  let kind = resolution.kind;
  const path = pickPath(args);
  if (kind === 'read' && isSkillPath(path)) kind = 'skill';
  const filename = baseName(path);
  const status = running ? 'running' : 'done';
  const label = labelFor(kind, resolution, running);
  // The step's PRIMARY arg, surfaced inline next to the verb (jedd round-2 #2):
  // "Read a file: <path>", "Ran: <cmd>", "Searched: <query>". The UI shows a
  // path's basename on the collapsed row and the full value in the reveal.
  const command = str(args.command) ?? str(args.code) ?? str(args.script) ?? str(args.source);
  const query = str(args.query) ?? str(args.q);
  const url = str(args.url) ?? str(args.href) ?? str(args.link);

  switch (kind) {
    case 'bash':
      return {
        data: { kind, label, status, detail: command, command, output: str(result?.text) },
      };
    case 'python':
      return {
        data: { kind, label, status, detail: command, command, output: str(result?.text) },
      };
    case 'edit':
      return { data: { kind, label, status, detail: path, filename, diff: editDiff(args) } };
    case 'search': {
      const { results, note } = parseSearchOutcome(result);
      return {
        data: {
          kind,
          label,
          status,
          detail: query,
          query,
          results,
          // Surfaced by the empty state so "0 results" explains itself (e.g. a
          // rate-limit note) instead of being a silent dead-end.
          note,
        },
      };
    }
    case 'browser-navigate':
    case 'browser-click':
    case 'browser-type':
    case 'browser-read':
      return {
        data: {
          kind,
          label,
          status,
          detail: url,
          url,
          // Only the read/snapshot step expands the page text it returned.
          preview: kind === 'browser-read' ? str(result?.text) : undefined,
        },
      };
    case 'image':
    case 'pdf': {
      const src = pickMediaSrc(args, result);
      const mediaType = kind === 'pdf' ? 'PDF' : 'PNG';
      return {
        data: { kind, label, status, filename, opensInCanvas: true },
        tabSpec: {
          kind,
          key: block.id,
          title: filename ?? mediaType,
          mediaSrc: src,
          mediaType,
          // Intentionally UNCONTROLLED: MediaPreviewSurface derives load/loaded/
          // error from the media element's own events. Seeding a controlled
          // status here froze it on the spinner (B1) — a missing src now falls
          // to the surface's self-managed error path.
        },
      };
    }
    case 'skill':
      // A skill/instructions read: same inline-preview shape as a file read, but
      // its own kind → "Read a skill" + sparkle glyph in the chain.
      return {
        data: { kind: 'skill', label, status, detail: path, filename, preview: str(result?.text) },
      };
    case 'connector':
      // "Used <connector icon> <connector name>": the connector's brand mark
      // (mcp-lite connector-icons) + a name-derived label. The reveal shows the
      // raw call args (Input) + the tool result (Output).
      return {
        data: {
          kind: 'connector',
          label,
          status,
          detail: primaryArg(args),
          ...(resolution.connectorId !== undefined
            ? { iconSvg: connectorIconSvg(resolution.connectorId) }
            : {}),
          argsText: formatArgs(args),
          output: str(result?.text),
        },
      };
    case 'tool-search':
    case 'tool':
      // tool_search + the NEUTRAL generic fallback: a distinct glyph + humanized
      // name, args + result revealed on click. NEVER a mislabeled "Read a file".
      return {
        data: {
          kind,
          label,
          status,
          detail: primaryArg(args),
          argsText: formatArgs(args),
          output: str(result?.text),
        },
      };
    default:
      // read / file-preview: show the tool output inline.
      return {
        data: { kind: 'read', label, status, detail: path, filename, preview: str(result?.text) },
      };
  }
}

/**
 * Map a thinking block to a chain step (thought text expands inline). An
 * optional `durationMs` (derived from turn/tool timing by the caller — the
 * engine carries no per-block timestamps) feeds the aggregated summary line so
 * it can read "thought for Xm Ys". Only a positive value is attached.
 */
export function mapThinkingStep(
  block: ThinkingBlock,
  running: boolean,
  durationMs?: number,
): MappedStep {
  return {
    data: {
      kind: 'thinking',
      label: stepLabel('thinking', running),
      status: running ? 'running' : 'done',
      thought: block.thinking.length > 0 ? block.thinking : undefined,
      ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
    },
  };
}
