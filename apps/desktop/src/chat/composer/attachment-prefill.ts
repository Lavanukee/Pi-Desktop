/**
 * Attachment prefill — prime the model's KV with the FIXED start of the next user
 * message (a large paste / dropped text file) the moment it's attached, so when
 * the turn is sent it reuses that resident prefix and only prefills the short
 * typed tail. There is nothing predictive here: the attachment is known and fixed
 * as soon as it's added; this just moves its (seconds-long) prompt processing off
 * the send path — MEASURED ~3747ms → ~290ms for a ~5k-token paste, holding across
 * the idle while the user finishes typing.
 *
 * It sends `[system, ...history, {user: <attachment prefix>}]` (+ the turn's
 * tools) to `pi:prefill`, which renders that exact prompt, TRUNCATES it right
 * after the attachment (so it's a true, unclosed prefix of the real turn's
 * prompt), and primes it over the raw `/completion` endpoint — see
 * @pi-desktop/provider-llamacpp/prefill for why the closed /chat/completions
 * shape only reuses partially. System + tools come from the harness (published
 * over `harness-prefill-*`); the attachment prefix is the exact `buildAgentMessage`
 * output for the text attachments alone, so the real turn's user message begins
 * with it byte-for-byte.
 *
 * Text only: images are excluded (the vision encode re-runs per request on the
 * pinned llama.cpp build, so priming one buys no send-latency). Fires only when
 * the attachment prefix actually changes (add/remove), never per keystroke; only
 * one prefill in flight per window (the main handler supersedes); never while a
 * turn streams; aborted the instant a turn is dispatched.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLlmStore } from '../../state/llm-store';
import { usePiStore } from '../../state/pi-slice';

/** Below this many chars an attachment isn't worth priming — its send already
 * prefills near-instantly against the warm [system][tools]. */
const PREFILL_MIN_CHARS = 400;
/** Small debounce to coalesce a multi-file drop into one prefill. */
const PREFILL_DEBOUNCE_MS = 200;

/** The live transcript as plain-text OpenAI messages (thinking / tool / image
 * blocks dropped — a text-only approximation that fully matches a plain chat and
 * degrades gracefully on tool/image turns). */
function historyAsMessages(
  messages: ReturnType<typeof usePiStore.getState>['messages'],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
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
 * Wire attachment prefill for the given fixed attachment prefix (the exact
 * `buildAgentMessage('', textAttachments)` that will START the sent message).
 * Returns `abortPrefill`, which the composer calls the instant it dispatches a
 * real turn so the send never queues behind an in-flight prefill on the single
 * slot.
 */
export function useAttachmentPrefill(attachmentPrefix: string): { abortPrefill: () => void } {
  const messages = usePiStore((s) => s.messages);
  const system = usePiStore((s) => s.extensionStatus['harness-prefill-system']);
  const toolsJson = usePiStore((s) => s.extensionStatus['harness-prefill-tools']);
  const serverRunning = useLlmStore((s) => s.status.serverRunning);
  const busy = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  const lastSig = useRef<string | null>(null);

  const abortPrefill = useCallback(() => {
    lastSig.current = null;
    void window.piDesktop.invoke('pi:prefill-abort', undefined).catch(() => {});
  }, []);

  useEffect(() => {
    if (!serverRunning || typeof system !== 'string' || system.length === 0) return;
    // A turn is using the slot — priming now would contend + get evicted.
    if (busy) return;
    const prefix = attachmentPrefix.trim();
    if (prefix.length < PREFILL_MIN_CHARS) return;

    const history = historyAsMessages(messages);
    // Cheap dedupe key (avoid stringifying the whole prefix each render).
    const sig = `${history.length}|${prefix.length}|${prefix.slice(0, 96)}`;
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
      const oaiMessages: Array<Record<string, unknown>> = [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: attachmentPrefix },
      ];
      void window.piDesktop
        .invoke('pi:prefill', { messages: oaiMessages, ...(tools !== undefined ? { tools } : {}) })
        .catch(() => {
          // Non-fatal: the send path still works, it just pays the full prefill.
        });
    }, PREFILL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [attachmentPrefix, system, toolsJson, serverRunning, busy, messages]);

  return { abortPrefill };
}
