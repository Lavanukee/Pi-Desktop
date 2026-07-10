/**
 * Store-ready chat message shapes. The live event router and the session
 * rehydrator both emit this union, so UIs never care whether a message came
 * from a live stream or from history.
 */
import type { StopReason, Usage } from './rpc';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | {
      type: 'toolCall';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      /**
       * Raw streamed argument JSON accumulated from toolcall_delta events.
       * Present only while/if args streamed; `arguments` holds the parsed
       * form once toolcall_end (or rehydration) provides it.
       */
      argsText?: string;
    };

export interface UserMsg {
  kind: 'user';
  id: string;
  text: string;
  /** Attached images as data URIs (`data:<mimeType>;base64,<data>`) — the
   * same representation the composer pushes for live user messages, so
   * rehydrated and live rows render identically. */
  images?: string[];
  timestamp: number;
}

export interface AssistantMsg {
  kind: 'assistant';
  id: string;
  blocks: ContentBlock[];
  model?: string;
  provider?: string;
  stopReason?: StopReason;
  errorMessage?: string;
  isStreaming?: boolean;
  usage?: Usage;
  timestamp: number;
}

export interface ToolResultMsg {
  kind: 'toolResult';
  /** Router rows embed the owning assistant id (`tr-<assistantId>-<callId>`)
   * so a provider-reused toolCallId in a later turn/run never collides with
   * an earlier row. Sinks must upsert by `id`, not by `toolCallId`. */
  id: string;
  toolCallId: string;
  /** The assistant message this result belongs to (router rows only; absent
   * on rehydrated rows and orphan results arriving after turn_end). */
  assistantId?: string;
  toolName: string;
  text: string;
  isError: boolean;
  timestamp: number;
}

export interface BashExecMsg {
  kind: 'bashExec';
  id: string;
  command: string;
  output: string;
  exitCode: number;
  timestamp: number;
}

export type ChatMsg = UserMsg | AssistantMsg | ToolResultMsg | BashExecMsg;
