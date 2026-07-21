/**
 * Ground-truth request capture for the power-user advanced panel. The pi child's
 * provider hook (before_provider_request, in @pi-desktop/provider-llamacpp) pushes
 * the EXACT body it is about to send to llama-server on each turn — the system
 * prompt (which, under `--jinja --chat-template-file`, is what the model actually
 * reads, tool defs merged server-side), the `tools` array, and the message list —
 * over `ctx.ui.setStatus`. That status lands in the pi-slice `extensionStatus`
 * map like any other; this module just parses the one key so the panel renders it
 * without re-plumbing the event bus.
 *
 * Empty until the first turn after a session starts.
 */
import { useMemo } from 'react';
import { usePiStore } from './pi-slice';

/**
 * setStatus key the child pushes ground truth under. MUST match
 * `ADVANCED_GROUNDTRUTH_KEY` in provider-llamacpp/src/advanced-hook.ts.
 */
export const ADVANCED_GROUNDTRUTH_KEY = 'advanced-params-groundtruth';

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
}

/**
 * Reactive hook: the most recent captured request body (null before any turn, or
 * if the payload can't be parsed). Parsing is memoized on the raw status string
 * so the panel doesn't re-parse a large blob every render.
 */
export function useGroundTruth(): GroundTruth | null {
  const raw = usePiStore((s) => s.extensionStatus[ADVANCED_GROUNDTRUTH_KEY]);
  return useMemo(() => {
    if (raw === undefined || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as GroundTruth;
      return {
        systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : '',
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        model: typeof parsed.model === 'string' ? parsed.model : '',
      };
    } catch {
      return null;
    }
  }, [raw]);
}
