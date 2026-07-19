/**
 * pi renderer state (W2 stub): a Zustand store whose mutation surface
 * implements the engine's StoreSink, fed by the event router. W3 builds the
 * real chat UI on top of exactly this state; nothing here is throwaway.
 */
import type {
  AgentStatusPatch,
  ArtifactCandidate,
  AssistantMsg,
  ChatMsg,
  ContentBlock,
  NotifyLevel,
  SessionChangeInfo,
  StoreSink,
  ThinkingLevel,
  ToolResultMsg,
  UiDialogRequest,
} from '@pi-desktop/engine';
import { create } from 'zustand';
import { useCorpStore } from './corp-store';

export interface PiNotification {
  id: string;
  level: NotifyLevel;
  message: string;
  timestamp: number;
}

export interface PiAgentStatus {
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
  retry: { attempt: number; maxAttempts: number } | null;
  agentStartedAt: number | null;
  model: { id: string; name: string; provider: string } | null;
  thinkingLevel: ThinkingLevel;
}

/**
 * A set of alternate fork branches that diverge at one user message (the
 * "branch point"). pi's RPC `fork` mints a fresh session file branched at the
 * forked message's parent, so each alternate is its own session; we track them
 * app-side keyed by the divergence user-message ordinal (0-based among user
 * messages), with a rendered snapshot per branch so `‹/›` swaps the visible
 * transcript instantly (no disk round-trip), while `switch_session` keeps pi's
 * active session pointed at the shown branch.
 */
export interface BranchGroup {
  /** pi session file per branch (index 0 = the branch we first forked from). */
  files: (string | null)[];
  /** Rendered transcript snapshot per branch. The active branch's snapshot is
   *  refreshed from the live `messages` whenever we switch away from it. */
  snapshots: ChatMsg[][];
  /** Index (into files/snapshots) of the branch currently in the thread. */
  active: number;
}

/**
 * A message the user sent while a turn was still in-flight. Rather than inject
 * it into the running turn (which reorders it ahead of the in-flight reply), we
 * hold it here and dispatch it as its OWN sequential turn once the current turn
 * ends — so a rapid "hi" then "what are you doing" renders [hi, reply, what,
 * reply] instead of stacking both user rows above a single reply. Drained by the
 * in-flight→idle subscription in pi-connect.
 */
export interface QueuedSend {
  /** The visible user echo (also the fallback message body). */
  text: string;
  images: string[];
  /** Full body sent to the agent (may fold in attached text-file contents). */
  agentMessage?: string;
  /** Pinned task class (Auto-router override), passed straight to sendPrompt. */
  taskClass?: string;
}

