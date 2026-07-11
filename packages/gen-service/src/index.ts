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
  ComfyClientDeps,
  ComfyRunOptions,
  ComfyWebSocket,
  ComfyWsFactory,
} from './comfy-client.js';
export { ComfyClient, defaultComfyWsFactory } from './comfy-client.js';
export type {
  ComfyLaunchConfig,
  ComfySupervisorHandle,
  CreateComfySupervisorOptions,
} from './comfy-supervisor.js';
export { buildComfyArgs, createComfySupervisor } from './comfy-supervisor.js';
export type { ComfyGraph, ComfyNode, WorkflowTemplate } from './comfy-workflow.js';
export { fillWorkflow, getWorkflowTemplate, WORKFLOW_TEMPLATES } from './comfy-workflow.js';
export type { GenRunnerLike, MakeGenRunnerDeps } from './gen-runner.js';
export { makeGenRunner } from './gen-runner.js';
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
  ComfyBackendConfig,
  ComfyJobSpec,
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
  baseWorkerWith,
  buildWorkerUvArgs,
  DEFAULT_PYTHON_VERSION,
  GEN_WORKER_PATH_ENV,
  MFLUX_PIN,
  MLX_AUDIO_PIN,
  resolveWorkerScript,
} from './worker-command.js';
