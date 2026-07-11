/**
 * ComfyClient — the persistent-server adapter that fulfils a `comfyui`-backend
 * {@link GenJob} against a long-lived ComfyUI aiohttp server on `127.0.0.1:<port>`
 * (or a remote `http://host:port`), implementing the SAME `run(job, opts) →
 * GenOutput[]` contract as {@link GenServiceClient} so {@link JobQueue} takes one
 * dispatching runner (see {@link ./gen-runner!makeGenRunner}).
 *
 * For each candidate seed it POSTs an API-format workflow graph (resolved by
 * {@link ./comfy-workflow!fillWorkflow}) to `/prompt` with a `client_id`, reads
 * the correlated `/ws?clientId=` stream, and TRANSLATES ComfyUI's ws messages
 * into the existing {@link GenEvent} union (the `GenEvent` union is UNCHANGED —
 * ComfyUI's own `progress`/`executing`/`executed` message kinds never leak out):
 *
 * | ComfyUI ws message                                   | emitted {@link GenEvent}                       |
 * |------------------------------------------------------|------------------------------------------------|
 * | (connected + first `/prompt` accepted)               | `start` `{ total, candidates }`                |
 * | `progress` `{ value, max, prompt_id }`               | `progress` `{ candidate, step, total }`        |
 * | `executing` `{ node: null, prompt_id }` (this prompt)| → fetch `/history` + `/view` → `candidate`     |
 * | all candidates' outputs on disk                       | `done` `{ outputs }`                            |
 * | `execution_error` / `execution_interrupted`          | `error` `{ message }` (then reject)            |
 *
 * Everything runtime-touching (http `fetch`, the ws, the file writer) is injected
 * so it unit-tests against a FAKE in-process server — no real ComfyUI is
 * installed or spawned. Candidates run SEQUENTIALLY (one `/prompt` in flight at a
 * time): trivial progress attribution, and it never fans a heavy video model out
 * to N concurrent runs on one unified-memory budget.
 */

import { writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GenAbortError } from './client.js';
import { fillWorkflow, WORKFLOW_TEMPLATES, type WorkflowTemplate } from './comfy-workflow.js';
import type { GenEvent, GenJob, GenOutput } from './protocol.js';

/** Minimal structural WebSocket the adapter drives (satisfied by the `ws` pkg / a fake). */
export interface ComfyWebSocket {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code?: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  close(): void;
}

/** Opens a ComfyUI `/ws` connection. Injected so tests use an in-process fake. */
export type ComfyWsFactory = (url: string) => ComfyWebSocket;

/** A single output file ComfyUI reports in `/history` (`images` / `gifs` / `audio`). */
interface ComfyFileRef {
  readonly filename?: unknown;
  readonly subfolder?: unknown;
  readonly type?: unknown;
}

/** `/history/{id}` response shape (the slice we read). */
type ComfyHistory = Record<
  string,
  { readonly outputs?: Record<string, Record<string, unknown>> } | undefined
>;

/**
 * Default ws factory: adapts the environment's global `WebSocket` (Node ≥ 22 /
 * Electron) to {@link ComfyWebSocket}. Throws if none exists — production may
 * instead inject a factory backed by the `ws` package. Kept injectable so tests
 * NEVER open a real socket.
 */
export const defaultComfyWsFactory: ComfyWsFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => unknown }).WebSocket;
  if (typeof Ctor !== 'function') {
    throw new Error(
      'No global WebSocket available; pass a wsFactory to ComfyClient (e.g. the `ws` package).',
    );
  }
  const sock = new Ctor(url) as {
    addEventListener(type: string, cb: (ev: unknown) => void): void;
    close(): void;
  };
  return {
    on(event, cb): void {
      if (event === 'message') {
        sock.addEventListener('message', (ev) =>
          (cb as (d: unknown) => void)((ev as { data: unknown }).data),
        );
      } else if (event === 'close') {
        sock.addEventListener('close', (ev) =>
          (cb as (c?: number) => void)((ev as { code?: number }).code),
        );
      } else if (event === 'error') {
        sock.addEventListener('error', () =>
          (cb as (e: Error) => void)(new Error('comfy websocket error')),
        );
      } else {
        sock.addEventListener('open', () => (cb as () => void)());
      }
    },
    close(): void {
      sock.close();
    },
  };
};

export interface ComfyClientDeps {
  /**
   * Resolve the ComfyUI http origin (no trailing slash), e.g.
   * `http://127.0.0.1:8188`. Local: start the supervisor and return its origin
   * (see {@link ./comfy-supervisor!createComfySupervisor}); remote: a constant.
   */
  readonly resolveOrigin: () => Promise<string>;
  /** Injectable http (default: global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Injectable ws (default: {@link defaultComfyWsFactory}). */
  readonly wsFactory?: ComfyWsFactory;
  /** Stable `client_id` for `/ws` correlation (default: a fresh random id per run). */
  readonly clientId?: string;
  /** Injectable file writer for downloaded outputs (default: `fs.writeFile`). */
  readonly writeFileImpl?: (path: string, data: Uint8Array) => Promise<void>;
  /** Workflow template registry (default: the bundled {@link WORKFLOW_TEMPLATES}). */
  readonly registry?: Readonly<Record<string, WorkflowTemplate>>;
}