interface PiSliceState {
  messages: ChatMsg[];
  agent: PiAgentStatus;
  session: SessionChangeInfo | null;
  /** Bumped on every session boundary (new / switch / rehydrate — every
   * `setMessagesExternal`). The composer keys its mount on it so its local editor +
   * attachment state is CLEARED across chats, and a send captures it to detect a
   * switch that raced its dispatch (so a message can't land in the wrong chat). */
  sessionEpoch: number;
  /** True from the instant the renderer dispatches a `pi:prompt` until the run
   * ends (or `agent_start` flips `isStreaming` true). Bridges the latency gap
   * between dispatch and `agent_start` — on a cold first message that gap is
   * seconds, and without this flag a 2nd message sent in it is routed as a
   * fresh send, so both user echoes land BEFORE the first assistant turn
   * (`beginAssistantTurn` appends at the end). The composer routes on
   * `isStreaming || promptInFlight` so an in-flight 2nd message is queued (not
   * merged into the running turn). */
  promptInFlight: boolean;
  /** Messages the user sent while a turn was in-flight, awaiting sequential
   * dispatch (FIFO). See {@link QueuedSend}. */
  queuedSends: QueuedSend[];
  /** Queue a send for after the current turn ends (composer → drain). */
  enqueueSend: (item: QueuedSend) => void;
  /** Tool calls currently executing (spinner state for W3 rows). */
  runningToolCalls: string[];
  extensionStatus: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: 'aboveEditor' | 'belowEditor' }>;
  notifications: PiNotification[];
  uiRequests: UiDialogRequest[];
  artifacts: ArtifactCandidate[];
  composerText: string;
  windowTitle: string | null;
  /**
   * True once the user has explicitly renamed THIS session's title, which pins
   * it: the harness's auto-generated title must not clobber a user rename. Reset
   * on every session switch/new (setMessagesExternal) so a fresh conversation is
   * eligible for auto-titling again. Set by `setSessionName` (pi-connect).
   */
  titleLocked: boolean;
  bridgeExited: { code: number | null; signal: string | null } | null;
  /** Set true by restartPi / model-switch before a DELIBERATE dispose+respawn
   *  so the paired pi-exit is not surfaced as a crash toast; the sink consumes
   *  it on bridgeExit. A real crash leaves this false and still toasts. */
  intentionalRestart: boolean;
  /** True when a rehydrated session's leaf→root walk hit a dangling parentId. */
  historyTruncated: boolean;
  /** Fork branches keyed by divergence user-message ordinal (see BranchGroup). */
  branches: Record<number, BranchGroup>;

  /** Local echo for the composer (the RPC stream has no user-message event).
   * `images` are `data:` URIs, matching UserMsg.images. */
  appendUser: (text: string, images?: string[]) => void;
  /** Append a SETTLED assistant reply (a single text block) — used by the corp CEO
   * follow-up Q&A (A1/A4), whose answer arrives whole over IPC, not as a token stream. */
  appendAssistantText: (text: string) => void;
  /** Composer `!` bash mode result row (outside the agent turn). */
  appendBashExec: (command: string, output: string, exitCode: number) => void;
  /** Replace the thread (session switch/rehydration) and reset transient run
   *  state. Clears the fork-branch registry — it belongs to the session we are
   *  leaving. */
  setMessagesExternal: (messages: ChatMsg[], truncated?: boolean) => void;
  /**
   * Record a fork at `ordinal` and reset the thread to the new branch's start
   * (the shared prefix before the forked user message + the edited user echo).
   * The caller then sends the prompt, which streams the new response in. The
   * first fork at an ordinal captures the branch it forked from as index 0.
   */
  commitFork: (
    ordinal: number,
    opts: {
      /** Index of the forked user message within the current `messages`. */
      messageIndex: number;
      /** Session file of the newly-created branch (from get_state post-fork). */
      newFile: string | null;
      /** Session file of the branch we forked from (from get_state pre-fork). */
      baseFile: string | null;
      editedText: string;
      images?: string[];
    },
  ) => void;
  /** Swap the visible transcript to another branch at `ordinal` (‹/›). */
  switchBranch: (ordinal: number, targetIndex: number) => void;
  dismissNotification: (id: string) => void;
  resolveUiRequest: (id: string) => void;
}

const initialAgent: PiAgentStatus = {
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
  retry: null,
  agentStartedAt: null,
  model: null,
  thinkingLevel: 'off',
};

let localId = 0;
const nextLocalId = (prefix: string): string => `${prefix}-${Date.now()}-${++localId}`;

