/**
 * "inference-supervisor" utilityProcess entry (plan §D). Owns the single live
 * LlamaServerSupervisor plus the catalog / recommender / downloader, and writes
 * pi's models.json so pi's llamacpp provider points at the live server. Talks
 * to the main-process host (llm-main.ts) over parentPort using ./protocol.
 *
 * Bundled to dist-electron/inference-supervisor.js (vite.config main entry) and
 * forked by llm-main.ts. Isolated from Electron main so a wedged download or a
 * crash-looping llama-server never takes the UI process down.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildProviderBlock,
  CATALOG,
  type CatalogFile,
  type CatalogModel,
  detectHardware,
  downloadModel,
  ensureLlamaCpp,
  getCatalogFile,
  getCatalogModel,
  LlamaServerSupervisor,
  modelDir,
  probeServerFeatures,
  recommend,
  writeModelsJson,
} from '@pi-desktop/inference';
import type { LlmCatalogEntry, LlmHardware, LlmStatus } from '../ipc-contract';
import type {
  LlmCatalogReply,
  LlmOutbound,
  LlmRequest,
  LlmVerifyReply,
  UtilityParentPort,
} from './protocol';

const parentPort = (process as unknown as { parentPort: UtilityParentPort }).parentPort;

/** Bound the launched context so a large-window model can't blow past RAM; the
 * footer gauge uses the launched size as its denominator. */
const CONTEXT_CAP = 16_384;
const MODELS_JSON = join(homedir(), '.pi', 'agent', 'models.json');
const PROVIDER_NAME = 'llamacpp';

interface CurrentServer {
  supervisor: LlamaServerSupervisor;
  model: CatalogModel;
  file: CatalogFile;
  contextWindow: number;
  baseUrl: string;
}

let current: CurrentServer | null = null;
let phase: LlmStatus['phase'] = 'idle';
let lastError: string | undefined;
let metrics: LlmStatus['metrics'] = null;

/** In-flight download bookkeeping. `intent` disambiguates a deliberate
 * pause/cancel (an AbortSignal fires either way) from a genuine transfer error. */
let downloadController: AbortController | null = null;
let downloadIntent: 'pause' | 'cancel' | null = null;

function post(message: LlmOutbound): void {
  parentPort.postMessage(message);
}

function modelPathFor(model: CatalogModel, file: CatalogFile): string {
  return join(modelDir(model.id), file.name);
}

function isDownloaded(model: CatalogModel, file: CatalogFile): boolean {
  return existsSync(modelPathFor(model, file));
}

function pickFile(model: CatalogModel, quant?: string): CatalogFile | undefined {
  return quant !== undefined ? getCatalogFile(model, quant) : model.files[0];
}

function status(): LlmStatus {
  return {
    phase,
    serverRunning: current?.supervisor.running ?? false,
    baseUrl: current?.baseUrl ?? null,
    model: current
      ? {
          id: current.model.id,
          displayName: current.model.displayName,
          quant: current.file.quant,
          contextWindow: current.contextWindow,
        }
      : null,
    metrics,
    downloadedModelIds: CATALOG.filter((m) => m.files.some((f) => isDownloaded(m, f))).map(
      (m) => m.id,
    ),
    error: lastError,
  };
}

function emitStatus(): void {
  post({ kind: 'status', status: status() });
}

function catalogEntry(model: CatalogModel, recommendedId: string | null): LlmCatalogEntry {
  return {
    id: model.id,
    displayName: model.displayName,
    quants: model.files.map((f) => ({ quant: f.quant, bytes: f.bytes })),
    minRamGB: model.minRamGB,
    contextWindow: model.contextWindow,
    input: [...model.input],
    license: model.license,
    mtp: model.mtpEmbedded === true || model.mtpFile !== undefined,
    vision: model.input.includes('image'),
    downloaded: model.files.some((f) => isDownloaded(model, f)),
    recommended: model.id === recommendedId,
  };
}

async function listCatalog(): Promise<LlmCatalogReply> {
  const hw = await detectHardware();
  const hardware: LlmHardware = {
    totalRamGB: hw.totalRamGB,
    chip: hw.chip ?? null,
    isAppleSilicon: hw.isAppleSilicon,
  };
  let recommendedModelId: string | null = null;
  let recommendation: LlmCatalogReply['recommendation'] = null;
  try {
    const rec = recommend(hw);
    recommendedModelId = rec.model.id;
    recommendation = {
      modelId: rec.model.id,
      quant: rec.file.quant,
      tier: rec.tier,
      rationale: rec.rationale,
    };
  } catch {
    recommendedModelId = null;
    recommendation = null;
  }
  return {
    models: CATALOG.map((m) => catalogEntry(m, recommendedModelId)),
    hardware,
    recommendedModelId,
    recommendation,
  };
}

