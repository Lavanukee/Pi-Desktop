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

/** Present-tense (running) / past-tense (done) label per step kind. */
const STEP_LABELS: Record<ActivityStepKind, [running: string, done: string]> = {
  thinking: ['Thinking…', 'Thought'],
  bash: ['Running a command', 'Ran a command'],
  edit: ['Editing a file', 'Edited a file'],
  read: ['Reading a file', 'Read a file'],
  file: ['Presenting a file', 'Presented a file'],
  search: ['Searching the web', 'Searched the web'],
  image: ['Generating an image', 'Generated an image'],
  pdf: ['Creating a PDF', 'Created a PDF'],
  'canvas-open': ['Opening the canvas', 'Opened the canvas'],
};

function stepLabel(kind: ActivityStepKind, running: boolean): string {
  return STEP_LABELS[kind][running ? 0 : 1];
}

/** Classify a tool name into a step kind (drives icon + summary phrasing). */
export function toolStepKind(name: string): ActivityStepKind {
  const n = name.toLowerCase();
  if (n === 'bash' || n === 'shell' || n === 'run' || n === 'exec' || n === 'run_command')
    return 'bash';
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
    return 'edit';
  if (n === 'web_search' || n === 'brave_search' || n === 'google' || n === 'search_web')
    return 'search';
  if (n.includes('image') || n === 'dalle' || n === 'generate_image' || n === 'imagegen')
    return 'image';
  if (n.includes('pdf')) return 'pdf';
  // read / cat / ls / list / glob / grep / find / fetch / browse and unknowns
  // all read-ish: a file/preview step that expands its output inline.
  return 'read';
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

/** Parse a web-search tool result into result rows, tolerant of JSON shapes. */
function parseSearchResults(result: ToolResultMsg | undefined): WebSearchResultData[] {
  if (result === undefined || result.text.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.text);
    const rows: unknown = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { results?: unknown })?.results)
        ? (parsed as { results: unknown[] }).results
        : [];
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 20).map((raw): WebSearchResultData => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const url = str(r.url) ?? str(r.link);
      return {
        title: str(r.title) ?? str(r.name) ?? url ?? 'Result',
        url,
        domain: str(r.domain) ?? hostOf(url),
      };
    });
  } catch {
    return [];
  }
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
  const kind = toolStepKind(block.name);
  const filename = baseName(pickPath(args));
  const status = running ? 'running' : 'done';
  const label = stepLabel(kind, running);

  switch (kind) {
    case 'bash':
      return {
        data: { kind, label, status, command: str(args.command), output: str(result?.text) },
      };
    case 'edit':
      return { data: { kind, label, status, filename, diff: editDiff(args) } };
    case 'search':
      return {
        data: {
          kind,
          label,
          status,
          query: str(args.query) ?? str(args.q),
          results: parseSearchResults(result),
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
    default:
      // read / file-preview: show the tool output inline.
      return { data: { kind: 'read', label, status, filename, preview: str(result?.text) } };
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
