/**
 * Child-agent transcripts (MP2). Each app-owned child pi instance (a subagent or
 * role — see electron/pi/child-agents.ts) streams its events to the renderer over
 * `pi:child-event`, tagged with childId. We fold each child's events through the
 * SAME event router + fold primitives the main chat uses, into a per-child
 * `ChatMsg[]` — so a child renders through the identical ChatThread, not a copy.
 *
 * One router per childId (the router is stateful — it tracks the live turn), and
 * one entry per child in this store. A viewer (the nested sidebar dropdown, MP3)
 * reads `children[childId].messages` and renders it exactly like a chat.
 */
import {
  type ChatMsg,
  type ContentBlock,
  createEventRouter,
  type EventRouter,
  type StoreSink,
} from '@pi-desktop/engine';
import { create } from 'zustand';
import { appendOrMergeBlock, mutateAssistant, upsertToolResultMsg } from './transcript-fold';

/** Whether to expose the E2E store hook (probes read the folded transcript). */
const IS_E2E =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E');

export interface ChildAgentEntry {
  childId: string;
  parentId: string;
  title: string;
  /** The child's transcript, folded from its event stream — a real ChatMsg[]. */
  messages: ChatMsg[];
  /** True between the child's agent_start and agent_end (drives the spinner). */
  running: boolean;
}

interface ChildAgentState {
  children: Record<string, ChildAgentEntry>;
  /** The child whose transcript is being VIEWED (the nested dropdown selection),
   * or null when the main chat is shown. Cleared on a main-chat switch. */
  viewedChildId: string | null;
  setViewedChild(childId: string | null): void;
  /** Create the entry if absent (idempotent — never clobbers an existing title). */
  ensureChild(childId: string, parentId: string, title: string): void;
  removeChild(childId: string): void;
  updateMessages(childId: string, mutate: (m: ChatMsg[]) => ChatMsg[]): void;
  replaceMessages(childId: string, messages: ChatMsg[]): void;
  setRunning(childId: string, running: boolean): void;
}

export const useChildAgentStore = create<ChildAgentState>()((set) => ({
  children: {},
  viewedChildId: null,
  setViewedChild: (childId) => set({ viewedChildId: childId }),
  ensureChild: (childId, parentId, title) =>
    set((s) =>
      s.children[childId] !== undefined
        ? {}
        : {
            children: {
              ...s.children,
              [childId]: { childId, parentId, title, messages: [], running: true },
            },
          },
    ),
  removeChild: (childId) =>
    set((s) => {
      if (s.children[childId] === undefined) return {};
      const next = { ...s.children };
      delete next[childId];
      return { children: next };
    }),
  updateMessages: (childId, mutate) =>
    set((s) => {
      const c = s.children[childId];
      if (c === undefined) return {};
      return { children: { ...s.children, [childId]: { ...c, messages: mutate(c.messages) } } };
    }),
  replaceMessages: (childId, messages) =>
    set((s) => {
      const c = s.children[childId];
      if (c === undefined) return {};
      return { children: { ...s.children, [childId]: { ...c, messages } } };
    }),
  setRunning: (childId, running) =>
    set((s) => {
      const c = s.children[childId];
      if (c === undefined) return {};
      return { children: { ...s.children, [childId]: { ...c, running } } };
    }),
}));

/** Child agents grouped by their parent chat id (sidebar dropdown source). */
export function childrenOf(parentId: string): ChildAgentEntry[] {
  const all = useChildAgentStore.getState().children;
  return Object.values(all).filter((c) => c.parentId === parentId);
}

/** Reactive: child agents grouped by parent chat id (the nested-dropdown source). */
export function useChildrenByParent(): Map<string, ChildAgentEntry[]> {
  const children = useChildAgentStore((s) => s.children);
  const byParent = new Map<string, ChildAgentEntry[]>();
  for (const c of Object.values(children)) {
    const arr = byParent.get(c.parentId);
    if (arr === undefined) byParent.set(c.parentId, [c]);
    else arr.push(c);
  }
  return byParent;
}

/**
 * A StoreSink for ONE child that folds the router's callbacks into that child's
 * transcript. The transcript callbacks mirror pi-slice's createPiSink exactly
 * (shared fold primitives); the rest (status/ui/widgets/artifacts) are no-ops —
 * a viewed child renders its thread; those concerns belong to the main chat.
 */
