/**
 * Pure adapter: a watched corp agent's live activity → pi-slice
 * `AssistantMsg`/`ContentBlock` shapes, so the corp feed renders through the
 * EXACT same pipeline the normal chat uses ({@link AssistantGroup} →
 * `segmentGroup` → `Markdown` + `ThreadActivityChain`). Both the PUSH path (the
 * per-node block accumulator, folded to a `WorkerTranscriptView` by
 * `CorpChatStream`) and the poll FALLBACK feed the same `WorkerTranscriptView`,
 * so this one converter serves every corp surface.
 *
 * Why this fixes the old feed:
 *  - a text-delta → a `text` block GROWN in place, a thinking-delta → a
 *    `thinking` block grown in place, a tool/file step → a `toolCall` block — the
 *    same block kinds pi streams, so `AssistantGroup`'s append-stable segment keys
 *    reconcile instead of re-mounting the whole chain on every new block, and a
 *    thinking run renders as an ActivityChain (its rail shows WHILE streaming),
 *    never a component that swaps type when it settles.
 *  - a tool call the local model wrote as TEXT (the qwen grammar-failure shape) is
 *    split OUT of a SETTLED text/thinking block into its own `toolCall` block via
 *    the shared {@link reconstructToolCallFromContent} parser, so it renders as a
 *    real bash / "writing <file>" activity row instead of a raw markup wall — the
 *    prose around it stays prose. The shapes caught: a `<function=NAME>…</function>`
 *    span (optionally `<tool_call>`-wrapped), a JSON-form `<tool_call>{"name":…,
 *    "arguments"|"parameters":{…}}</tool_call>` envelope, a bare `<tool_call>…
 *    </tool_call>` wrapper, and any orphan scaffolding token (`<tool_call>`,
 *    `</tool_call>`, `</function>`, `<parameter=…>`) left by a partial parse — none
 *    ever render as literal XML. Mid-stream (an opener whose tag hasn't closed yet)
 *    the scaffolding is SUPPRESSED: prose before the opener stays, everything from
 *    the opener on is dropped until the block settles into a real activity row.
 *  - a live file write's `+N/−N` rides the `toolCall` block's `addedLines` so the
 *    real edit row's ±stat counts up.
 *
 * No React, no stores — unit-testable from a hand-built line/transcript sequence.
 */

import type { WorkerTranscriptLine, WorkerTranscriptView } from '@pi-desktop/coordination';
import type { AssistantMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import {
  findToolCallOpener,
  findWrittenToolCallRegion,
  reconstructToolCallFromContent,
  stripToolCallScaffolding,
} from '@pi-desktop/provider-llamacpp/repair';
import { toolStepKind } from '../activity-mapping';

/** The corp role-agent built-in tools the text-form salvage resolves written
 * calls to. Kept focused on the real tools so ordinary prose that merely names a
 * tool stays prose (the parser also requires a call SHAPE + parseable args). */
export const CORP_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'glob',
  'rg',
  'web_search',
  'web_fetch',
] as const;

/** A synthetic message id all corp blocks hang off (positional segment keys). */
const CORP_MSG_ID = 'corp';

type ToolCallBlock = Extract<ContentBlock, { type: 'toolCall' }>;

// ---------------------------------------------------------------------------
// Text-form tool-call split (display-only) — a SETTLED text/thinking block whose
// content carries a written tool call is split into [prose?, toolCall, prose?].
// Shapes: a `<function=NAME>…</function>` span (optionally `<tool_call>`-wrapped),
// a JSON-form `<tool_call>{"name":…}</tool_call>` envelope, a bare `<tool_call>…
// </tool_call>` wrapper, and orphan scaffolding tokens (scrubbed, never rendered
// raw). The parsing (region finding, scaffolding scrub) is shared from `repair`;
// the WHEN-to-split / streaming-suppression policy lives here.
// ---------------------------------------------------------------------------

