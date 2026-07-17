/**
 * Coordination-harness (CorpEngine) IPC contract. Composed into the app-wide maps
 * in ../ipc-contract.ts. Type-only imports of the neutral `@pi-desktop/coordination`
 * DTOs keep the engine's Node runtime out of the sandboxed preload bundle — the
 * renderer talks to the main-process CorpEngine over these channels (the
 * RENDERER-BARREL rule: the renderer never value-imports the harness/coordination
 * corp engine).
 *
 * The engine runs behind the EXPERIMENTAL production-harness flag; these channels
 * are always registered but only reached when the flag (or `PI_DESKTOP_CORP=1`) is
 * on. Trusted-sender gated like every other app channel.
 */

import type {
  CoordinationEvent,
  OrgChartView,
  ProductPeek,
  TaskContext,
  WorkerTranscriptView,
} from '@pi-desktop/coordination';

export type CorpInvokeMap = {
  /** Start a coordination task; returns its stable id. Events stream on
   * `corp:event` (filtered by this taskId) until a terminal `done`. */
  'corp:start': {
    request: { prompt: string; ctx?: TaskContext };
    response: { taskId: string };
  };
  /** Mid-run steering to the lead (no faked user turn). Fire-and-forget. */
  'corp:steer': { request: { taskId: string; text: string }; response: { ok: boolean } };
  /** Stop the task; the stream ends with a `done` event, `outcome:'aborted'`. */
  'corp:abort': { request: { taskId: string }; response: { ok: boolean } };
  /** Answer a surfaced permission request. */
  'corp:respond-permission': {
    request: { taskId: string; requestId: string; granted: boolean };
    response: { ok: boolean };
  };
  /** Synchronous org-chart snapshot (situation-room bootstrap / read-back). */
  'corp:get-org-chart': {
    request: { taskId: string };
    response: { chart: OrgChartView | null };
  };
  /** The REAL captured turn stream for one node (the click-through). `null` when
   * the node has no attributable activity yet (the app falls back to a preview). */
  'corp:worker-transcript': {
    request: { taskId: string; nodeId: string };
    response: { transcript: WorkerTranscriptView | null };
  };
  /** "Peek at what we have so far" (spec §11): a live snapshot of the in-progress
   * product tree (real files), served on demand from the running task's workspace.
   * `null` for an unknown/ended task; an empty file list means nothing built yet. */
  'corp:peek': {
    request: { taskId: string };
    response: { peek: ProductPeek | null };
  };
};

export const CORP_INVOKE_CHANNELS = [
  'corp:start',
  'corp:steer',
  'corp:abort',
  'corp:respond-permission',
  'corp:get-org-chart',
  'corp:worker-transcript',
  'corp:peek',
] as const satisfies readonly (keyof CorpInvokeMap)[];

export type CorpEventMap = {
  /** One coordination event for a running task, tagged with its id so the
   * renderer can rebuild a per-task `AsyncIterable<CoordinationEvent>`. */
  'corp:event': { taskId: string; event: CoordinationEvent };
};
