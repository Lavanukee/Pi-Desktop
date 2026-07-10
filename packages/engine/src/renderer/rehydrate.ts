/**
 * rehydrate — convert pi history into store-ready ChatMsg entries.
 *
 * Two entry points:
 * - {@link rehydrateMessages}: from the `get_messages` RPC response
 *   (AgentMessage[]).
 * - {@link parseSessionJsonl} + {@link sessionMessages}: from a raw session
 *   JSONL v3 file (walks the entry tree from the leaf, so branched sessions
 *   rehydrate the active branch only).
 *
 * Ported from RemotePi desktop/src/lib/rehydrate.ts; returns ChatMsg[] instead
 * of writing to a store. The output union matches what the live event router
 * pushes, so the UI never cares whether messages came from history or live.
 */
import type { AssistantMsg, ChatMsg, ContentBlock } from '../types/chat';
import type { AgentMessage, SessionEntry, SessionHeader, TextContent } from '../types/rpc';
import { extractToolResultText } from './event-router';

export function rehydrateMessages(raw: AgentMessage[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-h${counter++}`;

  for (const m of raw) {
    if (m === undefined || m === null) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
    switch (m.role) {
      case 'user': {
        const images = imageDataUris(m.content);
        out.push({
          kind: 'user',
          id: nextId('u'),
          text: extractText(m.content),
          ...(images.length > 0 && { images }),
          timestamp: ts,
        });
        break;
      }
      case 'assistant': {
        const blocks: ContentBlock[] = [];
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c === undefined || c === null || typeof c.type !== 'string') continue;
          if (c.type === 'text') {
            blocks.push({ type: 'text', text: c.text ?? '' });
          } else if (c.type === 'thinking') {
            blocks.push({ type: 'thinking', thinking: c.thinking ?? '' });
          } else if (c.type === 'toolCall') {
            blocks.push({
              type: 'toolCall',
              id: c.id ?? nextId('tc'),
              name: c.name ?? 'tool',
              arguments: c.arguments ?? {},
            });
          }
        }
        const assistant: AssistantMsg = {
          kind: 'assistant',
          id: nextId('a'),
          blocks,
          timestamp: ts,
          stopReason: m.stopReason,
          errorMessage: m.errorMessage,
          model: m.model,
          provider: m.provider,
          usage: m.usage,
          isStreaming: false,
        };
        out.push(assistant);
        break;
      }
      case 'toolResult':
        out.push({
          kind: 'toolResult',
          id: nextId('tr'),
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          text: extractToolResultText(m),
          isError: Boolean(m.isError),
          timestamp: ts,
        });
        break;
      case 'bashExecution':
        out.push({
          kind: 'bashExec',
          id: nextId('be'),
          command: m.command ?? '',
          output: m.output ?? '',
          exitCode: typeof m.exitCode === 'number' ? m.exitCode : 0,
          timestamp: ts,
        });
        break;
      default:
        // custom / branchSummary / compactionSummary: context plumbing, not
        // chat rows. W3 may surface displayable customs later.
        break;
    }
  }
  return out;
}

export interface ParsedSession {
  header: SessionHeader | null;
  entries: SessionEntry[];
}

/**
 * Parse a session JSONL file (any version). Tolerates a corrupt/truncated
 * trailing line (crash mid-append) by skipping unparseable lines.
 *
 * Legacy files are migrated the same way pi's session-manager does on load:
 * v1 files are a linear sequence WITHOUT id/parentId (ids are synthesized
 * into a chain here), and v2 message entries may carry the pre-v3
 * 'hookMessage' role (renamed to 'custom').
 */
export function parseSessionJsonl(text: string): ParsedSession {
  let header: SessionHeader | null = null;
  const rawEntries: Record<string, unknown>[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (record.type === 'session') {
      header = record as unknown as SessionHeader;
    } else if (typeof record.type === 'string') {
      rawEntries.push(record);
    }
  }
  // v1 headers predate the version field (pi computes `header?.version ?? 1`).
  const version = header?.version ?? 1;
  return { header, entries: migrateEntries(rawEntries, version) };
}

/**
 * Port of pi's load-time migrations (session-manager migrateV1ToV2/V2ToV3):
 * v1 entries get synthesized ids chained linearly; pre-v3 'hookMessage'
 * message roles become 'custom'. v1 compaction entries carry
 * firstKeptEntryIndex instead of firstKeptEntryId — passed through as-is,
 * since rendering only walks type==='message' entries.
 */
function migrateEntries(rawEntries: Record<string, unknown>[], version: number): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let prevId: string | null = null;
  for (const raw of rawEntries) {
    let record = raw;
    if (version < 2) {
      record = { ...record, id: `v1-${entries.length + 1}`, parentId: prevId };
    } else if (typeof record.id !== 'string') {
      // v2+ garbage tolerance: tree entries must carry ids.
      continue;
    }
    if (version < 3 && record.type === 'message') {
      const message = record.message as { role?: unknown } | null | undefined;
      if (message !== null && typeof message === 'object' && message.role === 'hookMessage') {
        record = { ...record, message: { ...message, role: 'custom' } };
      }
    }
    const entry = record as unknown as SessionEntry;
    entries.push(entry);
    prevId = entry.id;
  }
  return entries;
}

export interface SessionBranch {
  messages: AgentMessage[];
  /**
   * True when the leaf→root walk hit a dangling non-null parentId (a corrupt
   * or missing mid-file entry): everything before the break is not returned.
   * Callers should surface a "history may be incomplete" notice. The branch
   * is deliberately NOT reconstructed from skipped entries — the rendered
   * transcript must stay byte-for-byte consistent with pi's own context walk.
   */
  truncated: boolean;
}

/**
 * Extract the active branch's AgentMessages from session entries.
 *
 * Entries form a tree via id/parentId; the current leaf is the most recently
 * appended entry (SessionManager append semantics). Walk leaf → root, then
 * reverse, so abandoned branches are excluded.
 */
export function sessionMessages(entries: SessionEntry[]): SessionBranch {
  const last = entries[entries.length - 1];
  if (last === undefined) return { messages: [], truncated: false };
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  const branch: SessionEntry[] = [];
  let truncated = false;
  let cursor: SessionEntry | undefined = last;
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    branch.push(cursor);
    if (cursor.parentId === null) {
      cursor = undefined;
    } else {
      const parent = byId.get(cursor.parentId);
      // Dangling parentId: the chain is broken mid-file, not at the root.
      if (parent === undefined) truncated = true;
      cursor = parent;
    }
  }
  branch.reverse();

  const messages: AgentMessage[] = [];
  for (const entry of branch) {
    if (entry.type === 'message') messages.push(entry.message);
  }
  return { messages, truncated };
}

export interface RehydratedSession {
  messages: ChatMsg[];
  /** See {@link SessionBranch.truncated}. */
  truncated: boolean;
}

/** One-shot: session JSONL text → store-ready ChatMsg[] for the active branch. */
export function rehydrateSessionJsonl(text: string): RehydratedSession {
  const branch = sessionMessages(parseSessionJsonl(text).entries);
  return { messages: rehydrateMessages(branch.messages), truncated: branch.truncated };
}

/** Image blocks → data URIs, the UserMsg.images representation (matches what
 * the composer pushes for live messages). Non-string data/mimeType skipped. */
function imageDataUris(content: string | (TextContent | { type: string })[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content) {
    const block = c as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (
      block.type === 'image' &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    ) {
      out.push(`data:${block.mimeType};base64,${block.data}`);
    }
  }
  return out;
}

function extractText(content: string | (TextContent | { type: string })[] | undefined): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        const block = c as { text?: unknown };
        return typeof block.text === 'string' ? block.text : '';
      })
      .filter((t) => t.length > 0)
      .join('\n');
  }
  return '';
}
