/**
 * Typed transcription of the pi RPC protocol (`pi --mode rpc`, JSONL over stdio).
 *
 * Authoritative sources for @mariozechner/pi-coding-agent@0.68.1:
 * - docs/rpc.md (protocol + framing rules)
 * - dist/modes/rpc/rpc-types.d.ts (RpcCommand / RpcResponse / extension UI unions)
 * - @mariozechner/pi-agent-core dist/types.d.ts (AgentEvent)
 * - @mariozechner/pi-ai dist/types.d.ts (messages, content blocks, AssistantMessageEvent)
 * - docs/session.md (session JSONL v3 entry types)
 *
 * Transcribed rather than imported so the wire contract is pinned in-repo: a pi
 * upgrade that shifts shapes becomes a reviewable diff here instead of a silent
 * type drift underneath the app.
 */

// ---------------------------------------------------------------------------
// Content blocks & messages (pi-ai)
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  /** base64-encoded data. */
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
}

export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface UserMessage {
  role: 'user';
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  /** Tool-specific metadata (wire boundary; validated by consumers). */
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

/** Created by the `bash` RPC command (not by LLM tool calls). */
export interface BashExecutionMessage {
  role: 'bashExecution';
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  /** true for `!!`-prefixed commands excluded from LLM context. */
  excludeFromContext?: boolean;
  timestamp: number;
}

/** Extension-injected message that participates in LLM context. */
export interface CustomMessage {
  role: 'custom';
  /** Extension identifier. */
  customType: string;
  content: string | (TextContent | ImageContent)[];
  /** Whether the message should be shown in UIs. */
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: 'branchSummary';
  summary: string;
  /** Entry the branch diverged from. */
  fromId: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary';
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

// ---------------------------------------------------------------------------
// Model & session state
// ---------------------------------------------------------------------------

export interface Model {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
}

export interface ContextUsage {
  /** Estimated context tokens; null right after compaction until the next response. */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface RpcSessionState {
  /** docs/rpc.md: "a full Model object or `null`" — 0.68.1's runtime omits the
   * field instead, so both absent and null must be handled. */
  model?: Model | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: 'all' | 'one-at-a-time';
  followUpMode: 'all' | 'one-at-a-time';
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}

export interface BashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

/** Where a slash command was loaded from. */
export interface SourceInfo {
  path: string;
  source: string;
  scope: string;
  origin: string;
  baseDir?: string;
}

export interface RpcSlashCommand {
  /** Command name (invoke via prompt with a leading slash). */
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
  sourceInfo: SourceInfo;
}

// ---------------------------------------------------------------------------
// Commands (client → pi, stdin)
// ---------------------------------------------------------------------------

export type RpcCommand =
  | {
      id?: string;
      type: 'prompt';
      message: string;
      images?: ImageContent[];
      /** Required when the agent is already streaming. */
      streamingBehavior?: 'steer' | 'followUp';
    }
  | { id?: string; type: 'steer'; message: string; images?: ImageContent[] }
  | { id?: string; type: 'follow_up'; message: string; images?: ImageContent[] }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'new_session'; parentSession?: string }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'cycle_model' }
  | { id?: string; type: 'get_available_models' }
  | { id?: string; type: 'set_thinking_level'; level: ThinkingLevel }
  | { id?: string; type: 'cycle_thinking_level' }
  | { id?: string; type: 'set_steering_mode'; mode: 'all' | 'one-at-a-time' }
  | { id?: string; type: 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
  | { id?: string; type: 'compact'; customInstructions?: string }
  | { id?: string; type: 'set_auto_compaction'; enabled: boolean }
  | { id?: string; type: 'set_auto_retry'; enabled: boolean }
  | { id?: string; type: 'abort_retry' }
  | { id?: string; type: 'bash'; command: string }
  | { id?: string; type: 'abort_bash' }
  | { id?: string; type: 'get_session_stats' }
  | { id?: string; type: 'export_html'; outputPath?: string }
  | { id?: string; type: 'switch_session'; sessionPath: string }
  | { id?: string; type: 'fork'; entryId: string }
  | { id?: string; type: 'clone' }
  | { id?: string; type: 'get_fork_messages' }
  | { id?: string; type: 'get_last_assistant_text' }
  | { id?: string; type: 'set_session_name'; name: string }
  | { id?: string; type: 'get_messages' }
  | { id?: string; type: 'get_commands' };

export type RpcCommandType = RpcCommand['type'];

// ---------------------------------------------------------------------------
// Responses (pi → client, stdout; correlated by `id`)
// ---------------------------------------------------------------------------

/** Response `data` payload per command type; `undefined` = no data field. */
export interface RpcResponseDataMap {
  prompt: undefined;
  steer: undefined;
  follow_up: undefined;
  abort: undefined;
  new_session: { cancelled: boolean };
  get_state: RpcSessionState;
  set_model: Model;
  cycle_model: { model: Model; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
  get_available_models: { models: Model[] };
  set_thinking_level: undefined;
  cycle_thinking_level: { level: ThinkingLevel } | null;
  set_steering_mode: undefined;
  set_follow_up_mode: undefined;
  compact: CompactionResult;
  set_auto_compaction: undefined;
  set_auto_retry: undefined;
  abort_retry: undefined;
  bash: BashResult;
  abort_bash: undefined;
  get_session_stats: SessionStats;
  export_html: { path: string };
  switch_session: { cancelled: boolean };
  fork: { text: string; cancelled: boolean };
  clone: { cancelled: boolean };
  get_fork_messages: { messages: Array<{ entryId: string; text: string }> };
  get_last_assistant_text: { text: string | null };
  set_session_name: undefined;
  get_messages: { messages: AgentMessage[] };
  get_commands: { commands: RpcSlashCommand[] };
}

export type RpcSuccessResponse<C extends RpcCommandType = RpcCommandType> = C extends RpcCommandType
  ? RpcResponseDataMap[C] extends undefined
    ? { id?: string; type: 'response'; command: C; success: true }
    : { id?: string; type: 'response'; command: C; success: true; data: RpcResponseDataMap[C] }
  : never;

/** Failures carry the echoed command name, or `"parse"` for unparseable input. */
export interface RpcErrorResponse {
  id?: string;
  type: 'response';
  command: string;
  success: false;
  error: string;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

// ---------------------------------------------------------------------------
// Streaming events (pi → client, stdout; no `id` field)
// ---------------------------------------------------------------------------

/** Delta protocol inside `message_update` events. */
export type AssistantMessageEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | {
      type: 'done';
      reason: Extract<StopReason, 'stop' | 'length' | 'toolUse'>;
      message: AssistantMessage;
    }
  | {
      type: 'error';
      reason: Extract<StopReason, 'aborted' | 'error'>;
      error: AssistantMessage;
    };

/** Tool result payload on tool_execution_update/_end (AgentToolResult upstream). */
export interface ToolExecutionResult {
  content: (TextContent | ImageContent)[];
  details?: unknown;
}

export type PiAgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      args: unknown;
      /** Accumulated output so far (not a delta) — replace, don't append. */
      partialResult: ToolExecutionResult;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: ToolExecutionResult;
      isError: boolean;
    }
  | { type: 'queue_update'; steering: readonly string[]; followUp: readonly string[] }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' }
  | {
      type: 'compaction_end';
      reason: 'manual' | 'threshold' | 'overflow';
      result: CompactionResult | undefined;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: 'auto_retry_start';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: 'extension_error'; extensionPath?: string; event?: string; error: string };

// ---------------------------------------------------------------------------
// Extension UI sub-protocol
// ---------------------------------------------------------------------------

/** Dialog methods block pi until an {@link RpcExtensionUIResponse} arrives. */
export type ExtensionUiDialogMethod = 'confirm' | 'select' | 'input' | 'editor';

export type RpcExtensionUIRequest =
  | {
      type: 'extension_ui_request';
      id: string;
      method: 'select';
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: 'extension_ui_request';
      id: string;
      method: 'confirm';
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: 'extension_ui_request';
      id: string;
      method: 'input';
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: 'extension_ui_request';
      id: string;
      method: 'editor';
      title: string;
      prefill?: string;
    }
  | {
      type: 'extension_ui_request';
      id: string;
      method: 'notify';
      message: string;
      notifyType?: 'info' | 'warning' | 'error';
    }
  | {
      type: 'extension_ui_request';
      id: string;
      method: 'setStatus';
      statusKey: string;
      statusText: string | undefined;
    }
  | {
      type: 'extension_ui_request';
      id: string;
      method: 'setWidget';
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: 'aboveEditor' | 'belowEditor';
    }
  | { type: 'extension_ui_request'; id: string; method: 'setTitle'; title: string }
  | { type: 'extension_ui_request'; id: string; method: 'set_editor_text'; text: string };

export type RpcExtensionUIResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true };

/** Answer payload for {@link RpcExtensionUIResponse} minus the envelope fields. */
export type ExtensionUiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

// ---------------------------------------------------------------------------
// Everything pi writes to stdout, plus bridge-synthesized diagnostics
// ---------------------------------------------------------------------------

export type PiEvent = PiAgentEvent | RpcExtensionUIRequest | RpcResponse;

/**
 * Synthetic events the bridge injects into the same stream (all `_`-prefixed;
 * never on the wire).
 */
export type PiBridgeSyntheticEvent =
  | { type: '_stderr'; text: string }
  | { type: '_unparsed'; text: string }
  | { type: '_bridge_error'; error: string }
  | { type: '_bridge_exit'; code: number | null; signal: string | null };

export type PiBridgeEvent = PiEvent | PiBridgeSyntheticEvent;

// ---------------------------------------------------------------------------
// Session JSONL v3 entries (docs/session.md)
// ---------------------------------------------------------------------------

/** First line of a session file. Not part of the entry tree. */
export interface SessionHeader {
  type: 'session';
  /** Absent on version-1 files (pi computes `header?.version ?? 1`). */
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  /** 8-char hex entry id. */
  id: string;
  /** null for the first entry; entries form a tree for in-place branching. */
  parentId: string | null;
  /** ISO timestamp. */
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: 'message';
  message: AgentMessage;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: 'model_change';
  provider: string;
  modelId: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: 'thinking_level_change';
  thinkingLevel: ThinkingLevel;
}

export interface CompactionEntry extends SessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: 'branch_summary';
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
}

/** Extension state persistence; not part of LLM context. */
export interface CustomEntry extends SessionEntryBase {
  type: 'custom';
  customType: string;
  data?: unknown;
}

/** Extension-injected message that participates in LLM context. */
export interface CustomMessageEntry extends SessionEntryBase {
  type: 'custom_message';
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
}

export interface LabelEntry extends SessionEntryBase {
  type: 'label';
  targetId: string;
  label?: string;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: 'session_info';
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type SessionLine = SessionHeader | SessionEntry;