/** `run()` options — the JobRunner surface (`extraWith` is accepted but unused). */
export interface ComfyRunOptions {
  readonly onEvent?: (event: GenEvent) => void;
  readonly signal?: AbortSignal;
  /** Unused by the persistent server; accepted for {@link JobRunner} parity. */
  readonly extraWith?: readonly string[];
}

/** Per-candidate ws waiter the message router resolves/rejects. */
interface Waiter {
  readonly promptId: string;
  onProgress(step: number, total: number): void;
  resolve(): void;
  reject(err: Error): void;
}

export class ComfyClient {
  readonly #deps: ComfyClientDeps;

  constructor(deps: ComfyClientDeps) {
    this.#deps = deps;
  }

  get #fetch(): typeof fetch {
    return this.#deps.fetchImpl ?? fetch;
  }

  /**
   * Run one `comfyui` job to completion. Resolves with every candidate's output;
   * rejects (after emitting a terminal `error` event) on validation/exec failure,
   * or with {@link GenAbortError} on abort.
   */
  async run(job: GenJob, options: ComfyRunOptions = {}): Promise<GenOutput[]> {
    if (options.signal?.aborted === true) throw new GenAbortError();
    const spec = job.comfy;
    if (spec === undefined) {
      throw new Error(`comfyui job "${job.id}" is missing its \`comfy\` spec`);
    }
    const registry = this.#deps.registry ?? WORKFLOW_TEMPLATES;
    const wsFactory = this.#deps.wsFactory ?? defaultComfyWsFactory;
    const writeFileImpl = this.#deps.writeFileImpl ?? ((p, d) => fsWriteFile(p, d));
    const clientId = this.#deps.clientId ?? `pi-gen-${Math.random().toString(36).slice(2)}`;
    const emit = (event: GenEvent): void => options.onEvent?.(event);
    const jobId = job.id;

    const origin = (await this.#deps.resolveOrigin()).replace(/\/+$/, '');
    const wsUrl = `${origin.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;

    const seeds = spec.seeds.length > 0 ? spec.seeds : [0];
    const totalSteps = typeof spec.inputs.steps === 'number' ? (spec.inputs.steps as number) : 0;

    // ── ws lifecycle + message router ──────────────────────────────────────
    let waiter: Waiter | null = null;
    let wsFailure: Error | null = null;
    let aborted = false;
    let finished = false;

    const ws = wsFactory(wsUrl);
    ws.on('message', (data) => {
      if (typeof data !== 'string') return; // binary preview frame — ignored
      let msg: { type?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      const d = msg.data ?? {};
      const w = waiter;
      if (w === null) return;
      const pid = typeof d.prompt_id === 'string' ? (d.prompt_id as string) : undefined;
      if (pid !== undefined && pid !== w.promptId) return; // a different prompt
      switch (msg.type) {
        case 'progress': {
          const step = typeof d.value === 'number' ? (d.value as number) : 0;
          const total = typeof d.max === 'number' ? (d.max as number) : totalSteps;
          w.onProgress(step, total);
          break;
        }
        case 'executing': {
          // node === null (with our prompt_id) is ComfyUI's "this prompt finished".
          if (d.node === null || d.node === undefined) w.resolve();
          break;
        }
        case 'execution_error': {
          const m =
            typeof d.exception_message === 'string'
              ? (d.exception_message as string)
              : 'ComfyUI execution error';
          w.reject(new Error(m));
          break;
        }
        case 'execution_interrupted': {
          w.reject(new Error('ComfyUI execution interrupted'));
          break;
        }
        default:
          break;
      }
    });
    const onWsGone = (err: Error): void => {
      if (finished) return;
      wsFailure ??= err;
      waiter?.reject(err);
    };
    ws.on('close', () => onWsGone(new Error('ComfyUI websocket closed before completion')));
    ws.on('error', (err) => onWsGone(err instanceof Error ? err : new Error(String(err))));

    // ── abort wiring ───────────────────────────────────────────────────────
    const onAbort = (): void => {
      aborted = true;
      const e = new GenAbortError();
      waiter?.reject(e);
      // Best-effort: ask ComfyUI to stop, then drop the socket.
      void this.#fetch(`${origin}/interrupt`, { method: 'POST' }).catch(() => {});
      try {
        ws.close();
      } catch {
        // already gone
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      finished = true;
      options.signal?.removeEventListener('abort', onAbort);
      try {
        ws.close();
      } catch {
        // already gone
      }
    };

    try {
      await this.#awaitOpen(ws, options.signal);
      emit({ event: 'start', jobId, total: totalSteps, candidates: seeds.length });

      const outputs: GenOutput[] = [];
      for (let i = 0; i < seeds.length; i++) {
        if (aborted) throw new GenAbortError();
        if (wsFailure !== null) throw wsFailure;
        const seed = seeds[i] ?? 0;
        const graph = fillWorkflow(spec, seed, registry);
        const promptId = await this.#postPrompt(origin, graph, clientId);

        await new Promise<void>((resolve, reject) => {
          waiter = {
            promptId,
            onProgress: (step, total) =>
              emit({ event: 'progress', jobId, candidate: i, step, total }),
            resolve: () => {
              waiter = null;
              resolve();
            },
            reject: (err) => {
              waiter = null;
              reject(err);
            },
          };
        });

        const history = await this.#getHistory(origin, promptId);
        const candOutputs = await this.#downloadOutputs(
          origin,
          history,
          promptId,
          job,
          seed,
          writeFileImpl,
        );
        if (candOutputs.length === 0) {
          throw new Error(`ComfyUI job "${jobId}" produced no output files (prompt ${promptId})`);
        }
        outputs.push(...candOutputs);
        const first = candOutputs[0];
        if (first !== undefined) emit({ event: 'candidate', jobId, index: i, output: first });
      }

      emit({ event: 'done', jobId, outputs });
      cleanup();
      return outputs;
    } catch (err) {
      cleanup();
      if (aborted || err instanceof GenAbortError) throw new GenAbortError();
      const message = err instanceof Error ? err.message : String(err);
      emit({ event: 'error', jobId, message, recoverable: false });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /** Resolve when the socket opens; reject on an early error or an abort during connect. */
  #awaitOpen(ws: ComfyWebSocket, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = (): void => settle(() => reject(new GenAbortError()));
      if (signal?.aborted === true) {
        reject(new GenAbortError());
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.on('open', () => settle(resolve));
      ws.on('error', (err) =>
        settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
      );
    });
  }

  /** POST a resolved graph to `/prompt`; returns its `prompt_id`. Throws on validation/http error. */
  async #postPrompt(origin: string, graph: unknown, clientId: string): Promise<string> {
    const res = await this.#fetch(`${origin}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = JSON.stringify(await res.json());
      } catch {
        detail = await res.text().catch(() => '');
      }
      throw new Error(`ComfyUI /prompt failed (${res.status}): ${detail.slice(0, 500)}`);
    }
    const body = (await res.json()) as {
      prompt_id?: unknown;
      node_errors?: Record<string, unknown>;
    };
    if (body.node_errors !== undefined && Object.keys(body.node_errors).length > 0) {
      throw new Error(
        `ComfyUI validation error: ${JSON.stringify(body.node_errors).slice(0, 500)}`,
      );
    }
    if (typeof body.prompt_id !== 'string') {
      throw new Error('ComfyUI /prompt returned no prompt_id');
    }
    return body.prompt_id;
  }

  /** Fetch `/history/{promptId}`. */
  async #getHistory(origin: string, promptId: string): Promise<ComfyHistory> {
    const res = await this.#fetch(`${origin}/history/${encodeURIComponent(promptId)}`);
    if (!res.ok) throw new Error(`ComfyUI /history failed (${res.status})`);
    return (await res.json()) as ComfyHistory;
  }

  /** Download every output file this prompt produced (`/view`) into the job's outputDir. */
  async #downloadOutputs(
    origin: string,
    history: ComfyHistory,
    promptId: string,
    job: GenJob,
    seed: number,
    writeFileImpl: (path: string, data: Uint8Array) => Promise<void>,
  ): Promise<GenOutput[]> {
    const entry = history[promptId];
    const outputsMap = entry?.outputs ?? {};
    const files: ComfyFileRef[] = [];
    for (const nodeOut of Object.values(outputsMap)) {
      for (const key of ['images', 'gifs', 'audio', 'video', 'files'] as const) {
        const arr = (nodeOut as Record<string, unknown>)[key];
        if (Array.isArray(arr)) {
          for (const f of arr)
            if (f !== null && typeof f === 'object') files.push(f as ComfyFileRef);
        }
      }
    }
    const results: GenOutput[] = [];
    for (const f of files) {
      if (typeof f.filename !== 'string' || f.filename.length === 0) continue;
      const params = new URLSearchParams({ filename: f.filename });
      if (typeof f.subfolder === 'string' && f.subfolder.length > 0) {
        params.set('subfolder', f.subfolder);
      }
      if (typeof f.type === 'string' && f.type.length > 0) params.set('type', f.type);
      const res = await this.#fetch(`${origin}/view?${params.toString()}`);
      if (!res.ok) throw new Error(`ComfyUI /view failed for ${f.filename} (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const outputPath = join(job.outputDir, f.filename);
      await writeFileImpl(outputPath, bytes);
      results.push({ outputPath, modality: job.modality, model: job.comfy?.modelId ?? '', seed });
    }
    return results;
  }
}