export const usePiStore = create<PiSliceState>((set) => ({
  messages: [],
  agent: initialAgent,
  session: null,
  sessionEpoch: 0,
  promptInFlight: false,
  queuedSends: [],
  enqueueSend: (item) => set((s) => ({ queuedSends: [...s.queuedSends, item] })),
  runningToolCalls: [],
  extensionStatus: {},
  widgets: {},
  notifications: [],
  uiRequests: [],
  artifacts: [],
  composerText: '',
  windowTitle: null,
  titleLocked: false,
  bridgeExited: null,
  intentionalRestart: false,
  historyTruncated: false,
  branches: {},

  appendBashExec: (command, output, exitCode) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          kind: 'bashExec',
          id: nextLocalId('bash'),
          command,
          output,
          exitCode,
          timestamp: Date.now(),
        },
      ],
    })),
  setMessagesExternal: (messages, truncated = false) => {
    // A1/A4 — a new / switched / rehydrated session is NOT the corp task's session,
    // so drop the corp task pointer: the next prompt starts a FRESH production rather
    // than routing a follow-up to the previous chat's CEO.
    useCorpStore.getState().setTask(null);
    set((s) => ({
      messages,
      historyTruncated: truncated,
      // A session boundary — bump the epoch so the composer remounts (clearing its
      // editor text + attachments) and an in-flight send can detect the switch.
      sessionEpoch: s.sessionEpoch + 1,
      // A switch/new-chat abandons any in-flight dispatch of the OLD session — clear
      // the bridge flag + any messages queued behind it so neither leaks into the
      // fresh chat.
      promptInFlight: false,
      queuedSends: [],
      runningToolCalls: [],
      uiRequests: [],
      bridgeExited: null,
      branches: {},
      // Reset the top-bar title on every new/switched session so the PREVIOUS
      // conversation's title can't linger (blind-test round-2 re-test). The real
      // title then loads downstream — the harness republishes a switched
      // session's stored title, and a new chat gets its classify+title on the
      // first turn (ChatApp falls back to "New chat" while null).
      windowTitle: null,
      // A new/switched session is eligible for harness auto-titling again — the
      // previous session's user-rename lock must not carry over.
      titleLocked: false,
      // A new/switched session must not inherit the previous session's live
      // harness panels (checklist / subagents), which are published under the
      // `harness*` status keys. Drop them now so a stale plan can't flash until
      // the new session's harness republishes (the harness also resets its own
      // runtime.plan at session_start — this is the renderer-side complement).
      extensionStatus: Object.fromEntries(
        Object.entries(s.extensionStatus).filter(([key]) => !key.startsWith('harness')),
      ),
    }));
  },

  commitFork: (ordinal, { messageIndex, newFile, baseFile, editedText, images }) =>
    set((s) => {
      const live = s.messages;
      const prefix = live.slice(0, messageIndex);
      const editedUser: ChatMsg = {
        kind: 'user',
        id: nextLocalId('u'),
        text: editedText,
        ...(images !== undefined && images.length > 0 ? { images } : {}),
        timestamp: Date.now(),
      };
      const seed = [...prefix, editedUser];
      const existing = s.branches[ordinal];
      let group: BranchGroup;
      if (existing === undefined) {
        // First fork here: index 0 is the branch we forked from (its full live
        // thread); index 1 is the new branch (seeded now, filled by streaming).
        group = { files: [baseFile, newFile], snapshots: [live, seed], active: 1 };
      } else {
        // Editing an already-branched message: capture the branch we are on,
        // then append the new alternate and make it active.
        const files = [...existing.files];
        const snapshots = [...existing.snapshots];
        snapshots[existing.active] = live;
        files[existing.active] = baseFile ?? files[existing.active] ?? null;
        files.push(newFile);
        snapshots.push(seed);
        group = { files, snapshots, active: files.length - 1 };
      }
      return { messages: seed, branches: { ...s.branches, [ordinal]: group } };
    }),

  switchBranch: (ordinal, targetIndex) =>
    set((s) => {
      const group = s.branches[ordinal];
      if (
        group === undefined ||
        targetIndex < 0 ||
        targetIndex >= group.files.length ||
        targetIndex === group.active
      ) {
        return {};
      }
      const snapshots = [...group.snapshots];
      // Capture the branch we are leaving so a later switch-back is current.
      snapshots[group.active] = s.messages;
      const target = snapshots[targetIndex] ?? [];
      return {
        messages: target,
        branches: { ...s.branches, [ordinal]: { ...group, snapshots, active: targetIndex } },
        // Switching mirrors a session load: drop transient per-run state.
        runningToolCalls: [],
        uiRequests: [],
      };
    }),

  appendUser: (text, images) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          kind: 'user',
          id: nextLocalId('u'),
          text,
          ...(images !== undefined && images.length > 0 ? { images } : {}),
          timestamp: Date.now(),
        },
      ],
    })),
  appendAssistantText: (text) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          kind: 'assistant',
          id: nextLocalId('a'),
          blocks: [{ type: 'text', text }],
          timestamp: Date.now(),
          isStreaming: false,
        },
      ],
    })),
  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  resolveUiRequest: (id) => set((s) => ({ uiRequests: s.uiRequests.filter((r) => r.id !== id) })),
}));

// ---------------------------------------------------------------------------
// StoreSink implementation over the store
// ---------------------------------------------------------------------------

