/**
 * Event router — translates the pi RPC event stream into StoreSink mutations.
 *
 * Ported from RemotePi desktop/src/lib/event-router.ts, with the Zustand store
 * swapped for the {@link StoreSink} interface. All defensive behaviors kept:
 *
 * - Tool rows are synthesized whenever a result/execution event references a
 *   toolCallId that never got a toolcall_start (providers stream args
 *   differently). Hiding tool calls is a trust violation — the user must
 *   always see that a tool ran.
 * - Streaming tool args are peeked (first 512 chars only) for a file path so
 *   the artifacts pane can open before the tool finishes; past 512 chars the
 *   scan is abandoned to keep streaming smooth.
 * - Only error-level notifications surface via `notify`; info/success/warning
 *   are status chatter and are dropped (errors-only toast policy).
 *
 * Adaptation for pi 0.68.1: `toolcall_start`/`toolcall_delta` no longer carry
 * `id`/`name`/`arguments` at the top level — the tool call lives at
 * `partial.content[contentIndex]`. The router reads both shapes (legacy fields
 * first) so recorded transcripts from older pi versions still replay.
 */
import type { ToolResultMsg } from '../types/chat';
import {
  type AssistantMessage,
  decodeAskUserPlaceholder,
  type PiBridgeEvent,
  type RpcExtensionUIRequest,
  type ThinkingLevel,
  type ToolCall,
} from '../types/rpc';
import type { StoreSink } from './store-sink';

export interface EventRouterOptions {
  /** Deterministic id source for tests. Default: prefix-timestamp-counter. */
  nextId?: (prefix: string) => string;
  /** Clock override for tests. */
  now?: () => number;
}

export interface EventRouter {
  handleEvent(event: PiBridgeEvent): void;
  /** Drop per-run bookkeeping (e.g. after a bridge restart). */
  reset(): void;
}

/** Stop scanning streamed args for a path once this many chars accumulated. */
const PATH_PEEK_LIMIT = 512;
const PATH_PEEK_RE = /"(?:path|file_path|file)"\s*:\s*"([^"]+)"/;

/** pi's dialog-expiry timer starts before the request reaches us — expire our
 * side strictly after pi resolves so we never drop a still-answerable dialog. */
const UI_EXPIRY_GRACE_MS = 250;

/** Legacy (pre-0.68) fields on toolcall_* stream events. Wire boundary: pi
 * versions differ, so these are read defensively rather than trusted. */
interface LegacyToolcallFields {
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  argsDelta?: string;
}

