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

import fs from 'node:fs';
import path from 'node:path';
import { BrowserAgentClient, registerBrowserUseTools } from '@pi-desktop/browser-use';
import type { CoordinationEvent, TaskHandle, TaskResult } from '@pi-desktop/coordination';
import { CorpEngine, createNodeWorkspaceFactory } from '@pi-desktop/coordination/corp';
import type { CorpChatFn } from '@pi-desktop/harness/corp';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { type BrowserSearchFn, registerWebTools } from '@pi-desktop/web-tools';
import { app, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { ensureCorpInferenceServer } from '../inference/llm-main';
import type { AppEventMap } from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import { corpConcurrencyForHost } from './concurrency';
import { createLlamaCorpChat } from './corp-chat';
import type { CorpInvokeMap } from './corp-contract';
import { CORP_INVOKE_CHANNELS } from './corp-contract';
import { createRunRoleAgent } from './role-agent-seam-impl';

const log = createLogger('desktop:corp');
const events = createIpcEventSender<AppEventMap>();

/**
 * In-page scrape for the browser-backed web_search: runs on the loaded
 * DuckDuckGo HTML results page (`duckduckgo.com/html/?q=…`) and returns the top
 * hits as `{title,url,snippet}`. DDG's HTML endpoint wraps each result link in a
 * `//duckduckgo.com/l/?uddg=<encoded>` redirect — decoded here so the returned
 * URL is the real destination (usable by web_fetch). Pure string (an `evaluate`
 * script); never throws (guards + try/catch), returns [] if the shape changes.
 */
const DDG_SCRAPE_SCRIPT = String.raw`(() => {
  try {
    var decode = function (h) {
      try {
        var m = /[?&]uddg=([^&]+)/.exec(h || '');
        if (m) return decodeURIComponent(m[1]);
      } catch (e) {}
      if (h && h.indexOf('//') === 0) return 'https:' + h;
      return h || '';
    };
    var out = [];
    var nodes = document.querySelectorAll('.result, .web-result, .results_links');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var a = el.querySelector('a.result__a') || el.querySelector('.result__title a') || el.querySelector('a[href]');
      if (!a) continue;
      var title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) continue;
      var sn = el.querySelector('.result__snippet');
      out.push({
        title: title,
        url: decode(a.getAttribute('href') || ''),
        snippet: sn ? (sn.textContent || '').replace(/\s+/g, ' ').trim() : '',
      });
      if (out.length >= 20) break;
    }
    return out;
  } catch (e) {
    return [];
  }
})()`;

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
 * Durably record a run's TERMINAL OUTCOME (the CEO verdict + timing) the moment it
 * lands — independent of the renderer. A run's result must survive the window
 * navigating away or closing: the `done` event is otherwise only forwarded to the
 * situation room, so if that view is gone the verdict is lost (and main.log never
 * had it). We write both a structured log line and a JSON sidecar in the workspace
 * ROOT (which outlives the per-task workspace that `terminate` cleans up).
 */
function recordCorpOutcome(taskId: string, result: TaskResult, elapsedMs: number): void {
  const record = {
    taskId,
    outcome: result.outcome,
    verdict: result.summary,
    error: result.error ?? null,
    elapsedMs,
    elapsedMin: Math.round((elapsedMs / 60_000) * 10) / 10,
  };
  log.info('corp task terminal outcome', record);
  try {
    fs.mkdirSync(corpWorkspaceRoot(), { recursive: true });
    fs.writeFileSync(
      path.join(corpWorkspaceRoot(), `outcome-${taskId}.json`),
      JSON.stringify(record, null, 2),
    );
  } catch (err) {
    log.warn('corp: failed to write outcome sidecar', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The model seam for a run: the running local server, ensured to the recommended
 * Q8 qwen (`-c 16384`). A model that cannot be found/started is SURFACED, not
 * hidden — the run terminates with an honest error rather than degrading to a
 * stub that appears to work but does nothing (a silent config-failure).
 */
type ResolvedCorpChat =
  | {
      readonly ok: true;
      readonly chat: CorpChatFn;
      readonly baseUrl: string;
      readonly model: string;
    }
  | { readonly ok: false; readonly message: string };

async function resolveCorpChat(parallel: number): Promise<ResolvedCorpChat> {
  const utility = await ensureCorpInferenceServer({ parallel });
  if (utility.ok) {
    log.info('corp chat bound to local server', { baseUrl: utility.baseUrl, model: utility.model });
    return {
      ok: true,
      chat: createLlamaCorpChat({ baseUrl: utility.baseUrl, model: utility.model }),
      baseUrl: utility.baseUrl,
      model: utility.model,
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
  // Fan-out width. EMPIRICAL DEFAULT = SEQUENTIAL (K=1). On a single Apple GPU the
  // --parallel slots share one GPU, so concurrent engineers buy ~no aggregate
  // throughput (benchmarked ~72 tok/s single vs ~76 tok/s 3-concurrent) AND make each
  // turn ~3x slower. The OOM-safe RAM-fitted width (corpConcurrencyForHost) and the
  // whole parallel dispatch path stay tested for hardware where batching actually pays
  // (multi-GPU / servers); opt in with PI_DESKTOP_CORP_CONCURRENCY=<N> (OOM-capped).
  // KNOWN LIMITATION: the K>1 path currently has an unresolved hang in the engineer
  // seam under real concurrent model calls — diagnose before enabling in production.
  const basis = corpConcurrencyForHost();
  const requested = Number(process.env.PI_DESKTOP_CORP_CONCURRENCY);
  const parallelOptIn = Number.isFinite(requested) && requested >= 1;
  const concurrency = parallelOptIn ? Math.min(Math.floor(requested), basis.concurrency) : 1;
  log.info('corp concurrency selected', {
    concurrency,
    parallelOptIn,
    ramFittedMax: basis.concurrency,
    totalRamBytes: basis.totalRamBytes,
    perSlotKvBytes: basis.perSlotKvBytes,
  });
  const resolved = await resolveCorpChat(concurrency);
  // The ENGINEER role runs as a real agentic loop (file + bash tools) via the
  // role-agent seam, bound to the SAME resolved server the chat seam uses. Absent
  // on the unavailable path (the engine terminates without running the harness).
  // One shared bridge to the in-process browser-agent server (published on
  // app-ready). Drives the SAME visible canvas browser for both the browser_*
  // tools AND the browser-backed web_search below. Null in a headless/test main
  // (no bridge env) → web_search transparently falls back to the scrape.
  const browserBridge = BrowserAgentClient.fromEnv();
  // web_search, browser-backed: open the canvas browser to DuckDuckGo's HTML
  // results (the user watches it live) and scrape the hits via an in-page
  // evaluate — not bot-blocked the way the server-side scrape is (which returns
  // "No results"). This is why `web_search` now WORKS + is visible regardless of
  // whether the model reaches for web_search or browser_navigate.
  const browserSearch: BrowserSearchFn | undefined =
    browserBridge === null
      ? undefined
      : async (query, count) => {
          const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          await browserBridge.request('navigate', { url });
          const raw = await browserBridge.request<unknown>('evaluate', { script: DDG_SCRAPE_SCRIPT });
          const arr = Array.isArray(raw) ? raw : [];
          return arr
            .filter((r): r is { title: string; url?: string; snippet?: string } =>
              r !== null && typeof r === 'object' && typeof (r as { title?: unknown }).title === 'string',
            )
            .slice(0, count)
            .map((r) => ({
              title: String(r.title),
              url: String(r.url ?? ''),
              snippet: String(r.snippet ?? ''),
            }));
        };
  const runRoleAgent = resolved.ok
    ? createRunRoleAgent({
        baseUrl: resolved.baseUrl,
        model: resolved.model,
        // The CEO vision turn (spec §4) researches references — inject the web-tools
        // registrar so web_search / web_fetch exist for the runs whose allowlist
        // requests them (the seam gates by name; no other role is affected).
        // web_search is browser-backed when the bridge is present (see browserSearch).
        webResearchFactory: (pi) =>
          registerWebTools(pi, browserSearch !== undefined ? { browserSearch } : {}),
        // The browser_* tools drive the SAME visible canvas browser (the search
        // opens live in the situation-room canvas). Gated by name in the seam.
        browserToolsFactory: (pi) => registerBrowserUseTools(pi, { bridge: browserBridge }),
      })
    : undefined;
  const engine = new CorpEngine({
    // Unused on the unavailable path (startUnavailable never calls the model).
    chat: resolved.ok ? resolved.chat : noopCorpChat,
    ...(runRoleAgent !== undefined ? { runRoleAgent } : {}),
    workspaceFor: createNodeWorkspaceFactory(corpWorkspaceRoot()),
    concurrency,
  });
  const handle = resolved.ok
    ? engine.startTask(req.prompt, req.ctx)
    : engine.startUnavailable(req.prompt, resolved.message, req.ctx);
  tasks.set(handle.taskId, { engine, handle, wc });

  // Forward the task's events to the requesting window until the terminal `done`.
  // We keep DRAINING to the terminal even if the window is gone (destroyed or
  // navigated away) so the outcome is always recorded — the harness run itself
  // proceeds in the main process regardless of who is watching.
  const startedAt = Date.now();
  void (async () => {
    try {
      for await (const event of handle.events) {
        if (event.type === 'done') {
          recordCorpOutcome(handle.taskId, event.result, Date.now() - startedAt);
        }
        if (wc.isDestroyed()) continue;
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
  'corp:peek': (_wc, req) => {
    const task = tasks.get(req.taskId);
    return { peek: task === undefined ? null : (task.engine.peek(task.handle) ?? null) };
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
