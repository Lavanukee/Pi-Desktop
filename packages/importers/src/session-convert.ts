/**
 * Convert a Codex rollout JSONL session into a pi session v3 file (best-effort).
 *
 * Codex rollout lines are `{timestamp, type, payload}`. The `response_item`
 * stream is the canonical conversation (mirrors the OpenAI Responses API); the
 * duplicate `event_msg` stream is ignored. Mapping to pi's AgentMessage entries:
 *   - message role=user      → UserMessage  (synthetic <environment_context>/
 *                               <permissions …> wrappers dropped)
 *   - message role=assistant → AssistantMessage(text)
 *   - reasoning              → AssistantMessage(thinking) — ONLY from the plain
 *                               `summary` text; `encrypted_content` is opaque and
 *                               NEVER surfaced
 *   - function_call /        → AssistantMessage(toolCall)
 *     custom_tool_call
 *   - function_call_output / → ToolResultMessage
 *     custom_tool_call_output
 * Unknown payload types are tolerated (skipped). Entries are chained linearly
 * via id/parentId so pi's rehydrate walks them as one branch.
 */
import type {
  AssistantMessage,
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
  ToolResultMessage,
  UserMessage,
} from '@pi-desktop/engine';
import type { ConvertedCodexSession } from './types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 8-char hex entry id, deterministic in file order (pi only needs uniqueness). */
function entryId(index: number): string {
  return (index + 1).toString(16).padStart(8, '0');
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function assistantMessage(
  content: AssistantMessage['content'],
  timestamp: number,
  provider: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'codex-import',
    provider,
    model: '',
    usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
    stopReason: 'stop',
    timestamp,
  };
}

/** Join the text of a Codex message `content` array (input_text/output_text). */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/** Extract plain reasoning summary text; ignores encrypted_content entirely. */
function reasoningText(summary: unknown): string {
  if (!Array.isArray(summary)) return '';
  const parts: string[] = [];
  for (const block of summary) {
    if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** Codex tool-call arguments arrive as a JSON string (or an object for custom
 * tools). Parse to a record; fall back to wrapping the raw value. */
function toolArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : { value: raw };
    } catch {
      return { value: raw };
    }
  }
  return {};
}

/** Codex tool output is usually a string; tolerate structured shapes. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  return JSON.stringify(output);
}

const SYNTHETIC_USER_PREFIXES = ['<environment_context>', '<permissions'];

function isSyntheticUser(text: string): boolean {
  const t = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((p) => t.startsWith(p));
}

interface ConvertOptions {
  /** Override the session id (else session_meta.id). */
  sessionId?: string;
  /** Override the cwd (else session_meta.cwd). */
  cwd?: string;
}

/**
 * @returns the converted session, or null when the rollout lacks the session id
 * or cwd needed to place the pi session file.
 */
export function convertCodexSession(
  jsonl: string,
  opts: ConvertOptions = {},
): ConvertedCodexSession | null {
  let meta: Record<string, unknown> | null = null;
  const items: Array<{ timestamp: string; payload: Record<string, unknown> }> = [];

  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    const timestamp = str(obj.timestamp) ?? '';
    if (obj.type === 'session_meta' && isRecord(obj.payload)) {
      meta = obj.payload;
    } else if (obj.type === 'response_item' && isRecord(obj.payload)) {
      items.push({ timestamp, payload: obj.payload });
    }
  }

  const sessionId = opts.sessionId ?? str(meta?.id);
  const cwd = opts.cwd ?? str(meta?.cwd);
  if (!sessionId || !cwd) return null;

  const startedAt = str(meta?.timestamp) ?? items[0]?.timestamp ?? new Date().toISOString();
  const provider = str(meta?.model_provider) ?? 'codex';

  const toolNames = new Map<string, string>();
  const built: Array<{ timestamp: string; message: SessionMessageEntry['message'] }> = [];

  for (const { timestamp, payload } of items) {
    const tsMs = Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : Date.now();
    const ptype = payload.type;

    if (ptype === 'message') {
      const text = messageText(payload.content);
      if (!text) continue;
      if (payload.role === 'user') {
        if (isSyntheticUser(text)) continue;
        const message: UserMessage = {
          role: 'user',
          content: [{ type: 'text', text }],
          timestamp: tsMs,
        };
        built.push({ timestamp, message });
      } else if (payload.role === 'assistant') {
        built.push({
          timestamp,
          message: assistantMessage([{ type: 'text', text }], tsMs, provider),
        });
      }
      // developer/system roles: dropped.
    } else if (ptype === 'reasoning') {
      const thinking = reasoningText(payload.summary);
      if (!thinking) continue;
      built.push({
        timestamp,
        message: assistantMessage([{ type: 'thinking', thinking }], tsMs, provider),
      });
    } else if (ptype === 'function_call' || ptype === 'custom_tool_call') {
      const callId = str(payload.call_id) ?? str(payload.id);
      if (!callId) continue;
      const name = str(payload.name) ?? 'tool';
      toolNames.set(callId, name);
      built.push({
        timestamp,
        message: assistantMessage(
          [
            {
              type: 'toolCall',
              id: callId,
              name,
              arguments: toolArgs(payload.arguments ?? payload.input),
            },
          ],
          tsMs,
          provider,
        ),
      });
    } else if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
      const callId = str(payload.call_id);
      if (!callId) continue;
      const message: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: callId,
        toolName: toolNames.get(callId) ?? 'tool',
        content: [{ type: 'text', text: outputText(payload.output) }],
        isError: false,
        timestamp: tsMs,
      };
      built.push({ timestamp, message });
    }
  }

  const header: SessionHeader = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: startedAt,
    cwd,
  };

  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  built.forEach(({ timestamp, message }, i) => {
    const id = entryId(i);
    entries.push({ type: 'message', id, parentId, timestamp: timestamp || startedAt, message });
    parentId = id;
  });

  const messageCount = built.filter(
    ({ message }) => message.role === 'user' || message.role === 'assistant',
  ).length;

  const jsonlOut = `${[JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join('\n')}\n`;

  return { sessionId, cwd, startedAt, messageCount, header, entries, jsonl: jsonlOut };
}
