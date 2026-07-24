/**
 * Predictive prefill — prime the model's KV cache with the message being composed
 * BEFORE the user presses Enter, so the real turn reuses it and first-token
 * latency collapses. The heavy win is a large pasted block or attached text file:
 * its prefill (seconds of prompt processing) happens while the user is still
 * reading/typing instead of on the send path.
 *
 * It sends `[system, ...history, {user: draft}]` (+ the turn's tools) to the
 * `pi:prefill` channel, which fires the same one-token, no-thinking warm-up the
 * harness uses on model-load (see @pi-desktop/provider-llamacpp/prefill). The
 * prefix is byte-identical to the turn's — system + tools come from the harness
 * (published over `harness-prefill-*`), history is the live transcript as text,
 * and the draft is built with the SAME `buildAgentMessage` `submit()` uses.
 *
 * Text only: images are excluded (the vision encode is re-run per request on the
 * pinned llama.cpp build, so prefilling one buys no send-latency — measured).
 * Cheap by construction: only ONE prefill is in flight per window (the main
 * handler supersedes), it fires only for drafts big enough to matter (short
 * messages are already instant via the model-load warm-up), never while a turn is
 * streaming, and it's debounced so a fast typist doesn't spray the slot.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLlmStore } from '../../state/llm-store';
import { usePiStore } from '../../state/pi-slice';

/** Draft body length (chars) below which prefill is skipped — a short message
 * already prefills near-instantly against the warm [system][tools], so priming it
 * would just churn the slot. Tuned to ~a paragraph / any attached block. */
const PREFILL_MIN_CHARS = 350;
/** Idle time after the last change before firing — collapses a burst of
 * keystrokes (or a paste + immediate edit) into one prefill. */
const PREFILL_DEBOUNCE_MS = 350;

/** One OpenAI-shaped message. Kept as an open record because the `pi:prefill`
 * contract carries `Array<Record<string, unknown>>` (provider-agnostic). */
type OaiMessage = Record<string, unknown>;

/** The live transcript as plain-text OpenAI messages (thinking / tool / image
 * blocks dropped — a text-only approximation that fully matches a plain chat and
 * degrades gracefully on tool/image turns). */
function historyAsMessages(
  messages: ReturnType<typeof usePiStore.getState>['messages'],
): OaiMessage[] {
  const out: OaiMessage[] = [];
  for (const m of messages) {
    if (m.kind === 'user') {
      const text = m.text.trim();
      if (text.length > 0) out.push({ role: 'user', content: text });
    } else if (m.kind === 'assistant') {
      const text = m.blocks
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      if (text.length > 0) out.push({ role: 'assistant', content: text });
    }
  }
  return out;
}

/**
 * Wire predictive prefill for the given draft body (the exact `agentMessage`
 * `submit()` will send). Returns `abortPrefill`, which the composer calls the
 * instant it dispatches a real turn so the send never queues behind an in-flight
 * prefill on the single slot.
 */
export function usePredictivePrefill(draftContent: string): { abortPrefill: () => void } {
  const messages = usePiStore((s) => s.messages);
  const system = usePiStore((s) => s.extensionStatus['harness-prefill-system']);
  const toolsJson = usePiStore((s) => s.extensionStatus['harness-prefill-tools']);
  const serverRunning = useLlmStore((s) => s.status.serverRunning);
  const busy = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  // Signature of the last prefill we fired — skip a redundant re-fire (e.g. the
  // effect re-running on an unrelated store change with the same draft).
  const lastSig = useRef<string | null>(null);

  const abortPrefill = useCallback(() => {
    lastSig.current = null;
    void window.piDesktop.invoke('pi:prefill-abort', undefined).catch(() => {});
  }, []);

  useEffect(() => {
    if (!serverRunning || typeof system !== 'string' || system.length === 0) return;
    // A turn is using the slot — priming now would contend + get evicted.
    if (busy) return;
    const content = draftContent.trim();
    if (content.length < PREFILL_MIN_CHARS) return;
    // Not a model turn: bash (`!`) / slash commands never run the model.
    if (content.startsWith('!') || content.startsWith('/')) return;

    const history = historyAsMessages(messages);
    // Cheap dedupe key (avoid stringifying the whole ~7k-char system each render).
    const sig = `${history.length}|${content.length}|${content.slice(0, 128)}`;
    if (sig === lastSig.current) return;

    const timer = window.setTimeout(() => {
      lastSig.current = sig;
      let tools: Array<{ name: string; description?: string; parameters?: unknown }> | undefined;
      if (typeof toolsJson === 'string' && toolsJson.length > 0) {
        try {
          tools = JSON.parse(toolsJson);
        } catch {
          tools = undefined;
        }
      }
      const oaiMessages: OaiMessage[] = [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: draftContent },
      ];
      void window.piDesktop
        .invoke('pi:prefill', { messages: oaiMessages, ...(tools !== undefined ? { tools } : {}) })
        .catch(() => {
          // Non-fatal: the send path still works, it just pays the full prefill.
        });
    }, PREFILL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draftContent, system, toolsJson, serverRunning, busy, messages]);

  return { abortPrefill };
}
