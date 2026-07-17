/**
 * Main-process wiring for the EXPERIMENTAL coordination harness (CorpEngine).
 *
 * A submitted prompt (flag on) starts a {@link CorpEngine} task here; the engine
 * runs the harness `runCorp` behind a REAL llama-server `/v1/chat/completions`
 * seam (the running local model, via `getInferenceUtility` / ensured with the
 * recommended Q8 qwen) and streams mapped {@link CoordinationEvent}s back to the
 * requesting window over `corp:event`. The renderer's situation room folds them.
 *
 * The CorpEngine + harness run ONLY here (Node/main); the renderer never imports
 * the engine — it drives it over these IPC channels and consumes the neutral DTOs.
 * Handlers are sender-aware (like pi-main) so a task's events route to the window
 * that started it, and trusted-sender gated (the harness is exec-capable via the
 * model — only main frames of app-created windows may reach it).
 */

import path from 'node:path';
import type { CoordinationEvent, TaskHandle } from '@pi-desktop/coordination';
import { CorpEngine, createNodeWorkspaceFactory } from '@pi-desktop/coordination/corp';
import type { CorpChatFn } from '@pi-desktop/harness/corp';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { app, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { ensureCorpInferenceServer } from '../inference/llm-main';
import type { AppEventMap } from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import { createLlamaCorpChat } from './corp-chat';
import type { CorpInvokeMap } from './corp-contract';
import { CORP_INVOKE_CHANNELS } from './corp-contract';

const log = createLogger('desktop:corp');
const events = createIpcEventSender<AppEventMap>();

/** Per-task record: the engine that owns it, its handle, and the target window. */
interface RunningTask {
  readonly engine: CorpEngine;
  readonly handle: TaskHandle;
  readonly wc: WebContents;
}

const tasks = new Map<string, RunningTask>();

/** Where per-task workspaces land (a temp root; engineers write produced files
 * here). Isolated per task under the OS temp dir so a run never touches HOME. */
function corpWorkspaceRoot(): string {
  return path.join(app.getPath('temp'), 'pi-desktop-corp');
}

/**
 * The model seam for a run: the running local server, ensured to the recommended
 * Q8 qwen (`-c 16384`). A model that cannot be found/started is SURFACED, not
 * hidden — the run terminates with an honest error rather than degrading to a
 * stub that appears to work but does nothing (a silent config-failure).
 */
type ResolvedCorpChat =
  | { readonly ok: true; readonly chat: CorpChatFn }
  | { readonly ok: false; readonly message: string };

async function resolveCorpChat(): Promise<ResolvedCorpChat> {
  const utility = await ensureCorpInferenceServer();
  if (utility.ok) {
    log.info('corp chat bound to local server', { baseUrl: utility.baseUrl, model: utility.model });
    return {
      ok: true,
      chat: createLlamaCorpChat({ baseUrl: utility.baseUrl, model: utility.model }),
    };
  }
  log.warn('corp: no local model available — surfacing to the situation room', {
    modelId: utility.modelId,
    error: utility.error,
  });
  return {
    ok: false,
    message: `The model isn't available. Download ${utility.modelId} in Settings → Models to run the production harness.`,
  };
}

/** Placeholder model seam for the unavailable path — never invoked, because the
 * engine terminates via `startUnavailable` without running the harness. */
const noopCorpChat: CorpChatFn = () => ({ content: '' });

async function handleStart(
  wc: WebContents,
  req: CorpInvokeMap['corp:start']['request'],
): Promise<CorpInvokeMap['corp:start']['response']> {
  const resolved = await resolveCorpChat();
  const engine = new CorpEngine({
    // Unused on the unavailable path (startUnavailable never calls the model).
    chat: resolved.ok ? resolved.chat : noopCorpChat,
    workspaceFor: createNodeWorkspaceFactory(corpWorkspaceRoot()),
  });
  const handle = resolved.ok
    ? engine.startTask(req.prompt, req.ctx)
    : engine.startUnavailable(req.prompt, resolved.message, req.ctx);
  tasks.set(handle.taskId, { engine, handle, wc });

  // Forward the task's events to the requesting window until the terminal `done`.
  void (async () => {
    try {
      for await (const event of handle.events) {
        if (wc.isDestroyed()) break;
        events.send(wc, 'corp:event', { taskId: handle.taskId, event: event as CoordinationEvent });
      }
    } catch (err) {
      log.warn('corp event stream errored', {
        taskId: handle.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tasks.delete(handle.taskId);
    }
  })();

  log.info('corp task started', { taskId: handle.taskId });
  return { taskId: handle.taskId };
}

type CorpHandlers = {
  [K in keyof CorpInvokeMap]: (
    wc: WebContents,
    request: CorpInvokeMap[K]['request'],
  ) => CorpInvokeMap[K]['response'] | Promise<CorpInvokeMap[K]['response']>;
};

const handlers: CorpHandlers = {
  'corp:start': (wc, req) => handleStart(wc, req),
  'corp:steer': (_wc, req) => {
    const task = tasks.get(req.taskId);
    if (task === undefined) return { ok: false };
    task.engine.steer(task.handle, req.text);
    return { ok: true };
  },
  'corp:abort': (_wc, req) => {
    const task = tasks.get(req.taskId);
    if (task === undefined) return { ok: false };
    task.engine.abort(task.handle);
    return { ok: true };
  },
  'corp:respond-permission': (_wc, req) => {
    const task = tasks.get(req.taskId);
    if (task === undefined) return { ok: false };
    task.engine.respondToPermission(task.handle, req.requestId, req.granted);
    return { ok: true };
  },
  'corp:get-org-chart': (_wc, req) => {
    const task = tasks.get(req.taskId);
    return { chart: task === undefined ? null : task.engine.getOrgChart(task.handle) };
  },
  'corp:worker-transcript': (_wc, req) => {
    const task = tasks.get(req.taskId);
    return {
      transcript:
        task === undefined
          ? null
          : (task.engine.getWorkerTranscript(task.handle, req.nodeId) ?? null),
    };
  },
};

/** Register the corp channels (sender-aware + trusted-sender gated). Always
 * registered; only reached when the experimental flag / env override is on. */
export function registerCorpIpc(): void {
  for (const channel of CORP_INVOKE_CHANNELS) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, request: unknown) => {
      if (!isTrustedIpcEvent(event)) {
        log.warn('rejected invoke from untrusted sender', { channel, wcId: event.sender.id });
        throw new Error(`[corp] rejected "${channel}": untrusted sender`);
      }
      const handler = handlers[channel] as (wc: WebContents, request: unknown) => unknown;
      return handler(event.sender, request);
    });
  }
}
