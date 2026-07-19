/**
 * Pull the LIVE (still-being-typed) content of a file a corp worker is writing
 * straight out of the per-node {@link CorpBlock} accumulator — the SAME growing
 * text the qwen model streams when its tool-call grammar fails and a
 * `<function=write><parameter=content>…</parameter></function>` call lands in
 * assistant CONTENT instead of a structured tool frame. The write's body grows
 * token by token inside a `text` (or `thinking`) block, so this reads the PARTIAL
 * content (before `</parameter>`/`</function>` arrive) as well as a settled call.
 *
 * This is the source the corp canvas file tab renders from, so the file TYPES IN
 * character-by-character exactly like the normal chat's streaming write (whose
 * `contentHint` comes from the write tool's args). The assembled product-peek is
 * empty mid-run, so it is only a fallback — the live truth is here, in the store.
 *
 * Pure / no React / no stores — unit-testable from a hand-built block sequence.
 */
import type { CorpBlock } from '../../state/corp-store';

/** Tool names whose streamed body this surfaces as a live file (whole-file writes). */
const WRITE_NAMES = new Set(['write', 'edit']);
/** Parameter keys carrying the whole-file body (mirrors `wholeFileContent`). */
const CONTENT_KEYS = ['content', 'file_text', 'contents'];
/** Parameter keys naming the target path (mirrors `pickPath`). */
const PATH_KEYS = ['path', 'file_path', 'filename', 'file', 'target_file'];

/** One live file write reconstructed from a worker's streamed content. */
export interface LiveFileWrite {
  /** Target path, exactly as the model addressed it. */
  path: string;
  /** The content typed SO FAR — grows across deltas; may be partial. */
  content: string;
  /** The write is still being typed (its content/region hasn't closed yet). */
  streaming: boolean;
}

/** True when a path is an HTML document (drives the live preview tab). */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path.trim());
}

/** Find one `<parameter=KEY>` value in `body` (Hermes/Qwen arg tag): the text up
 * to the first `</parameter>` (`closed`), or the remainder when it hasn't closed
 * yet (`!closed`, i.e. still streaming). Tries the keys in priority order. */
function paramValue(
  body: string,
  keys: readonly string[],
): { value: string; closed: boolean } | undefined {
  for (const key of keys) {
    const opener = new RegExp(
      `<parameter(?:\\s*=\\s*|\\s+name\\s*=\\s*)["']?${key}["']?\\s*>`,
      'i',
    );
    const m = opener.exec(body);
    if (m === null || m.index === undefined) continue;
    const rest = body.slice(m.index + m[0].length);
    const closeIdx = rest.search(/<\/parameter\s*>/i);
    return closeIdx === -1
      ? { value: rest, closed: false }
      : { value: rest.slice(0, closeIdx), closed: true };
  }
  return undefined;
}

/** Drop a leading newline the chat template pads the body with, plus a trailing
 * PARTIAL close tag (`</paramet…`, `</functi…`) mid-stream so no half-written
 * scaffolding flickers into the file/preview. Complete content already stops at
 * the real `</parameter>`, so this only touches the live tail. */
function normalizeContent(raw: string): string {
  const deLed = raw.replace(/^\r?\n/, '');
  for (const closer of ['</parameter>', '</function>']) {
    for (let len = Math.min(closer.length - 1, deLed.length); len >= 2; len -= 1) {
      const prefix = closer.slice(0, len);
      if (prefix.startsWith('</') && deLed.endsWith(prefix)) {
        return deLed.slice(0, deLed.length - len);
      }
    }
  }
  return deLed;
}

/**
 * Parse every write in ONE block of streamed text into its {@link LiveFileWrite}.
 * Handles the in-flight case (an opener with no `</function>`/`</parameter>` yet)
 * so the content is available the instant the model starts typing it. A write is
 * only surfaced once its PATH parameter has closed (so a tab can be keyed); its
 * content may still be mid-stream.
 */
