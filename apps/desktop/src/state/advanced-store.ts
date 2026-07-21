/**
 * Ground-truth request capture for the power-user advanced panel. The pi child's
 * provider hook (before_provider_request) pushes the EXACT body it is about to
 * send to llama-server on each turn — the system prompt (which, under
 * `--jinja --chat-template-file`, is what the model actually reads, tool defs
 * merged server-side), the `tools` array, and the full message list. That push
 * arrives over the existing status seam and lands here so the panel can render it
 * without guessing what pi assembled.
 *
 * Empty until the first turn after a session starts; a `new session` clears it.
 */
import { create } from 'zustand';

/** One captured request body (the most recent turn's ground truth). */
export interface GroundTruth {
  /** The system prompt string == request `messages[0].content`. */
  readonly systemPrompt: string;
  /** Tool definitions sent as `body.tools` (name + description + JSON schema). */
  readonly tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>;
  /** The full OpenAI-shaped message list (roles + content), for the raw view. */
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  /** Model id the body targeted. */
  readonly model: string;
  /** Wall-clock ms when captured (renderer-stamped on receipt). */
  readonly capturedAt: number;
}

interface AdvancedStoreState {
  groundTruth: GroundTruth | null;
  /** Replace the captured body (called from the child-push event handler). */
  setGroundTruth: (gt: GroundTruth) => void;
  /** Clear on new-session / chat switch. */
  clear: () => void;
}

export const useAdvancedStore = create<AdvancedStoreState>((set) => ({
  groundTruth: null,
  setGroundTruth: (groundTruth) => set({ groundTruth }),
  clear: () => set({ groundTruth: null }),
}));

/** Reactive hook: the most recent captured request body (null before any turn). */
export function useGroundTruth(): GroundTruth | null {
  return useAdvancedStore((s) => s.groundTruth);
}
