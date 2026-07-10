/**
 * StoreSink — the minimal mutation surface the event router drives.
 *
 * The router translates the pi RPC event stream into calls on this interface;
 * any state container (Zustand slice, test recorder, headless harness) can
 * implement it. Methods are fire-and-forget mutations: the router never reads
 * state back (it keeps its own bookkeeping), so implementations are free to
 * batch, debounce, or persist however they like.
 *
 * Deliberate omissions:
 * - No `timerTick`: the router marks `agentStartedAt` in {@link AgentStatusPatch};
 *   a live elapsed timer is a pure UI concern (rAF/interval off that timestamp).
 * - Non-error notifications never reach `notify` — the router enforces the
 *   errors-only policy ("real apps don't popcorn the user with success toasts").
 */
import type { ChatMsg, ContentBlock, ToolResultMsg } from '../types/chat';
import type {
  AssistantMessage,
  ExtensionUiDialogMethod,
  StopReason,
  ThinkingLevel,
  ToolCall,
  ToolExecutionResult,
} from '../types/rpc';

/** Partial update of agent-level status. Only present keys change. */
export interface AgentStatusPatch {
  isStreaming?: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
  /** Auto-retry in progress; null clears. */
  retry?: { attempt: number; maxAttempts: number } | null;
  /** Epoch ms when the current agent run started; null when idle. */
  agentStartedAt?: number | null;
  model?: { id: string; name: string; provider: string } | null;
  thinkingLevel?: ThinkingLevel;
}

export interface SessionChangeInfo {
  sessionFile?: string;
  sessionId?: string;
  cwd?: string;
}

/** A blocking extension dialog; answer via PiBridge.respondUi with this id. */
export interface UiDialogRequest {
  id: string;
  method: ExtensionUiDialogMethod;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** ms; pi auto-resolves its side with a default on expiry but emits NO
   * event. The router runs the expiry timer and calls
   * {@link StoreSink.resolveUiRequest} — answers sent after that are ids pi
   * already resolved and are dropped by the bridge. */
  timeout?: number;
}

/**
 * Something the agent is visibly working on that an artifacts/canvas pane can
 * open and focus in real time (W7 consumes these).
 */
export type ArtifactCandidate =
  | {
      kind: 'file';
      path: string;
      op: 'read' | 'write' | 'edit';
      toolCallId?: string;
      toolName?: string;
    }
  | { kind: 'url'; url: string; toolName?: string };

export type NotifyLevel = 'info' | 'warning' | 'error';

export interface StoreSink {
  // -- agent run lifecycle --------------------------------------------------
  agentStart(): void;
  agentEnd(): void;

  // -- assistant turn / streaming blocks ------------------------------------
  /** A new assistant message row begins; id is router-generated. */
  beginAssistantTurn(id: string): void;
  /** The turn's assistant message is final. `message` is pi's complete
   * AssistantMessage when available (model, usage, errorMessage...). */
  endTurn(id: string, stopReason?: StopReason, message?: AssistantMessage): void;
  appendTextDelta(id: string, delta: string): void;
  appendThinkingDelta(id: string, delta: string): void;

  // -- tool calls ------------------------------------------------------------
  /** Append a toolCall block (streamed start or router-synthesized). */
  beginToolCall(id: string, call: Extract<ContentBlock, { type: 'toolCall' }>): void;
  /** Raw argument-JSON fragment for a streaming tool call. */
  appendToolCallArgs(id: string, callId: string, argsDelta: string): void;
  /** Complete tool call (parsed arguments) — replaces the streamed block data. */
  finalizeToolCall(id: string, callId: string, toolCall: ToolCall): void;

  // -- tool execution --------------------------------------------------------
  toolExecutionStart(callId: string, toolName: string, args: unknown): void;
  /** `partialResult` is accumulated output — replace, don't append. */
  toolExecutionUpdate(callId: string, toolName: string, partialResult: ToolExecutionResult): void;
  /** Insert-or-replace keyed by `result.id` (assistant-scoped, NOT bare
   * toolCallId — providers reuse toolCallIds across turns/runs): the same
   * result can legally arrive twice within a turn (tool_execution_end, then
   * turn_end's toolResults) and must land on one row. */
  upsertToolResult(result: ToolResultMsg): void;

  // -- session / status -------------------------------------------------------
  setAgentStatus(patch: AgentStatusPatch): void;
  sessionChanged(info: SessionChangeInfo): void;
  /** Bulk-replace messages (rehydration after switch_session/get_messages). */
  setMessages(messages: ChatMsg[]): void;

  // -- extension UI -----------------------------------------------------------
  /** Errors only (router policy); level kept for future policy changes. */
  notify(level: NotifyLevel, message: string): void;
  /** Blocking dialog awaiting a respondUi answer. */
  uiRequest(request: UiDialogRequest): void;
  /** Remove a dialog from state: called by the router when a timed dialog
   * expires (pi auto-resolved it silently); implementations should also call
   * their own removal path when the user answers. */
  resolveUiRequest(id: string): void;
  /** Extension footer/status entry; undefined text clears the key. */
  setExtensionStatus(key: string, text: string | undefined): void;
  /** Extension widget lines; undefined lines clear the key. */
  setWidget(
    key: string,
    lines: string[] | undefined,
    placement: 'aboveEditor' | 'belowEditor',
  ): void;
  setTitle(title: string): void;
  setComposerText(text: string): void;

  // -- artifacts ----------------------------------------------------------------
  artifactCandidate(candidate: ArtifactCandidate): void;

  // -- optional diagnostics ------------------------------------------------------
  /** pi stderr chunks that pass the router's noise filter. */
  stderrText?(text: string): void;
  /** The pi child exited; the bridge must be restarted to continue. */
  bridgeExit?(info: { code: number | null; signal: string | null }): void;
}