function parseWritesFromText(text: string, blockStreaming: boolean): LiveFileWrite[] {
  const openerRe = /<function\s*=\s*["']?([a-zA-Z0-9_.-]+)["']?\s*>/gi;
  const openers: { name: string; bodyStart: number; openerStart: number }[] = [];
  let m: RegExpExecArray | null = openerRe.exec(text);
  while (m !== null) {
    openers.push({
      name: (m[1] ?? '').toLowerCase(),
      bodyStart: m.index + m[0].length,
      openerStart: m.index,
    });
    m = openerRe.exec(text);
  }

  const out: LiveFileWrite[] = [];
  for (let i = 0; i < openers.length; i += 1) {
    const op = openers[i];
    if (op === undefined || !WRITE_NAMES.has(op.name)) continue;
    // The body runs to this call's `</function>` (complete) — or, while streaming,
    // to the next call's opener / the end of the text (partial).
    const nextOpenerStart = openers[i + 1]?.openerStart ?? text.length;
    const closeRel = text.slice(op.bodyStart).search(/<\/function\s*>/i);
    const closed = closeRel !== -1 && op.bodyStart + closeRel <= nextOpenerStart;
    const bodyEnd = closed ? op.bodyStart + closeRel : nextOpenerStart;
    const body = text.slice(op.bodyStart, bodyEnd);

    const pathParam = paramValue(body, PATH_KEYS);
    // Need a SETTLED path to key a stable tab; a still-typing path waits a beat.
    if (pathParam === undefined || !pathParam.closed) continue;
    const path = pathParam.value.trim();
    if (path.length === 0) continue;

    const contentParam = paramValue(body, CONTENT_KEYS);
    const content = normalizeContent(contentParam?.value ?? '');
    const streaming =
      blockStreaming || !closed || contentParam === undefined || !contentParam.closed;
    out.push({ path, content, streaming });
  }
  return out;
}

/**
 * Every live write across a node's blocks (text + thinking carry written calls),
 * de-duplicated by path with the LAST write winning — so the tab reflects the
 * newest state, matching `detectFileWrites`.
 */
export function liveFileWrites(blocks: readonly CorpBlock[]): LiveFileWrite[] {
  const byPath = new Map<string, LiveFileWrite>();
  for (const block of blocks) {
    if (block.kind !== 'text' && block.kind !== 'thinking') continue;
    for (const write of parseWritesFromText(block.text, block.streaming)) {
      byPath.set(write.path, write);
    }
  }
  return [...byPath.values()];
}

/**
 * The newest live write to `relPath` across ALL nodes' blocks, or undefined when
 * nothing in the store is being written there (the caller falls back to the
 * assembled product peek). Matches on the exact path or a suffix, since a worker
 * may address a file relatively while a click targets its longer form.
 */
export function liveFileContentForPath(
  workerBlocks: Record<string, readonly CorpBlock[]>,
  relPath: string,
): LiveFileWrite | undefined {
  const matches = (p: string): boolean =>
    p === relPath || p.endsWith(relPath) || relPath.endsWith(p);
  let best: LiveFileWrite | undefined;
  for (const blocks of Object.values(workerBlocks)) {
    // Text-form `<function=write>` bodies (the qwen grammar-failure shape)…
    for (const write of liveFileWrites(blocks)) {
      if (matches(write.path)) best = write;
    }
    // …AND the structured `write`/`edit` body the engine now captures on the file
    // block — so a click / refresh renders the ACTUAL file, not a blank peek.
    for (const block of blocks) {
      if (block.kind === 'file' && block.content !== undefined && matches(block.path)) {
        best = { path: block.path, content: block.content, streaming: false };
      }
    }
  }
  return best;
}

/** The ONE file a node is showing in the canvas right now — its newest write. */
export interface CorpFileView {
  /** Target path, exactly as the worker addressed it. */
  path: string;
  /** The body to render — the structured write's captured content wins, else the
   * streamed text-form body; `''` for a write whose body hasn't landed yet. */
  content: string;
  /** Still being written (the body hasn't settled). */
  streaming: boolean;
  /** The AUTHORITATIVE +N/−N — the file block's counts (the SAME number the chat
   * activity row shows). Absent for a pure text-form write with no file block. */
  addedLines?: number;
  removedLines?: number;
}

/**
 * The single file a node's canvas tab should show right now: the NEWEST file it is
 * writing, combining the two capture paths —
 *  - a STRUCTURED `write`/`edit` (a {@link CorpBlock} `file` block, which now carries
 *    the whole body + the authoritative +N/−N), and
 *  - a TEXT-FORM `<function=write>` streamed inside a text/thinking block
 *    (`liveFileWrites`) —
 * so one code tab per node reflects the latest write, its body typed in live, with
 * the file block's line counts as the one authoritative badge (never a content-
 * derived count). Returns `undefined` when the node has written nothing yet.
 */
export function currentCorpFile(blocks: readonly CorpBlock[]): CorpFileView | undefined {
  // Authoritative badge + captured body per path, from the structured file blocks.
  const structured = new Map<string, { added: number; removed: number; content?: string }>();
  for (const b of blocks) {
    if (b.kind === 'file' && b.path.length > 0) {
      structured.set(b.path, {
        added: b.addedLines,
        removed: b.removedLines,
        ...(b.content !== undefined ? { content: b.content } : {}),
      });
    }
  }
  // The LAST file-bearing block (structured OR text-form) is the current file.
  const textWrites = new Map<string, LiveFileWrite>();
  let currentPath: string | undefined;
  for (const b of blocks) {
    if (b.kind === 'file' && b.path.length > 0) {
      currentPath = b.path;
    } else if (b.kind === 'text' || b.kind === 'thinking') {
      const writes = parseWritesFromText(b.text, b.streaming);
      const last = writes[writes.length - 1];
      if (last !== undefined) {
        textWrites.set(last.path, last);
        currentPath = last.path;
      }
    }
  }
  if (currentPath === undefined) return undefined;
  const struct = structured.get(currentPath);
  const textW = textWrites.get(currentPath);
  const content = struct?.content ?? textW?.content ?? '';
  // A structured write with a captured body has settled; otherwise defer to the
  // text-form write's own streaming flag (a body-less structured start is still live).
  const streaming =
    struct?.content !== undefined ? false : (textW?.streaming ?? struct !== undefined);
  return {
    path: currentPath,
    content,
    streaming,
    ...(struct !== undefined ? { addedLines: struct.added, removedLines: struct.removed } : {}),
  };
}

/** One shell command a node ran, with its captured output (for the live terminal). */
export interface CorpBashStep {
  command: string;
  output: string;
}

/**
 * Every bash command a node ran, in order — each a `$ cmd` + its captured output.
 * The corp terminal router joins these into ONE per-node terminal mirror (reused
 * across commands), instead of a fresh terminal tab per command.
 */
export function corpBashSteps(blocks: readonly CorpBlock[]): CorpBashStep[] {
  const steps: CorpBashStep[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool' && b.toolName === 'bash') {
      steps.push({ command: b.detail ?? '', output: b.output ?? '' });
    }
  }
  return steps;
}
