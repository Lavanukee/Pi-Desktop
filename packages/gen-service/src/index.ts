/**
 * @pi-desktop/gen-service — the generation backend core: a REMOTE-CAPABLE job
 * protocol, the verified modality catalog, a uv-managed Python worker
 * (mflux/MLX for image today; audio/video/3d pluggable behind the same
 * envelope), a Node client that streams the worker's NDJSON events, and a
 * unified-memory-budget-aware JobQueue.
 *
 * Electron-free: the Electron gen manager imports this and adds the socket
 * bridge + IPC. Nothing here touches Electron or React.
 */
export type { License, MfluxBackendConfig, ModalityModel } from './catalog.js';
export {
  activeModels,
  defaultImageModel,
  getModel,
  MODALITY_CATALOG,
  modelsForModality,
  requiresLicenseGate,
} from './catalog.js';
export type {
  GenChildProcess,
  GenReadable,
  GenServiceClientOptions,
  GenSpawnFn,
  GenWritable,
  RunJobOptions,
} from './client.js';
export { defaultGenSpawn, GenAbortError, GenServiceClient } from './client.js';
export type {
  EnqueueOptions,
  JobHandle,
  JobQueueEvent,
  JobQueueListener,
  JobQueueOptions,
  JobRunner,
  JobStatus,
} from './job-queue.js';
export { JobQueue } from './job-queue.js';
export type {
  Backend,
  GenEvent,
  GenJob,
  GenOutput,
  ImageJobSpec,
  Modality,
  TerminalGenEvent,
} from './protocol.js';
export { isGenEvent, NdjsonParser, parseGenEventLine } from './protocol.js';
export type { WorkerUvArgsOptions } from './worker-command.js';
export {
  buildWorkerUvArgs,
  DEFAULT_PYTHON_VERSION,
  GEN_WORKER_PATH_ENV,
  MFLUX_PIN,
  resolveWorkerScript,
} from './worker-command.js';
