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
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildProviderBlock,
  CATALOG,
  type CatalogFile,
  type CatalogModel,
  detectHardware,
  downloadModel,
  ensureLlamaCpp,
  estimateRamGB,
  getCatalogFile,
  getCatalogModel,
  type HfGgufFile,
  type HfModelHit,
  type HfSort,
  hfModelToCatalogEntry,
  LlamaServerSupervisor,
  listHfGgufFiles,
  modelDir,
  probeServerFeatures,
  recommend,
  searchHfModels,
  writeModelsJson,
} from '@pi-desktop/inference';
import type {
  HfGgufFileDTO,
  HfModelHitDTO,
  HfSortOption,
  LlmCatalogEntry,
  LlmHardware,
  LlmStatus,
} from '../ipc-contract';
import { DownloadCancellation, discardPartials, partialPaths } from './download-cancellation';
import type {
  HfListFilesReply,
  HfRegisterReply,
  HfSearchReply,
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

/** Discovered Browse-HF models, adapted to the catalog shape. Persisted so a
 * downloaded HF model survives a supervisor restart and stays in the local set. */
const HF_MODELS_JSON = join(homedir(), '.pi', 'desktop', 'hf-models.json');
const hfModels = new Map<string, CatalogModel>();

function loadHfModels(): void {
  try {
    const raw = readFileSync(HF_MODELS_JSON, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const m of parsed) {
        if (typeof m === 'object' && m !== null && typeof (m as CatalogModel).id === 'string') {
          hfModels.set((m as CatalogModel).id, m as CatalogModel);
        }
      }
    }
  } catch {
    // Absent/corrupt registry → start empty; a fresh add rewrites it.
  }
}