/** One `<function=NAME>…</function>` region, optionally wrapped by `<tool_call>`. */
const FUNCTION_SPAN_RE =
  /(?:<tool_call>\s*)?<function\s*=\s*["']?[a-zA-Z0-9_.-]+["']?\s*>[\s\S]*?<\/function>(?:\s*<\/tool_call>)?/;

/** Locate the first function-tag span in `text`, or null when there isn't one. */
function findFunctionSpan(text: string): { before: string; span: string; after: string } | null {
  const m = FUNCTION_SPAN_RE.exec(text);
  if (m === null || m.index === undefined) return null;
  const start = m.index;
  const end = start + m[0].length;
  return { before: text.slice(0, start), span: m[0], after: text.slice(end) };
}

/** Build a `toolCall` block from a reconstructed call (id derived from the source). */
function toolCallBlock(id: string, name: string, args: Record<string, unknown>): ToolCallBlock {
  return { type: 'toolCall', id, name, arguments: args };
}

/**
 * Assemble the ordered blocks for a matched tool-call region: prose `before`
 * (scaffolding scrubbed) → the reconstructed `toolCall` (or, when the region
 * doesn't reconstruct to a known call, its scaffolding-scrubbed text so no raw tag
 * leaks) → prose `after`. Empty segments are dropped.
 */
function assembleSplit(
  before: string,
  region: string,
  after: string,
  idBase: string,
  textLike: (t: string) => ContentBlock,
): ContentBlock[] {
  const out: ContentBlock[] = [];
  const beforeClean = stripToolCallScaffolding(before).trim();
  if (beforeClean.length > 0) out.push(textLike(beforeClean));
  const call = reconstructToolCallFromContent(region, CORP_TOOL_NAMES);
  if (call !== undefined) {
    out.push(toolCallBlock(`${idBase}-tc`, call.toolName, call.arguments));
  } else {
    const regionClean = stripToolCallScaffolding(region).trim();
    if (regionClean.length > 0) out.push(textLike(regionClean));
  }
  const afterClean = stripToolCallScaffolding(after).trim();
  if (afterClean.length > 0) out.push(textLike(afterClean));
  return out;
}

/**
 * Split a SETTLED text/thinking block's content when it carries a written tool
 * call, returning the ordered blocks (prose stays `kind`, the call becomes a
 * `toolCall`). Returns null when there's nothing to salvage — the caller keeps the
 * plain block. Never called for a streaming block (an incomplete tag is suppressed
 * upstream in {@link streamingBlocks}, not split).
 */
function splitWrittenToolCall(
  kind: 'text' | 'thinking',
  text: string,
  idBase: string,
): ContentBlock[] | null {
  const textLike = (t: string): ContentBlock =>
    kind === 'text' ? { type: 'text', text: t } : { type: 'thinking', thinking: t };

  // (A) A `<function=NAME>…</function>` span (optionally `<tool_call>`-wrapped).
  const span = findFunctionSpan(text);
  if (span !== null) return assembleSplit(span.before, span.span, span.after, idBase, textLike);

  // (B) A `<tool_call>…</tool_call>` wrapper — JSON-form `{"name":…}` or bare.
  const region = findWrittenToolCallRegion(text);
  if (region !== null) {
    return assembleSplit(region.before, region.region, region.after, idBase, textLike);
  }

  // (C) A block that IS just a call envelope (`{"name":…,"arguments":…}` or a bare
  // `<NAME>{…}` tag) → the whole block becomes the call. Guarded to a payload-led
  // block so prose that merely mentions a tool never reconstructs.
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<')) {
    const call = reconstructToolCallFromContent(text, CORP_TOOL_NAMES);
    if (call !== undefined && (call.shape === 'envelope-json' || call.shape === 'function-tag')) {
      return [toolCallBlock(`${idBase}-tc`, call.toolName, call.arguments)];
    }
  }

  // (D) Orphan scaffolding tokens with no full region — scrub them so a stray
  // `</tool_call>` / `</function>` / `<parameter=…>` never renders as raw text.
  const cleaned = stripToolCallScaffolding(text);
  if (cleaned !== text) {
    const t = cleaned.trim();
    return t.length > 0 ? [textLike(t)] : [];
  }
  return null;
}

/** Minimal placeholder shown for the open (as-yet-unclosed) span of a streaming
 * written tool call, so the raw scaffolding is never seen and a live block still
 * renders until the call settles into its real activity row. */