/** Restore the phase after a download settles (running server → ready, else idle). */
function settleDownloadPhase(): void {
  phase = current?.supervisor.running === true ? 'ready' : 'idle';
}

async function downloadOne(
  modelId: string,
  quant?: string,
): Promise<{ success: boolean; error?: string; paused?: boolean; cancelled?: boolean }> {
  const model = getCatalogModel(modelId);
  if (model === undefined) return { success: false, error: `unknown model: ${modelId}` };
  // Serialize: one download at a time. A second request while one runs is a
  // no-op so the UI can't fork two writers onto the same `.part`.
  if (downloadController !== null)
    return { success: false, error: 'a download is already running' };

  const controller = new AbortController();
  downloadController = controller;
  downloadIntent = null;
  phase = 'downloading';
  lastError = undefined;
  emitStatus();
  try {
    await downloadModel(model, {
      quant,
      launchMode: 'fast-text',
      signal: controller.signal,
      onProgress: (file, p) =>
        post({
          kind: 'download-progress',
          progress: {
            modelId,
            file,
            received: p.received,
            total: p.total ?? null,
            fraction: p.fraction ?? null,
          },
        }),
    });
    settleDownloadPhase();
    emitStatus();
    return { success: true };
  } catch (error) {
    // An abort means the user paused or cancelled — not a failure.
    if (downloadIntent === 'pause') {
      settleDownloadPhase();
      emitStatus();
      return { success: false, paused: true };
    }
    if (downloadIntent === 'cancel') {
      await discardPartials(model, quant);
      settleDownloadPhase();
      emitStatus();
      return { success: false, cancelled: true };
    }
    phase = 'error';
    lastError = String(error instanceof Error ? error.message : error);
    emitStatus();
    return { success: false, error: lastError };
  } finally {
    downloadController = null;
    downloadIntent = null;
  }
}

function pauseDownload(): { success: boolean } {
  if (downloadController === null) return { success: false };
  downloadIntent = 'pause';
  downloadController.abort();
  return { success: true };
}

async function cancelDownload(): Promise<{ success: boolean }> {
  if (downloadController === null) return { success: false };
  downloadIntent = 'cancel';
  downloadController.abort();
  return { success: true };
}

/** Remove the `.part` sidecars for a model's files so a cancel leaves nothing
 * half-written for a later resume to pick up. */
async function discardPartials(model: CatalogModel, quant?: string): Promise<void> {
  const files = quant !== undefined ? model.files.filter((f) => f.quant === quant) : model.files;
  for (const file of files) {
    await unlink(`${modelPathFor(model, file)}.part`).catch(() => {});
  }
}

async function deleteModel(modelId: string): Promise<{ success: boolean; error?: string }> {
  const model = getCatalogModel(modelId);
  if (model === undefined) return { success: false, error: `unknown model: ${modelId}` };
  // Refuse to delete the model currently serving — stop it first.
  if (current?.model.id === modelId)
    return { success: false, error: 'model is running; stop it first' };
  try {
    await rm(modelDir(modelId), { recursive: true, force: true });
    emitStatus();
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error instanceof Error ? error.message : error) };
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Re-hash each on-disk file against its catalog sha256. Files with no catalog
 * sha are reported `checked: false` (nothing to verify), which still counts as
 * ok so a hash-less entry never shows as corrupt. */
async function verifyModel(modelId: string, quant?: string): Promise<LlmVerifyReply> {
  const model = getCatalogModel(modelId);
  if (model === undefined) return { ok: false, files: [], error: `unknown model: ${modelId}` };
  const files = quant !== undefined ? model.files.filter((f) => f.quant === quant) : model.files;
  const results: LlmVerifyReply['files'] = [];
  for (const file of files) {
    const filePath = modelPathFor(model, file);
    if (!existsSync(filePath)) continue;
    if (file.sha256 === undefined) {
      results.push({ file: file.name, ok: true, checked: false });
      continue;
    }
    try {
      const actual = await sha256File(filePath);
      results.push({ file: file.name, ok: actual === file.sha256, checked: true });
    } catch (error) {
      return {
        ok: false,
        files: results,
        error: String(error instanceof Error ? error.message : error),
      };
    }
  }
  return { ok: results.every((r) => r.ok), files: results };
}

