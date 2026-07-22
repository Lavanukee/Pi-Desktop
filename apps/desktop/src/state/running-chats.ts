/**
 * "Running chats" — the live view the queue explainer (and, later, a
 * multi-session sidebar) reads to show what is currently occupying the one local
 * llama-server. TODAY the app runs ONE pi child, so there is at most one running
 * chat: the active conversation while its turn is in flight. This module is
 * deliberately shaped as an ARRAY so that when true background continuation lands
 * (multiple pi children) the same surface just returns more rows — nothing
 * downstream (the modal, the row renderer) assumes a single entry.
 *
 * The pure {@link buildActiveRunningChat} is unit-tested; the {@link useRunningChats}
 * hook wires it to the live pi + llm stores.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { PREFILL_STATUS_KEY, parsePrefillPercent } from '../chat/harness-status';
import { useLlmStore } from './llm-store';
import { usePiStore } from './pi-slice';
import {
  assessSendFeasibility,
  feasibilityToReason,
  type QueueReason,
  resolveTargetModel,
  type SendFeasibility,
} from './send-feasibility';
import { useSettingsStore } from './settings-store';

export interface RunningChat {
  /** Session file (null for a projectless chat not yet written to disk). */
  readonly sessionFile: string | null;
  /** Chat title (window title), or a friendly fallback. */
  readonly title: string;
  readonly modelId: string | null;
  readonly modelName: string | null;
  /** Coarse live phase: ingesting the prompt vs producing tokens. */
  readonly status: 'prefilling' | 'generating';
  /** Prefill percent (0..99) while `status==='prefilling'`, else null. */
  readonly prefillPct: number | null;
  /** True when this is the conversation the user is currently viewing. */
  readonly isActive: boolean;
}

const EMPTY: readonly RunningChat[] = Object.freeze([]);

/** Pure: the active conversation as a {@link RunningChat}, or null when idle. */
export function buildActiveRunningChat(inp: {
  isStreaming: boolean;
  promptInFlight: boolean;
  /** Has the CURRENT turn produced any content yet (past the initial prefill)? */
  turnHasContent: boolean;
  sessionFile: string | null;
  title: string | null;
  agentModel: { id: string; name: string } | null;
  loadedModel: { id: string; displayName: string } | null;
  prefillPct: number | null;
}): RunningChat | null {
  if (!inp.isStreaming && !inp.promptInFlight) return null;
  // Prefill = the dispatch gap OR a started turn that hasn't emitted content yet.
  const prefilling = inp.promptInFlight || !inp.turnHasContent;
  return {
    sessionFile: inp.sessionFile,
    title: inp.title !== null && inp.title.trim().length > 0 ? inp.title : 'New chat',
    modelId: inp.agentModel?.id ?? inp.loadedModel?.id ?? null,
    modelName: inp.agentModel?.name ?? inp.loadedModel?.displayName ?? null,
    status: prefilling ? 'prefilling' : 'generating',
    prefillPct: prefilling ? inp.prefillPct : null,
    isActive: true,
  };
}

/** Live list of chats currently occupying the server (≤ 1 today; array for N). */
export function useRunningChats(): readonly RunningChat[] {
  const isStreaming = usePiStore((s) => s.agent.isStreaming);
  const promptInFlight = usePiStore((s) => s.promptInFlight);
  const messages = usePiStore((s) => s.messages);
  const sessionFile = usePiStore((s) => s.session?.sessionFile ?? null);
  const title = usePiStore((s) => s.windowTitle);
  const agentModel = usePiStore((s) => s.agent.model);
  const prefillRaw = usePiStore((s) => s.extensionStatus[PREFILL_STATUS_KEY]);
  const loadedModel = useLlmStore((s) => s.status.model);

  // Has the current turn produced content since the last user message? (Same walk
  // ThreadStatusIndicator uses — any assistant content past the user turn means
  // we're past the initial prefill.)
  const turnHasContent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m === undefined) continue;
      if (m.kind === 'user') break;
      if (
        m.kind === 'assistant' &&
        m.blocks.some((b) =>
          b.type === 'text'
            ? b.text.length > 0
            : b.type === 'thinking'
              ? b.thinking.length > 0
              : true,
        )
      ) {
        return true;
      }
    }
    return false;
  }, [messages]);

  const chat = buildActiveRunningChat({
    isStreaming,
    promptInFlight,
    turnHasContent,
    sessionFile,
    title,
    agentModel,
    loadedModel:
      loadedModel === null ? null : { id: loadedModel.id, displayName: loadedModel.displayName },
    prefillPct: parsePrefillPercent(prefillRaw),
  });

  // Stable identity when idle so consumers don't re-render on every store tick.
  return useMemo(() => (chat === null ? EMPTY : [chat]), [chat]);
}

/**
 * Open/close state for the "Why isn't my message sending?" modal. A tiny separate
 * store because the trigger (a queued row in ChatThread) and the modal (mounted in
 * ChatApp) are far apart in the tree — passing a prop down would thread through
 * half the chat surface.
 */
export const useQueueExplainer = create<{ open: boolean; setOpen: (open: boolean) => void }>(
  (set) => ({ open: false, setOpen: (open) => set({ open }) }),
);

/**
 * Classify the send about to happen, reading the live model selection, the loaded
 * model, and this machine's RAM. Imperative (`getState`) so the composer can call
 * it inside its submit handler. `turnInFlight` says whether a reply is already
 * streaming (the usual reason a send queues).
 */
export function assessCurrentSend(turnInFlight: boolean): {
  feasibility: SendFeasibility;
  reason: QueueReason;
} {
  const llm = useLlmStore.getState();
  const selection = useSettingsStore.getState().settings.modelSelection;
  const loaded = llm.status.model;
  const target = resolveTargetModel({
    selection,
    tierModels: llm.recommendation?.tierModels,
    catalog: llm.catalog,
    loaded:
      loaded === null
        ? null
        : { id: loaded.id, displayName: loaded.displayName, quant: loaded.quant },
  });
  const feasibility = assessSendFeasibility({
    totalRamGB: llm.hardware?.totalRamGB ?? 0,
    target,
    loadedModelId: loaded?.id ?? null,
    loadedModelName: loaded?.displayName ?? null,
    turnInFlight,
  });
  return { feasibility, reason: feasibilityToReason(feasibility) };
}