const STREAMING_TOOL_CALL_PLACEHOLDER = 'Preparing tool call…';

/**
 * A STILL-STREAMING text/thinking line. While a written tool call is open its
 * scaffolding must never show raw: keep any prose BEFORE the first opener, and
 * suppress everything from the opener on (the tag is as-yet-unclosed) — it becomes
 * a real activity row once the block settles. When nothing but the open scaffolding
 * remains, a minimal "preparing…" placeholder stands in (never raw XML). With no
 * opener but a stray scaffolding token present, scrub the token; otherwise the
 * ordinary streaming path (JSON fence / live prose) applies.
 */
function streamingBlocks(kind: 'text' | 'thinking', text: string): ContentBlock[] {
  const textLike = (t: string): ContentBlock =>
    kind === 'text' ? { type: 'text', text: t } : { type: 'thinking', thinking: t };

  const openerIdx = findToolCallOpener(text);
  if (openerIdx !== -1) {
    const before = stripToolCallScaffolding(text.slice(0, openerIdx)).trimEnd();
    return [textLike(before.length > 0 ? before : STREAMING_TOOL_CALL_PLACEHOLDER)];
  }
  const cleaned = stripToolCallScaffolding(text);
  if (cleaned !== text) {
    const kept = cleaned.trimEnd();
    return kept.length > 0 ? [textLike(kept)] : [];
  }
  if (kind === 'text') {
    const fenced = jsonFence(text, true);
    return [{ type: 'text', text: fenced ?? text }];
  }
  return [{ type: 'thinking', thinking: text }];
}

// ---------------------------------------------------------------------------
// Structured-JSON fencing — a message that IS a JSON payload (a manager emitting
// its contracts as raw assistant text) renders as a fenced ```json code block
// through the SAME Markdown the normal chat uses, never a raw blob.
// ---------------------------------------------------------------------------