function mutateAssistant(
  messages: ChatMsg[],
  id: string,
  mutate: (msg: AssistantMsg) => AssistantMsg,
): ChatMsg[] {
  return messages.map((m) => (m.kind === 'assistant' && m.id === id ? mutate(m) : m));
}

function appendOrMergeBlock(
  messages: ChatMsg[],
  id: string,
  kind: 'text' | 'thinking',
  delta: string,
): ChatMsg[] {
  return mutateAssistant(messages, id, (m) => {
    const blocks = [...m.blocks];
    const last = blocks[blocks.length - 1];
    if (kind === 'text') {
      if (last?.type === 'text')
        blocks[blocks.length - 1] = { type: 'text', text: last.text + delta };
      else blocks.push({ type: 'text', text: delta });
    } else {
      if (last?.type === 'thinking') {
        blocks[blocks.length - 1] = { type: 'thinking', thinking: last.thinking + delta };
      } else {
        blocks.push({ type: 'thinking', thinking: delta });
      }
    }
    return { ...m, blocks };
  });
}

/** The StoreSink the event router drives. Exported for tests. */
export function createPiSink(
  store: Pick<typeof usePiStore, 'setState' | 'getState'> = usePiStore,
): StoreSink {
  const set = store.setState;
  return {
    // `agent_start` flips isStreaming true (that now governs steer-routing), so
    // the renderer-side in-flight bridge has done its job — clear it.
    agentStart: () => set({ bridgeExited: null, promptInFlight: false }),
    // Blocking dialogs cannot outlive the run that raised them — drop any
    // stragglers so a stale dialog never sits over the finished conversation.
    // Clearing promptInFlight here is the belt-and-suspenders exit (a run that
    // errored before agent_start still releases the flag).
    agentEnd: () => set({ runningToolCalls: [], uiRequests: [], promptInFlight: false }),

    beginAssistantTurn: (id) =>
      set((s) => ({
        messages: [
          ...s.messages,
          { kind: 'assistant', id, blocks: [], timestamp: Date.now(), isStreaming: true },
        ],
      })),

    endTurn: (id, stopReason, message) =>
      set((s) => ({
        messages: mutateAssistant(s.messages, id, (m) => ({
          ...m,
          isStreaming: false,
          stopReason,
          errorMessage: message?.errorMessage,
          model: message?.model ?? m.model,
          provider: message?.provider ?? m.provider,
          usage: message?.usage ?? m.usage,
        })),
      })),

    appendTextDelta: (id, delta) =>
      set((s) => ({ messages: appendOrMergeBlock(s.messages, id, 'text', delta) })),

    appendThinkingDelta: (id, delta) =>
      set((s) => ({ messages: appendOrMergeBlock(s.messages, id, 'thinking', delta) })),

    beginToolCall: (id, call) =>
      set((s) => ({
        messages: mutateAssistant(s.messages, id, (m) => ({
          ...m,
          blocks: [...m.blocks, call],
        })),
      })),

    appendToolCallArgs: (id, callId, argsDelta) =>
      set((s) => ({
        messages: mutateAssistant(s.messages, id, (m) => {
          const blocks: ContentBlock[] = m.blocks.map((b) =>
            b.type === 'toolCall' && b.id === callId
              ? { ...b, argsText: (b.argsText ?? '') + argsDelta }
              : b,
          );
          return { ...m, blocks };
        }),
      })),

    finalizeToolCall: (id, callId, toolCall) =>
      set((s) => ({
        messages: mutateAssistant(s.messages, id, (m) => ({
          ...m,
          blocks: m.blocks.map((b) =>
            b.type === 'toolCall' && b.id === callId
              ? { ...b, name: toolCall.name, arguments: toolCall.arguments }
              : b,
          ),
        })),
      })),

    toolExecutionStart: (callId) =>
      set((s) => ({
        runningToolCalls: s.runningToolCalls.includes(callId)
          ? s.runningToolCalls
          : [...s.runningToolCalls, callId],
      })),

    toolExecutionUpdate: () => {
      // Streaming partial tool output lands in W3 (live bash output rows).
    },

    upsertToolResult: (result: ToolResultMsg) =>
      set((s) => {
        // Match by row id (assistant-scoped), never bare toolCallId: providers
        // reuse toolCallIds across runs, and an unscoped match would overwrite
        // a historical row with the new run's result.
        const existing = s.messages.findIndex((m) => m.kind === 'toolResult' && m.id === result.id);
        const messages =
          existing >= 0
            ? s.messages.map((m, i) => (i === existing ? result : m))
            : [...s.messages, result];
        return {
          messages,
          runningToolCalls: s.runningToolCalls.filter((id) => id !== result.toolCallId),
        };
      }),

    setAgentStatus: (patch: AgentStatusPatch) =>
      set((s) => ({
        agent: {
          ...s.agent,
          ...(patch.isStreaming !== undefined && { isStreaming: patch.isStreaming }),
          ...(patch.isCompacting !== undefined && { isCompacting: patch.isCompacting }),
          ...(patch.pendingMessageCount !== undefined && {
            pendingMessageCount: patch.pendingMessageCount,
          }),
          ...(patch.retry !== undefined && { retry: patch.retry }),
          ...(patch.agentStartedAt !== undefined && { agentStartedAt: patch.agentStartedAt }),
          ...(patch.model !== undefined && { model: patch.model }),
          ...(patch.thinkingLevel !== undefined && { thinkingLevel: patch.thinkingLevel }),
        },
      })),

    sessionChanged: (info) => set((s) => ({ session: { ...s.session, ...info } })),

    setMessages: (messages) => set({ messages }),

    notify: (level, message) =>
      set((s) => {
        // A deliberate restart (model switch / recovery) disposes pi, so the
        // router emits a paired "pi exited (…)." error alongside bridgeExit.
        // Suppress just that line while a restart is in flight; real crashes
        // (intentionalRestart === false) still surface. Coupled to the router's
        // _bridge_exit message prefix (packages/engine event-router.ts).
        if (level === 'error' && s.intentionalRestart && message.startsWith('pi exited (')) {
          return {};
        }
        return {
          notifications: [
            ...s.notifications.slice(-3),
            { id: nextLocalId('n'), level, message, timestamp: Date.now() },
          ],
        };
      }),

    // Idempotent dedupe-by-id (foundation-hardening handoff, Lane B): a renderer
    // reload replays pending dialogs via pi:start, and the router can re-emit the
    // same request; a duplicate id must never stack a second dialog over the first.
    uiRequest: (request) =>
      set((s) =>
        s.uiRequests.some((r) => r.id === request.id)
          ? {}
          : { uiRequests: [...s.uiRequests, request] },
      ),

    resolveUiRequest: (id) => set((s) => ({ uiRequests: s.uiRequests.filter((r) => r.id !== id) })),

    setExtensionStatus: (key, text) =>
      set((s) => {
        const extensionStatus = { ...s.extensionStatus };
        if (text === undefined) delete extensionStatus[key];
        else extensionStatus[key] = text;
        return { extensionStatus };
      }),

    setWidget: (key, lines, placement) =>
      set((s) => {
        const widgets = { ...s.widgets };
        if (lines === undefined) delete widgets[key];
        else widgets[key] = { lines, placement };
        return { widgets };
      }),

    setTitle: (title) => set({ windowTitle: title }),
    setComposerText: (text) => set({ composerText: text }),

    artifactCandidate: (candidate) =>
      set((s) => ({
        // Dedupe by identity (path per kind): the router intentionally pushes
        // again on tool_execution_start as a re-focus signal — the newest
        // touch moves to the head instead of duplicating the entry.
        artifacts: [
          candidate,
          ...s.artifacts.filter((a) => {
            if (a.kind === 'file' && candidate.kind === 'file') return a.path !== candidate.path;
            if (a.kind === 'url' && candidate.kind === 'url') return a.url !== candidate.url;
            return true;
          }),
        ].slice(0, 50),
      })),

    bridgeExit: (info) =>
      set((s) =>
        s.intentionalRestart
          ? // Deliberate dispose (restart): consume the flag and drop the crash
            // toast, but still clear transient run state as a real exit would.
            { intentionalRestart: false, runningToolCalls: [], uiRequests: [] }
          : { bridgeExited: info, runningToolCalls: [], uiRequests: [] },
      ),
  };
}
