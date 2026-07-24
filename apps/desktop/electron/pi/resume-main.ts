/**
 * Main-process wiring for TOKEN-EXACT chat resume.
 *
 * `pi:resume-continue` continues a PAUSED assistant reply by talking to the
 * running llama-server DIRECTLY (the utility base URL the pi child also uses),
 * NOT through the pi bridge — the pause aborted the generation but left the
 * reply's KV resident on the single slot, so the separated llama.cpp adapter
 * (@pi-desktop/provider-llamacpp/resume) re-renders the exact prompt via
 * `/apply-template` and continues it over the raw `/completion` endpoint with
 * `cache_prompt`, reusing that KV. Continuation tokens stream back to the
 * renderer over `pi:resume-delta` (tagged with the call's `resumeId`); the
 * invoke resolves when the reply ends (or the resume is aborted).
 *
 * These channels drive the model, so they are gated to trusted app frames like
 * the other pi channels. One resume runs per window at a time — a fresh call (or
 * `pi:resume-abort`) cancels any in-flight one for that sender.
 */
import { resumeCompletion, serializePartialAssistant } from '@pi-desktop/provider-llamacpp/resume';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { getInferenceUtility } from '../inference/llm-main';
import type { AppEventMap } from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import type { PiInvokeMap } from './contract';

const log = createLogger('desktop:pi-resume');
const events = createIpcEventSender<AppEventMap>();

/** Register the token-exact resume channels (guarded like the other pi channels). */
export function registerResumeIpc(): void {
  /** In-flight resume per sender (WebContents id) — aborted on a new resume or
   * an explicit `pi:resume-abort`. */
  const controllers = new Map<number, AbortController>();

  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!isTrustedIpcEvent(event)) {
      log.warn('rejected resume invoke from untrusted sender', {
        channel,
        wcId: event.sender.id,
      });
      throw new Error(`[pi] rejected "${channel}": untrusted sender`);
    }
  };

  ipcMain.handle(
    'pi:resume-continue',
    async (event, req: PiInvokeMap['pi:resume-continue']['request']) => {
      guard(event, 'pi:resume-continue');
      const utility = getInferenceUtility();
      if (utility === null) {
        return { success: false, error: 'no local model server is running' };
      }
      const sender = event.sender;
      const wcId = sender.id;
      // One resume at a time per window: cancel any prior in-flight one.
      controllers.get(wcId)?.abort();
      const controller = new AbortController();
      controllers.set(wcId, controller);

      try {
        const result = await resumeCompletion({
          baseUrl: utility.baseUrl,
          messages: req.messages,
          // The template-specific partial serialization lives in the adapter.
          partialText: serializePartialAssistant(req.partial),
          enableThinking: req.enableThinking,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          signal: controller.signal,
          onToken: (token) => {
            if (!sender.isDestroyed()) {
              events.send(sender, 'pi:resume-delta', { resumeId: req.resumeId, token });
            }
          },
        });
        log.info('resume-continue done', {
          wcId,
          aborted: result.aborted,
          promptN: result.promptN,
          chars: result.text.length,
        });
        return {
          success: true,
          aborted: result.aborted,
          ...(result.promptN !== undefined ? { promptN: result.promptN } : {}),
        };
      } catch (error) {
        // A real failure (server down mid-stream, etc.) — surface as a clean
        // error string; the renderer keeps the partial and offers Resume again.
        return {
          success: false,
          error: String(error instanceof Error ? error.message : error),
        };
      } finally {
        if (controllers.get(wcId) === controller) controllers.delete(wcId);
      }
    },
  );

  ipcMain.handle('pi:resume-abort', (event) => {
    guard(event, 'pi:resume-abort');
    const controller = controllers.get(event.sender.id);
    if (controller === undefined) return { ok: false };
    controller.abort();
    return { ok: true };
  });
}