export function createEventRouter(sink: StoreSink, options: EventRouterOptions = {}): EventRouter {
  let counter = 0;
  const now = options.now ?? Date.now;
  const nextId = options.nextId ?? ((prefix: string) => `${prefix}-${now()}-${++counter}`);

  let currentAssistantId: string | null = null;
  /** toolCall ids already shown inline (dedupes synthesis paths). */
  const knownToolCalls = new Set<string>();
  /** callId → tool name, so legacy deltas (no partial) can resolve opFor.
   * (RemotePi read this back from the store; the router owns it here.) */
  const callNames = new Map<string, string>();
  /** toolCall ids that already produced an artifact candidate (or gave up). */
  const pushedForCall = new Set<string>();
  /** toolCall ids whose parsed arguments already reached the row (toolcall_end
   * or the tool_execution_start fallback) — so we carry args through exactly
   * once and never re-finalize a call that already has them. */
  const finalizedCalls = new Set<string>();
  /** Streamed-args accumulator per call, capped at the peek limit. */
  const argsAccum = new Map<string, string>();
  /** contentIndex → callId for 0.68.1 deltas that omit the call id. */
  const callIdByIndex = new Map<number, string>();
  /** Dialog request id → self-expiry timer (pi emits nothing on expiry). */
  const uiTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function reset(): void {
    currentAssistantId = null;
    knownToolCalls.clear();
    callNames.clear();
    pushedForCall.clear();
    finalizedCalls.clear();
    argsAccum.clear();
    callIdByIndex.clear();
    for (const timer of uiTimers.values()) clearTimeout(timer);
    uiTimers.clear();
  }

  function beginToolCallOnce(callId: string, name: string, args: Record<string, unknown>): boolean {
    if (currentAssistantId === null || knownToolCalls.has(callId)) return false;
    knownToolCalls.add(callId);
    callNames.set(callId, name);
    sink.beginToolCall(currentAssistantId, { type: 'toolCall', id: callId, name, arguments: args });
    return true;
  }

  function pushFileCandidate(
    path: string,
    op: 'read' | 'write' | 'edit',
    toolCallId: string | undefined,
    toolName: string | undefined,
  ): void {
    sink.artifactCandidate({ kind: 'file', path, op, toolCallId, toolName });
  }

  function upsertResultRow(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
    timestamp: number,
  ): void {
    // Rows are keyed per owning turn: index-as-id providers reuse toolCallIds
    // across turns/runs, and a bare `tr-<callId>` id would overwrite earlier
    // history. Intra-turn dedupe (tool_execution_end then turn_end delivering
    // the same result) still holds — both fire under the same assistant id.
    const assistantId = currentAssistantId ?? undefined;
    const row: ToolResultMsg = {
      kind: 'toolResult',
      id: assistantId !== undefined ? `tr-${assistantId}-${toolCallId}` : `tr-${toolCallId}`,
      toolCallId,
      ...(assistantId !== undefined && { assistantId }),
      toolName,
      text: extractToolResultText(result),
      isError,
      timestamp,
    };
    sink.upsertToolResult(row);
  }

  function handleExtensionUiRequest(e: RpcExtensionUIRequest): void {
    switch (e.method) {
      case 'notify': {
        // Errors only. info/success/warning are status chatter ("✓ LLM up",
        // "tool finished in 0.5s"...) — real apps don't popcorn the user.
        if ((e.notifyType ?? 'info') === 'error') {
          sink.notify('error', stripAnsi(e.message ?? ''));
        }
        break;
      }
      case 'setStatus':
        sink.setExtensionStatus(e.statusKey ?? '_', e.statusText);
        break;
      case 'setWidget':
        sink.setWidget(e.widgetKey ?? '_', e.widgetLines, e.widgetPlacement ?? 'aboveEditor');
        break;
      case 'setTitle':
        sink.setTitle(e.title ?? '');
        break;
      case 'set_editor_text':
        sink.setComposerText(e.text ?? '');
        break;
      case 'confirm':
      case 'select':
      case 'input':
      case 'editor': {
        const req = e as RpcExtensionUIRequest & {
          message?: string;
          options?: string[];
          placeholder?: string;
          prefill?: string;
          timeout?: number;
        };
        // A harness `ask_user` question rides on the open-ended `input` method:
        // its placeholder carries a sentinel-tagged rich spec (multi-select /
        // slider / …) pi's frozen protocol can't express. Decode it into a
        // synthetic `askUser` dialog the QuestionCard renders; anything else is
        // a plain input. The reply still round-trips as the input's string value.
        const ask = e.method === 'input' ? decodeAskUserPlaceholder(req.placeholder) : null;
        sink.uiRequest({
          id: e.id,
          method: ask !== null ? 'askUser' : e.method,
          title: e.title,
          message: req.message,
          options: req.options,
          placeholder: ask !== null ? undefined : req.placeholder,
          prefill: req.prefill,
          timeout: req.timeout,
          ...(ask !== null ? { ask } : {}),
        });
        // pi auto-resolves the dialog on its side at `timeout` and emits NO
        // event, so the router must self-expire the request from the store or
        // it lingers as an unanswerable zombie dialog.
        if (typeof req.timeout === 'number' && req.timeout > 0) {
          const requestId = e.id;
          const existing = uiTimers.get(requestId);
          if (existing !== undefined) clearTimeout(existing);
          uiTimers.set(
            requestId,
            setTimeout(() => {
              uiTimers.delete(requestId);
              sink.resolveUiRequest(requestId);
            }, req.timeout + UI_EXPIRY_GRACE_MS),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  function handleEvent(e: PiBridgeEvent): void {
    switch (e.type) {
      case 'agent_start':
        sink.agentStart();
        sink.setAgentStatus({ isStreaming: true, agentStartedAt: now() });
        break;

      case 'agent_end':
        sink.agentEnd();
        sink.setAgentStatus({ isStreaming: false, agentStartedAt: null });
        reset();
        break;

      case 'turn_start':
        currentAssistantId = nextId('a');
        sink.beginAssistantTurn(currentAssistantId);
        break;

      case 'turn_end': {
        const message = e.message;
        // `!= null`: a JSON null message must be treated like an absent one — a
        // `=== undefined` guard lets null through and `message.role` then throws.
        const assistant = message != null && message.role === 'assistant' ? message : undefined;
        if (currentAssistantId !== null) {
          sink.endTurn(currentAssistantId, assistant?.stopReason, assistant);
        }
        // Tool results emitted with the turn — push them as separate rows.
        for (const tr of e.toolResults ?? []) {
          // CRITICAL: if pi never emitted a toolcall_start for this result
          // (some providers stream args differently), synthesize a toolCall
          // block NOW so the user always sees the tool was used. Hiding tool
          // calls is a trust violation.
          if (tr?.toolCallId) {
            // Legacy transcripts carried args at tr.toolArgs; 0.68.1 may
            // stash them in details. `tr?.` so a null entry is silently skipped.
            const legacyArgs = asRecord((tr as { toolArgs?: unknown }).toolArgs);
            const args =
              Object.keys(legacyArgs).length > 0 ? legacyArgs : argsFromResultDetails(tr.details);
            beginToolCallOnce(tr.toolCallId, tr.toolName || 'tool', args);
            upsertResultRow(
              tr.toolCallId,
              tr.toolName || 'tool',
              tr,
              Boolean(tr.isError),
              tr.timestamp ?? now(),
            );
          }
        }
        currentAssistantId = null;
        callIdByIndex.clear();
        // Per-turn bookkeeping ends with the turn: turn_end carries the turn's
        // toolResults, so no event for these calls arrives later — and
        // index-as-id providers ('call_0' per request) reuse ids in the next
        // turn, which must render as new rows, not dedupe against these.
        knownToolCalls.clear();
        callNames.clear();
        pushedForCall.clear();
        finalizedCalls.clear();
        argsAccum.clear();
        break;
      }

      case 'message_start':
        callIdByIndex.clear();
        break;

      case 'message_update': {
        const ev = e.assistantMessageEvent;
        // `== null`: a JSON null event is as good as absent — `=== undefined`
        // would let null fall through to `ev.type` below and throw.
        if (ev == null || currentAssistantId === null) return;
        const legacy = ev as unknown as LegacyToolcallFields;
        switch (ev.type) {
          case 'text_delta':
            sink.appendTextDelta(currentAssistantId, ev.delta ?? '');
            break;
          case 'thinking_delta':
            sink.appendThinkingDelta(currentAssistantId, ev.delta ?? '');
            break;
          case 'toolcall_start': {
            const block = toolCallAt(ev.partial, ev.contentIndex);
            // `||`, not `??`: index-as-id providers emit '' ids, which would
            // collapse every call in the run onto one row.
            const callId = legacy.id || block?.id || nextId('tc');
            const name = legacy.name ?? block?.name ?? 'tool';
            const args = legacy.arguments ?? block?.arguments ?? {};
            callIdByIndex.set(ev.contentIndex ?? -1, callId);
            if (beginToolCallOnce(callId, name, args)) {
              // If args were sent upfront (some providers do), push to the
              // artifacts pane immediately so the user sees the focus.
              const startPath = pathFromArgs(args);
              const startOp = opFor(name);
              if (startPath !== undefined && startOp !== null) {
                pushedForCall.add(callId);
                pushFileCandidate(startPath, startOp, callId, name);
              }
            }
            break;
          }
          case 'toolcall_delta': {
            const block = toolCallAt(ev.partial, ev.contentIndex);
            const callId = legacy.id ?? callIdByIndex.get(ev.contentIndex ?? -1) ?? block?.id;
            if (callId === undefined) break;
            const delta = ev.delta ?? legacy.argsDelta ?? '';
            sink.appendToolCallArgs(currentAssistantId, callId, delta);
            // PEEK the streaming JSON buffer to extract the file path early,
            // so the artifacts pane opens before the tool finishes. Only once
            // per call, and ONLY within the first ~512 accumulated chars —
            // past that the path is either there or it's not, and scanning a
            // 10KB content string on every delta tanks streaming perf.
            if (!pushedForCall.has(callId)) {
              const buf = (argsAccum.get(callId) ?? '') + delta;
              argsAccum.set(callId, buf.slice(0, PATH_PEEK_LIMIT + 1));
              // Always scan the capped window — a single large delta (many
              // servers deliver complete args in one chunk) can carry the
              // path well inside the first 512 chars while blowing past the
              // limit in one step.
              const peekWindow = buf.slice(0, PATH_PEEK_LIMIT);
              const match = peekWindow.match(PATH_PEEK_RE);
              if (match?.[1] !== undefined) {
                const name = block?.name ?? callNames.get(callId);
                const op = opFor(name ?? '');
                if (op !== null) {
                  pushedForCall.add(callId);
                  pushFileCandidate(match[1], op, callId, name);
                }
              }
              // Window full: the path is either found or never coming — stop
              // scanning to keep streaming smooth (also stops rescans for
              // non-workspace tools like bash whose paths matched op null).
              if (buf.length >= PATH_PEEK_LIMIT) pushedForCall.add(callId);
            }
            break;
          }
          case 'toolcall_end': {
            const toolCall = ev.toolCall;
            // `!= null`: a null toolCall is absent — a `!== undefined` guard lets
            // it through and the `toolCall.id`/`.name` reads below then throw.
            if (toolCall != null) {
              // Empty-id providers: resolve the router-generated id that the
              // streamed block was registered under, else finalize misses it.
              const callId =
                toolCall.id || callIdByIndex.get(ev.contentIndex ?? -1) || nextId('tc');
              // Defensive: if the start event was dropped, still show the call.
              beginToolCallOnce(callId, toolCall.name, toolCall.arguments);
              sink.finalizeToolCall(currentAssistantId, callId, toolCall);
              finalizedCalls.add(callId);
            }
            break;
          }
          default:
            // start/text_start/text_end/thinking_start/thinking_end are
            // no-ops (first delta creates the block); done/error resolve at
            // turn_end.
            break;
        }
        break;
      }

      case 'message_end':
        // Block content is stable; streaming flag stays set until turn_end.
        break;

      case 'tool_execution_start': {
        // CRITICAL real-time path: this is when the tool ACTUALLY starts
        // running. The user must see (1) the tool-call row inline NOW and
        // (2) the artifacts pane focus the file IMMEDIATELY — without this
        // the UI looks frozen during long writes.
        const args = asRecord(e.args);
        const filePath = pathFromArgs(args);
        const op = opFor(e.toolName ?? '');
        // `||`: empty-string ids count as missing (index-as-id providers).
        const callId = e.toolCallId || nextId('te');
        const created = beginToolCallOnce(callId, e.toolName ?? 'tool', args);
        if (created && filePath !== undefined) {
          pushedForCall.add(callId);
        }
        // Carry the ACTUAL invocation args onto the row even when the block was
        // already registered by a toolcall_start that streamed empty/partial args
        // and no toolcall_end followed (some providers). Execution args are
        // authoritative, so the activity row can finally surface the primary arg
        // (path/command/query). Only when we truly have args (never wipe a
        // populated block with {}), and only once per call.
        if (
          !created &&
          currentAssistantId !== null &&
          !finalizedCalls.has(callId) &&
          Object.keys(args).length > 0
        ) {
          finalizedCalls.add(callId);
          sink.finalizeToolCall(currentAssistantId, callId, {
            type: 'toolCall',
            id: callId,
            name: e.toolName ?? 'tool',
            arguments: args,
          });
        }
        if (filePath !== undefined && op !== null) {
          pushFileCandidate(filePath, op, callId, e.toolName);
        }
        // browser_use / web_fetch — surface the URL being fetched.
        const name = (e.toolName ?? '').toLowerCase();
        if (name === 'browser_use' || name === 'web_fetch' || name.startsWith('browser.')) {
          const targetUrl = args.url ?? args.uri;
          if (typeof targetUrl === 'string') {
            sink.artifactCandidate({ kind: 'url', url: targetUrl, toolName: e.toolName });
          }
        }
        sink.toolExecutionStart(callId, e.toolName ?? 'tool', e.args);
        break;
      }

      case 'tool_execution_update':
        sink.toolExecutionUpdate(e.toolCallId, e.toolName ?? 'tool', e.partialResult);
        break;

      case 'tool_execution_end': {
        // Result also arrives in turn_end; handle here defensively AND
        // synthesize a toolCall block if one was never registered, so every
        // tool execution is always visible inline.
        if (e.toolCallId) {
          // args is a legacy field on tool_execution_end (wire boundary).
          const legacyArgs = asRecord((e as { args?: unknown }).args);
          beginToolCallOnce(e.toolCallId, e.toolName ?? 'tool', legacyArgs);
          if (e.result !== undefined) {
            upsertResultRow(
              e.toolCallId,
              e.toolName ?? 'tool',
              e.result,
              Boolean(e.isError),
              now(),
            );
          }
        }
        break;
      }

      case 'queue_update':
        sink.setAgentStatus({
          pendingMessageCount: (e.steering?.length ?? 0) + (e.followUp?.length ?? 0),
        });
        break;

      case 'compaction_start':
        // Silent — status surface reflects "compacting"; no toast.
        sink.setAgentStatus({ isCompacting: true });
        break;

      case 'compaction_end':
        sink.setAgentStatus({ isCompacting: false });
        if (e.errorMessage !== undefined && e.errorMessage !== '' && e.aborted !== true) {
          sink.notify('error', `Compaction failed: ${e.errorMessage}`);
        }
        break;

      case 'auto_retry_start':
        // Silent — pi is just retrying; a real failure surfaces through the
        // message stream. Track state so the footer can show it.
        sink.setAgentStatus({ retry: { attempt: e.attempt, maxAttempts: e.maxAttempts } });
        break;

      case 'auto_retry_end':
        sink.setAgentStatus({ retry: null });
        break;

      case 'extension_error':
        sink.notify('error', `Extension error: ${stripAnsi(String(e.error ?? ''))}`);
        break;

      case 'extension_ui_request':
        handleExtensionUiRequest(e);
        break;

      case 'response':
        // The bridge resolves the command promise; the get_state response
        // (readiness probe) doubles as an initial status snapshot.
        if (e.success === false) {
          // Failed RPCs (unknown command from version drift, rejected input)
          // must be visible — the promise rejection alone can be swallowed by
          // fire-and-forget callers, and id-less failures reach only here.
          sink.notify('error', `pi rejected ${e.command}: ${e.error}`);
        } else if (e.command === 'get_state') {
          const state = e.data;
          sink.setAgentStatus({
            isStreaming: state.isStreaming,
            isCompacting: state.isCompacting,
            pendingMessageCount: state.pendingMessageCount,
            thinkingLevel: state.thinkingLevel,
            // != null: docs/rpc.md sanctions `model: null`; 0.68.1 omits it.
            model:
              state.model != null
                ? { id: state.model.id, name: state.model.name, provider: state.model.provider }
                : null,
          });
          sink.sessionChanged({ sessionFile: state.sessionFile, sessionId: state.sessionId });
        }
        break;

      case '_stderr': {
        // Surface non-trivial stderr but skip bracketed log noise.
        const text = e.text ?? '';
        if (text.trim().length > 0 && !/^\s*\[/.test(text)) {
          sink.stderrText?.(text);
        }
        break;
      }

      case '_unparsed':
        sink.stderrText?.(e.text ?? '');
        break;

      case '_bridge_error':
        sink.notify('error', `pi bridge error: ${e.error}`);
        break;

      case '_bridge_exit':
        // A crash mid-turn must finalize the in-flight row (its isStreaming
        // flag is only ever cleared by endTurn) and drop per-run bookkeeping,
        // or the restarted bridge inherits stale dedupe state.
        if (currentAssistantId !== null) sink.endTurn(currentAssistantId, 'error');
        reset();
        sink.setAgentStatus({ isStreaming: false, agentStartedAt: null, retry: null });
        sink.notify('error', `pi exited (${e.signal ?? e.code}).`);
        sink.bridgeExit?.({ code: e.code, signal: e.signal });
        break;

      default: {
        // Unknown event types: older pi versions emitted config/session
        // events that 0.68.1 no longer sends — handle them defensively so
        // recorded transcripts and future pi versions stay useful.
        const raw = e as unknown as {
          type?: string;
          cwd?: string;
          sessionFile?: string;
          sessionId?: string;
          modelId?: string;
          modelName?: string;
          provider?: string;
          thinkingLevel?: ThinkingLevel;
        };
        if (
          raw.type === 'session_changed' ||
          raw.type === 'session_loaded' ||
          raw.type === 'session'
        ) {
          sink.sessionChanged({
            cwd: raw.cwd,
            sessionFile: raw.sessionFile,
            sessionId: raw.sessionId,
          });
        } else if (raw.type === 'model_change' && raw.modelId !== undefined) {
          sink.setAgentStatus({
            model: {
              id: raw.modelId,
              name: raw.modelName ?? raw.modelId,
              provider: raw.provider ?? '',
            },
          });
        } else if (raw.type === 'thinking_level_change' && raw.thinkingLevel !== undefined) {
          sink.setAgentStatus({ thinkingLevel: raw.thinkingLevel });
        }
        break;
      }
    }
  }

  return { handleEvent, reset };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Map a tool name (case-insensitive) to a workspace op, or null. */
export function opFor(rawName: string): 'read' | 'write' | 'edit' | null {
  const n = (rawName || '').toLowerCase();
  if (n === 'read' || n === 'view' || n === 'open_file') return 'read';
  if (n === 'write' || n === 'create_file' || n === 'write_file') return 'write';
  if (n === 'edit' || n === 'str_replace' || n === 'str_replace_editor' || n === 'edit_file') {
    return 'edit';
  }
  return null;
}

/** Best-effort text extraction from the various tool-result shapes. */
export function extractToolResultText(tr: unknown): string {
  if (tr === undefined || tr === null) return '';
  if (typeof tr === 'string') return tr;
  const obj = tr as {
    text?: unknown;
    content?: unknown;
    output?: unknown;
  };
  if (typeof obj.text === 'string') return obj.text;
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((c: unknown) => {
        if (typeof c === 'string') return c;
        const block = c as { text?: unknown };
        return typeof block.text === 'string' ? block.text : '';
      })
      .filter((t) => t.length > 0)
      .join('\n');
  }
  if (typeof obj.output === 'string') return obj.output;
  try {
    return JSON.stringify(tr, null, 2);
  } catch {
    return String(tr);
  }
}

/** Strip ANSI escape sequences (pi extensions emit ANSI for terminal colors). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// Constructed from a string to keep literal control chars out of the source.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function pathFromArgs(args: Record<string, unknown>): string | undefined {
  const candidate = args.path ?? args.file_path ?? args.file;
  return typeof candidate === 'string' ? candidate : undefined;
}

function toolCallAt(
  partial: AssistantMessage | undefined,
  contentIndex: number | undefined,
): ToolCall | undefined {
  if (partial === undefined || contentIndex === undefined) return undefined;
  const block = partial.content?.[contentIndex];
  return block !== undefined && block.type === 'toolCall' ? block : undefined;
}

/** turn_end toolResults sometimes carry the original args in details. */
function argsFromResultDetails(details: unknown): Record<string, unknown> {
  const rec = asRecord(details);
  const args = rec.args ?? rec.toolArgs ?? rec.arguments;
  return asRecord(args);
}