/** llama-server prints a per-request generation timing line to stderr; parse
 * its tokens/s so the footer shows real throughput (the provider's own
 * onTimings runs inside pi and can't reach this process). */
function parseTps(line: string): number | undefined {
  if (!line.includes('eval time') || line.includes('prompt eval time')) return undefined;
  const m = line.match(/([\d.]+)\s*tokens per second/);
  return m ? Number(m[1]) : undefined;
}

async function startServer(
  modelId: string,
  quant?: string,
): Promise<{ success: boolean; baseUrl?: string; error?: string }> {
  const model = getCatalogModel(modelId);
  if (model === undefined) return { success: false, error: `unknown model: ${modelId}` };
  const file = pickFile(model, quant);
  if (file === undefined) return { success: false, error: `unknown quant for ${modelId}` };
  const modelPath = modelPathFor(model, file);
  if (!existsSync(modelPath)) return { success: false, error: 'model not downloaded' };

  phase = 'starting';
  lastError = undefined;
  metrics = null;
  emitStatus();

  try {
    if (current !== null) {
      await current.supervisor.dispose();
      current = null;
    }
    const install = await ensureLlamaCpp();
    const features = await probeServerFeatures(install.serverPath);
    const contextWindow = Math.min(model.contextWindow, CONTEXT_CAP);

    const supervisor = new LlamaServerSupervisor({
      serverPath: install.serverPath,
      modelPath,
      launchMode: 'fast-text',
      contextSize: contextWindow,
      mtpSupported: features.mtp,
      mtpEmbedded: model.mtpEmbedded,
    });

    supervisor.on((event) => {
      if (event.type === 'metrics') {
        metrics = { lastTps: event.metrics.lastTps, avgTps: event.metrics.avgTps };
        emitStatus();
      } else if (event.type === 'log' && event.stream === 'stderr') {
        for (const line of event.text.split('\n')) {
          const tps = parseTps(line);
          if (tps !== undefined) supervisor.recordTimings({ predicted_per_second: tps });
        }
      } else if (event.type === 'crash' || event.type === 'restart') {
        phase = 'starting';
        emitStatus();
      } else if (event.type === 'exit' && event.reason === 'failed') {
        phase = 'error';
        lastError = event.detail ?? 'llama-server failed';
        current = null;
        emitStatus();
      }
    });

    const started = await supervisor.start();
    const baseUrl = supervisor.baseUrl;
    current = { supervisor, model, file, contextWindow, baseUrl };
    phase = 'ready';

    await writeModelsJson(
      MODELS_JSON,
      PROVIDER_NAME,
      buildProviderBlock(model, { baseUrl, servedModelId: model.id }),
    );

    emitStatus();
    return { success: true, baseUrl: started.baseUrl };
  } catch (error) {
    phase = 'error';
    lastError = String(error instanceof Error ? error.message : error);
    current = null;
    emitStatus();
    return { success: false, error: lastError };
  }
}

async function stopServer(): Promise<{ success: boolean }> {
  if (current !== null) {
    await current.supervisor.dispose();
    current = null;
  }
  phase = 'idle';
  metrics = null;
  emitStatus();
  return { success: true };
}

async function handle(req: LlmRequest): Promise<unknown> {
  switch (req.type) {
    case 'get-status':
      return status();
    case 'list-catalog':
      return listCatalog();
    case 'download-model':
      return downloadOne(req.modelId, req.quant);
    case 'pause-download':
      return pauseDownload();
    case 'cancel-download':
      return cancelDownload();
    case 'delete-model':
      return deleteModel(req.modelId);
    case 'verify-model':
      return verifyModel(req.modelId, req.quant);
    case 'start-server':
      return startServer(req.modelId, req.quant);
    case 'stop-server':
      return stopServer();
  }
}

parentPort.on('message', (event) => {
  const req = event.data as LlmRequest;
  handle(req)
    .then((result) => post({ id: req.id, kind: 'reply', result }))
    .catch((error) =>
      post({
        id: req.id,
        kind: 'error',
        error: String(error instanceof Error ? error.message : error),
      }),
    );
});

// Announce initial idle state so the host has something to broadcast on attach.
emitStatus();
