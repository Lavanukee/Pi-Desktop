/**
 * Main-process wiring for PREDICTIVE PREFILL.
 *
 * `pi:prefill` primes the running llama-server's KV cache with the message the
 * user is composing, BEFORE they press Enter, so the real turn reuses it and
 * first-token latency collapses. Like resume (see resume-main.ts) it talks to the
 * llama-server DIRECTLY (the utility base URL the pi child also uses), NOT through
 * the pi bridge — the separated adapter (@pi-desktop/provider-llamacpp/prefill)
 * fires the same one-token, no-thinking `/v1/chat/completions` warm-up the harness
 * uses on model-load, but carrying the in-progress `[system, tools, …history,
 * draft]`. llama.cpp's default longest-common-prefix reuse does the rest.
 *
 * Fire-and-forget: only ONE prefill runs per sender at a time — a fresh call (or
 * `pi:prefill-abort` when the turn is actually sent) cancels the in-flight one, so
 * a fast typist never stacks requests on the single slot. Gated to trusted app
 * frames like the other model-driving channels.
 */
import { prefillCompletion } from '@pi-desktop/provider-llamacpp/prefill';
import { createLogger } from '@pi-desktop/shared';
import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { getInferenceUtility } from '../inference/llm-main';
import { isTrustedIpcEvent } from '../trusted-senders';
import type { PiInvokeMap } from './contract';

const log = createLogger('desktop:pi-prefill');

/** Register the predictive-prefill channels (guarded like the other pi channels). */
export function registerPrefillIpc(): void {
  /** In-flight prefill per sender (WebContents id) — aborted on a new prefill or
   * an explicit `pi:prefill-abort` (the turn was sent). */
  const controllers = new Map<number, AbortController>();

  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!isTrustedIpcEvent(event)) {
      log.warn('rejected prefill invoke from untrusted sender', {
        channel,
        wcId: event.sender.id,
      });
      throw new Error(`[pi] rejected "${channel}": untrusted sender`);
    }
  };

  ipcMain.handle('pi:prefill', async (event, req: PiInvokeMap['pi:prefill']['request']) => {
    guard(event, 'pi:prefill');
    const utility = getInferenceUtility();
    // No server yet ⇒ nothing to prime. Not an error — the caller ignores it.
    if (utility === null) return { success: false, error: 'no local model server is running' };
    const wcId = event.sender.id;
    // One prefill at a time per window: cancel any prior in-flight one so a fast
    // typist can't queue requests behind each other on the single slot.
    controllers.get(wcId)?.abort();
    const controller = new AbortController();
    controllers.set(wcId, controller);
    try {
      const result = await prefillCompletion({
        baseUrl: utility.baseUrl,
        model: utility.model,
        messages: req.messages,
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        signal: controller.signal,
      });
      return {
        success: true,
        aborted: result.aborted,
        ...(result.promptN !== undefined ? { promptN: result.promptN } : {}),
      };
    } catch (error) {
      // A real failure (server hiccup) — non-fatal by design; the send path still
      // works, it just pays the full prefill. Surface a clean string, no throw.
      return { success: false, error: String(error instanceof Error ? error.message : error) };
    } finally {
      if (controllers.get(wcId) === controller) controllers.delete(wcId);
    }
  });

  ipcMain.handle('pi:prefill-abort', (event) => {
    guard(event, 'pi:prefill-abort');
    const controller = controllers.get(event.sender.id);
    if (controller === undefined) return { ok: false };
    controller.abort();
    return { ok: true };
  });
}