/** A code fence guaranteed longer than any backtick run inside `body`. */
function fenceFor(body: string): string {
  const longest = body.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * When `text` is a JSON payload, the fenced ```json markdown source for it
 * (pretty-printed when the model emitted a minified one-liner); else null (prose).
 * A still-streaming brace-led tail can't parse yet, so it is fenced on trust.
 */
function jsonFence(text: string, streaming: boolean): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  let body = trimmed;
  if (!streaming) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!trimmed.includes('\n')) body = JSON.stringify(parsed, null, 2);
    } catch {
      return null; // brace-led but not JSON → ordinary prose
    }
  }
  const fence = fenceFor(body);
  return `${fence}json\n${body}\n${fence}`;
}

// ---------------------------------------------------------------------------
// Tool / file lines → toolCall blocks
// ---------------------------------------------------------------------------

/**
 * Reconstruct a tool-call's arguments from an engine `tool-call` line so
 * `mapToolStep` renders a faithful row: the human `detail` lands in the arg the
 * resolved kind reads (bash → command, search → query, browser → url, file-op →
 * path), and a `path` is always surfaced.
 */
function toolLineArgs(
  rawName: string,
  detail: string | undefined,
  path: string | undefined,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (path !== undefined && path.length > 0) args.path = path;
  if (detail === undefined || detail.length === 0) return args;
  switch (toolStepKind(rawName)) {
    case 'bash':
    case 'python':
      args.command = detail;
      break;
    case 'search':
    case 'tool-search':
      args.query = detail;
      break;
    case 'browser-navigate':
    case 'browser-click':
    case 'browser-type':
    case 'browser-read':
      args.url = detail;
      break;
    case 'read':
    case 'edit':
    case 'file':
    case 'skill':
      if (args.path === undefined) args.path = detail;
      break;
    default:
      // connector / generic tool: primaryArg reads `query` first.
      args.query = detail;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Line → block
// ---------------------------------------------------------------------------

/** Fold one transcript line into its ordered content blocks (0..n). */
function lineToBlocks(line: WorkerTranscriptLine, index: number): ContentBlock[] {
  const idBase = `${CORP_MSG_ID}-${index}`;
  const streaming = line.streaming === true;
  switch (line.kind) {
    case 'file-touch': {
      // A file write: a `write` toolCall (→ the `edit` chain row) carrying the
      // live +N/−N as explicit line counts, plus the path for the filename subline
      // and the open-in-canvas affordance.
      const path = line.path ?? line.text.replace(/^writing\s+/i, '');
      return [
        toolCallBlock(`${idBase}-file`, 'write', {
          path,
          ...(line.addedLines !== undefined ? { addedLines: line.addedLines } : {}),
          ...(line.removedLines !== undefined ? { removedLines: line.removedLines } : {}),
        }),
      ];
    }
    case 'tool-call':
      return [
        toolCallBlock(`${idBase}-tool`, line.text, toolLineArgs(line.text, line.detail, line.path)),
      ];
    case 'consult':
      // A consult reads as a generic tool row (resolveTool → neutral `tool`).
      return [toolCallBlock(`${idBase}-consult`, 'consult', line.text ? { query: line.text } : {})];
    case 'note': {
      // Legacy turn markers ("— continued (turn 2) —") are pure noise — dropped.
      if (/^—\s*.+\s*—$/.test(line.text)) return [];
      return line.text.length > 0 ? [{ type: 'text', text: line.text }] : [];
    }
    case 'thinking': {
      // Mid-stream: suppress any open tool-call scaffolding (prose before it kept).
      if (streaming) return streamingBlocks('thinking', line.text);
      const split = splitWrittenToolCall('thinking', line.text, idBase);
      if (split !== null) return split;
      return [{ type: 'thinking', thinking: line.text }];
    }
    default: {
      // A `message` line. Mid-stream: suppress any open tool-call scaffolding. Once
      // SETTLED, a written tool call splits out; else a JSON payload fences to a
      // code block; else plain prose.
      if (streaming) return streamingBlocks('text', line.text);
      const split = splitWrittenToolCall('text', line.text, idBase);
      if (split !== null) return split;
      const fenced = jsonFence(line.text, false);
      return [{ type: 'text', text: fenced ?? line.text }];
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A watched corp node's live view, ready for {@link AssistantGroup}. */
export interface CorpAssistantView {
  /** One synthetic assistant message carrying every block (positional keys). */
  group: AssistantMsg[];
  /** Synthetic done-results for every settled tool call, so ONLY the current
   * action shimmers while working (the chain derives running from a missing
   * result + the live turn). Empty when the node isn't working. */
  resultByCallId: Map<string, ToolResultMsg>;
}

/** The corp node's transcript lines → ordered content blocks (stable by index). */
export function transcriptToBlocks(lines: readonly WorkerTranscriptLine[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  lines.forEach((line, i) => {
    for (const block of lineToBlocks(line, i)) out.push(block);
  });
  return out;
}

/**
 * A `WorkerTranscriptView` → the {@link CorpAssistantView} the corp feed renders
 * through {@link AssistantGroup}. `working` marks the node live: the group streams
 * (its last run stays expanded with its rail, the trailing action shimmers) and
 * settles the moment work ends (chains collapse, thoughts fold to "Thought").
 */
export function transcriptToAssistantView(
  transcript: WorkerTranscriptView,
  working: boolean,
): CorpAssistantView {
  const blocks = transcriptToBlocks(transcript.lines);
  const group: AssistantMsg[] = [
    { kind: 'assistant', id: CORP_MSG_ID, blocks, isStreaming: working, timestamp: 0 },
  ];

  // Only the LAST tool call may run (it is the current action / in the live run);
  // give every earlier tool call a settled result so it never shimmers. When the
  // node isn't working nothing runs at all, so no synthesis is needed.
  const resultByCallId = new Map<string, ToolResultMsg>();
  if (working) {
    const toolIds = blocks
      .filter((b): b is ToolCallBlock => b.type === 'toolCall')
      .map((b) => b.id);
    for (let i = 0; i < toolIds.length - 1; i++) {
      const id = toolIds[i];
      if (id === undefined) continue;
      resultByCallId.set(id, {
        kind: 'toolResult',
        id: `corp-res-${id}`,
        toolCallId: id,
        toolName: '',
        text: '',
        isError: false,
        timestamp: 0,
      });
    }
  }
  return { group, resultByCallId };
}