function persistHfModels(): void {
  try {
    mkdirSync(dirname(HF_MODELS_JSON), { recursive: true });
    writeFileSync(HF_MODELS_JSON, `${JSON.stringify([...hfModels.values()], null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort: an unwritable registry only costs cross-restart persistence.
  }
}

/** Resolve a model id against the curated catalog first, then discovered HF adds. */
function getModel(id: string): CatalogModel | undefined {
  return getCatalogModel(id) ?? hfModels.get(id);
}

/** All models the manager knows about: curated + discovered HF (dedup by id). */
function allModels(): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const m of CATALOG) byId.set(m.id, m);
  for (const m of hfModels.values()) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()];
}

/** Map the UI sort option onto the raw HF models-API sort key. */
function toHfSort(sort: HfSortOption | undefined): HfSort {
  if (sort === 'likes') return 'likes';
  if (sort === 'recent') return 'lastModified';
  if (sort === 'trending') return 'trendingScore';
  return 'downloads';
}

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
const cancellation = new DownloadCancellation();

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
    downloadedModelIds: allModels()
      .filter((m) => m.files.some((f) => isDownloaded(m, f)))
      .map((m) => m.id),
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
    spec: model.spec,
    vision: model.input.includes('image'),
    downloaded: model.files.some((f) => isDownloaded(model, f)),
    recommended: model.id === recommendedId,
    hfRepo: model.hfRepo,
    gated: model.gated === true,
    source: hfModels.has(model.id) ? 'hf' : 'curated',
    verified: model.verified,
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
      simpleSet: rec.simpleSet.map((p) => ({
        role: p.role,
        modelId: p.model.id,
        displayName: p.model.displayName,
        quant: p.file.quant,
        launchMode: p.launchMode,
        spec: p.spec,
        vision: p.vision,
      })),
    };
  } catch {
    recommendedModelId = null;
    recommendation = null;
  }
  // Curated first (recommender picks live here), then discovered HF adds.
  return {
    models: allModels().map((m) => catalogEntry(m, recommendedModelId)),
    hardware,
    recommendedModelId,
    recommendation,
  };
}

// --- Hugging Face browse + register ------------------------------------------

function toHfHit(hit: HfModelHit): HfModelHitDTO {
  return {
    id: hit.id,
    author: hit.author,
    name: hit.name,
    downloads: hit.downloads,
    likes: hit.likes,
    tags: [...hit.tags],
    gated: hit.gated,
    pipelineTag: hit.pipelineTag,
    updatedAt: hit.updatedAt,
    likesRecent: hit.likesRecent,
  };
}

function toHfFile(file: HfGgufFile, contextWindow: number): HfGgufFileDTO {
  return {
    path: file.path,
    sizeBytes: file.sizeBytes,
    quant: file.quant,
    sha256: file.sha256,
    mmproj: file.mmproj,
    mtp: file.mtp,
    minRamGB:
      file.sizeBytes !== undefined && file.sizeBytes > 0
        ? estimateRamGB(file.sizeBytes, contextWindow)
        : undefined,
  };
}

async function hfSearch(req: Extract<LlmRequest, { type: 'hf-search' }>): Promise<HfSearchReply> {
  try {
    const hits = await searchHfModels(req.query, {
      filters: {
        family: req.family,
        task: req.task,
        gated: req.gated,
        minLikes: req.minLikes,
      },
      sort: toHfSort(req.sort),
      limit: req.limit,
      hfToken: req.hfToken,
    });
    return { hits: hits.map(toHfHit) };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    return { hits: [], error: message, rateLimited: /HTTP 429/.test(message) };
  }
}

async function hfListFiles(
  req: Extract<LlmRequest, { type: 'hf-list-files' }>,
): Promise<HfListFilesReply> {
  const contextWindow = req.contextWindow ?? 8192;
  try {
    const files = await listHfGgufFiles(req.repoId, { hfToken: req.hfToken });
    return { files: files.map((f) => toHfFile(f, contextWindow)) };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    // A 401/403 on the tree is the gated-repo signal (needs a token/licence).
    return { files: [], error: message, gated: /HTTP 40[13]/.test(message) };
  }
}

/** Coerce a serialized HfGgufFileDTO back to the package's HfGgufFile shape. */
function fromHfFileDTO(f: HfGgufFileDTO): HfGgufFile {
  return {
    path: f.path,
    sizeBytes: f.sizeBytes,
    quant: f.quant,
    sha256: f.sha256,
    mmproj: f.mmproj,
    mtp: f.mtp,
  };
}

function registerHfModel(req: Extract<LlmRequest, { type: 'register-hf-model' }>): HfRegisterReply {
  const entry = hfModelToCatalogEntry(req.hit, fromHfFileDTO(req.file), {
    contextWindow: req.contextWindow,
    mmproj: req.mmproj !== undefined ? fromHfFileDTO(req.mmproj) : undefined,
    mtpFile: req.mtpFile !== undefined ? fromHfFileDTO(req.mtpFile) : undefined,
  });
  hfModels.set(entry.id, entry);
  persistHfModels();
  emitStatus();
  // A discovered HF add is never the hardware recommendation (the recommender
  // only ever picks a curated model), so recommendedId is null here.
  return { modelId: entry.id, entry: catalogEntry(entry, null) };
}

/** Restore the phase after a download settles (running server → ready, else idle). */
function settleDownloadPhase(): void {
  phase = current?.supervisor.running === true ? 'ready' : 'idle';
}

async function downloadOne(
  modelId: string,
  quant?: string,
  hfToken?: string,
): Promise<{ success: boolean; error?: string; paused?: boolean; cancelled?: boolean }> {
  const model = getModel(modelId);
  if (model === undefined) return { success: false, error: `unknown model: ${modelId}` };
  // Serialize: one download at a time. A second request while one runs is a
  // no-op so the UI can't fork two writers onto the same `.part`.
  if (cancellation.running) return { success: false, error: 'a download is already running' };

  const signal = cancellation.begin();
  phase = 'downloading';
  lastError = undefined;
  emitStatus();
  try {
    await downloadModel(model, {
      quant,
      launchMode: 'fast-text',
      signal,
      hfToken,
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
    if (cancellation.intent === 'pause') {
      settleDownloadPhase();
      emitStatus();
      return { success: false, paused: true };
    }
    if (cancellation.intent === 'cancel') {
      await discardPartials(partialPaths(modelDir(model.id), model.files, quant, join), (p) =>
        unlink(p),
      );
      settleDownloadPhase();
      emitStatus();
      return { success: false, cancelled: true };
    }
    phase = 'error';
    lastError = String(error instanceof Error ? error.message : error);
    emitStatus();
    return { success: false, error: lastError };
  } finally {
    cancellation.clear();
  }
}

function pauseDownload(): { success: boolean } {
  return { success: cancellation.pause() };
}

async function cancelDownload(): Promise<{ success: boolean }> {
  return { success: cancellation.cancel() };
}

async function deleteModel(modelId: string): Promise<{ success: boolean; error?: string }> {
  const model = getModel(modelId);
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
  const model = getModel(modelId);
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
  const model = getModel(modelId);
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

    // Resolve the speed-decode sibling for a fast-text launch:
    //   - Gemma4 MTP head (separate sibling in the same repo) → --model-draft.
    //   - EAGLE-3 draft (from draftRepo) → --spec-type draft-eagle3 --model-draft.
    // Both are downloaded alongside the main GGUF (see model-downloader).
    const dir = modelDir(model.id);
    const mtpSiblingPath =
      model.mtpFile !== undefined && model.mtpEmbedded !== true
        ? join(dir, model.mtpFile.name)
        : undefined;
    const draftPath =
      model.spec === 'eagle3' && model.draftModel !== undefined
        ? join(dir, model.draftModel.name)
        : undefined;

    const supervisor = new LlamaServerSupervisor({
      serverPath: install.serverPath,
      modelPath,
      launchMode: 'fast-text',
      contextSize: contextWindow,
      mtpSupported: features.mtp,
      mtpEmbedded: model.mtpEmbedded,
      mtpPath:
        mtpSiblingPath !== undefined && existsSync(mtpSiblingPath) ? mtpSiblingPath : undefined,
      specType: model.spec === 'eagle3' ? 'draft-eagle3' : 'draft-mtp',
      eagle3Supported: features.eagle3,
      draftPath: draftPath !== undefined && existsSync(draftPath) ? draftPath : undefined,
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
      return downloadOne(req.modelId, req.quant, req.hfToken);
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
    case 'hf-search':
      return hfSearch(req);
    case 'hf-list-files':
      return hfListFiles(req);
    case 'register-hf-model':
      return registerHfModel(req);
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

// Restore any previously-registered HF models so they stay in the local set
// across a supervisor restart, then announce initial idle state so the host has
// something to broadcast on attach.
loadHfModels();
emitStatus();