export function makeChildSink(childId: string): StoreSink {
  const store = useChildAgentStore;
  const upd = (mutate: (m: ChatMsg[]) => ChatMsg[]) =>
    store.getState().updateMessages(childId, mutate);
  const noop = (): void => {};
  return {
    agentStart: () => store.getState().setRunning(childId, true),
    agentEnd: () => store.getState().setRunning(childId, false),
    beginAssistantTurn: (id) =>
      upd((msgs) => [
        ...msgs,
        { kind: 'assistant', id, blocks: [], timestamp: Date.now(), isStreaming: true },
      ]),
    endTurn: (id, stopReason, message) =>
      upd((msgs) =>
        mutateAssistant(msgs, id, (m) => ({
          ...m,
          isStreaming: false,
          stopReason,
          errorMessage: message?.errorMessage,
          model: message?.model ?? m.model,
          provider: message?.provider ?? m.provider,
          usage: message?.usage ?? m.usage,
        })),
      ),
    appendTextDelta: (id, delta) => upd((msgs) => appendOrMergeBlock(msgs, id, 'text', delta)),
    appendThinkingDelta: (id, delta) =>
      upd((msgs) => appendOrMergeBlock(msgs, id, 'thinking', delta)),
    beginToolCall: (id, call) =>
      upd((msgs) => mutateAssistant(msgs, id, (m) => ({ ...m, blocks: [...m.blocks, call] }))),
    appendToolCallArgs: (id, callId, argsDelta) =>
      upd((msgs) =>
        mutateAssistant(msgs, id, (m) => ({
          ...m,
          blocks: m.blocks.map((b: ContentBlock) =>
            b.type === 'toolCall' && b.id === callId
              ? { ...b, argsText: (b.argsText ?? '') + argsDelta }
              : b,
          ),
        })),
      ),
    finalizeToolCall: (id, callId, toolCall) =>
      upd((msgs) =>
        mutateAssistant(msgs, id, (m) => ({
          ...m,
          blocks: m.blocks.map((b: ContentBlock) =>
            b.type === 'toolCall' && b.id === callId
              ? { ...b, name: toolCall.name, arguments: toolCall.arguments }
              : b,
          ),
        })),
      ),
    upsertToolResult: (result) => upd((msgs) => upsertToolResultMsg(msgs, result)),
    setMessages: (messages) => store.getState().replaceMessages(childId, messages),
    // Not modelled for a viewed child (its thread is what matters):
    toolExecutionStart: noop,
    toolExecutionUpdate: noop,
    setAgentStatus: noop,
    sessionChanged: noop,
    notify: noop,
    uiRequest: noop,
    resolveUiRequest: noop,
    setExtensionStatus: noop,
    setWidget: noop,
    setTitle: noop,
    setComposerText: noop,
    artifactCandidate: noop,
  };
}

/**
 * Subscribe to the child-event wire and fold each child's stream into its own
 * transcript. One EventRouter per childId (the router is stateful). Call once at
 * app init (beside connectPi); returns an unsubscribe.
 */
export function connectChildAgents(): () => void {
  const routers = new Map<string, EventRouter>();
  if (IS_E2E && typeof window !== 'undefined') {
    (window as unknown as { __child_store?: typeof useChildAgentStore }).__child_store =
      useChildAgentStore;
  }
  const unsub = window.piDesktop.onEvent(
    'pi:child-event',
    ({ childId, parentId, title, event }) => {
      let router = routers.get(childId);
      if (router === undefined) {
        useChildAgentStore.getState().ensureChild(childId, parentId, title);
        router = createEventRouter(makeChildSink(childId));
        routers.set(childId, router);
      }
      router.handleEvent(event);
    },
  );
  return () => {
    unsub();
    routers.clear();
  };
}

/** Spawn an app-owned child pi instance for a subagent/role and seed its store
 * entry (so the sidebar shows it immediately, before the first event). */
export async function spawnChildAgent(req: {
  childId: string;
  parentId: string;
  title: string;
  goal: string;
  cwd?: string;
}): Promise<{ success: boolean; error?: string }> {
  useChildAgentStore.getState().ensureChild(req.childId, req.parentId, req.title);
  const res = await window.piDesktop.invoke('pi:child-spawn', req);
  if (!res.success) useChildAgentStore.getState().removeChild(req.childId);
  return res;
}
