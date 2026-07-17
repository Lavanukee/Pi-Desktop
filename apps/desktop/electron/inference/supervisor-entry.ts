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
  buildMlxProviderBlock,
  buildProviderBlock,
  CATALOG,
  type CatalogFile,
  type CatalogModel,
  chatTemplatePath,
  createMlxSupervisor,
  detectHardware,
  downloadModel,
  ensureChatTemplate,
  ensureLlamaCpp,
  ensureMlx,
  estimateRamGB,
  getCatalogFile,
  getCatalogModel,
  type HfGgufFile,
  type HfModelHit,
  type HfSort,
  hfModelToCatalogEntry,
  isMlxSupported,
  type LaunchMode,
  LlamaServerSupervisor,
  listHfGgufFiles,
  mmprojFileFor,
  modelDir,
  modelEngine,
  probeServerFeatures,
  recommend,
  resolveTierModels,
  searchHfModels,
  startParentDeathWatchdog,
  type TierPick,
  writeModelsJson,
} from '@pi-desktop/inference';
import type {
  HfGgufFileDTO,
  HfModelHitDTO,
  HfSortOption,
  LlmCatalogEntry,
  LlmHardware,
  LlmStatus,
  LlmTierPick,
} from '../ipc-contract';
import { DownloadCancellation, discardPartials, partialPaths } from './download-cancellation';
import { fastTextSlotLaunch } from './parallel-launch';
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
/** models.json provider key for MLX models (bound to provider-mlx's mlx-stream). */
const MLX_PROVIDER_NAME = 'mlx';

/** Renderer-owned settings file (read-only here) — the source of the HF token
 * used to fetch a model's gated base-repo chat template. */
const SETTINGS_JSON = join(homedir(), '.pi', 'desktop', 'settings.json');
/** Bound a chat-template fetch so a slow/hung HF request can never wedge a launch. */
const CHAT_TEMPLATE_FETCH_TIMEOUT_MS = 15_000;

/** Read the persisted HF token (base repos like `google/gemma-4-*` are gated).
 * Best-effort: returns undefined when the file is absent/corrupt/empty. */
function persistedHfToken(): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(SETTINGS_JSON, 'utf8'));
    const raw =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { hfToken?: unknown }).hfToken
        : undefined;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the `--jinja --chat-template-file <path>` args for a model with a
 * canonical `baseRepo` (Gemma-4). Fetches + caches the official template (see
 * `chat-template.ts`); on any failure falls back to a previously-cached template
 * (e.g. pulled at download time with the user's token) and, absent that, returns
 * `[]` so the launch is UNCHANGED. Bounded so it can never hang a server start.
 */
async function resolveChatTemplateArgs(
  model: CatalogModel,
  hfToken: string | undefined,
): Promise<string[]> {
  const baseRepo = model.baseRepo;
  if (baseRepo === undefined) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TEMPLATE_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await ensureChatTemplate(baseRepo, { hfToken, signal: controller.signal });
    return ['--jinja', '--chat-template-file', res.path];
  } catch {
    const cached = chatTemplatePath(baseRepo);
    if (existsSync(cached)) return ['--jinja', '--chat-template-file', cached];
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort chat-template prefetch during download, when the user's token is
 * in hand — so the launcher finds a warm cache (no network) at start. Never
 * throws; a failure just defers the fetch to launch time. */
async function prefetchChatTemplate(baseRepo: string, hfToken: string | undefined): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TEMPLATE_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    await ensureChatTemplate(baseRepo, { hfToken, signal: controller.signal });
  } catch {
    // best-effort — retried (with the persisted token) at start.
  } finally {
    clearTimeout(timer);
  }
}

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
  /** The launch mode this server came up in (fast-text speed, or multimodal
   * vision). Surfaced in LlmStatus so the app knows if vision is already on. */
  launchMode: LaunchMode;
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
    launchMode: current?.launchMode,
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
    variants: model.variants?.map((v) => ({
      method: v.method,
      draftRepo: v.draftRepo,
      embedded: v.embedded,
    })),
    vision: model.input.includes('image'),
    downloaded: model.files.some((f) => isDownloaded(model, f)),
    recommended: model.id === recommendedId,
    hfRepo: model.hfRepo,
    engine: modelEngine(model),
    publisher: model.publisher,
    tier: model.tier,
    sharded: model.sharded,
    gated: model.gated === true,
    source: hfModels.has(model.id) ? 'hf' : 'curated',
    verified: model.verified,
  };
}

/** Map a resolved {@link TierPick} → the renderer DTO, adding the downloaded flag. */
function tierPickDto(pick: TierPick): LlmTierPick {
  return {
    modelId: pick.model.id,
    displayName: pick.displayName,
    quant: pick.file.quant,
    launchMode: pick.launchMode,
    spec: pick.spec,
    vision: pick.vision,
    bytes: pick.bytes,
    downloaded: isDownloaded(pick.model, pick.file),
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
    const tiers = resolveTierModels(hw);
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
      tierModels: {
        fast: tierPickDto(tiers.fast),
        balanced: tierPickDto(tiers.balanced),
        intelligent: tierPickDto(tiers.intelligent),
      },
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
    // Opportunistically warm the chat-template cache while the user's HF token
    // is in hand (base repos are gated) so the launcher finds it without a
    // network round-trip. Best-effort — never fails the download.
    if (model.baseRepo !== undefined) await prefetchChatTemplate(model.baseRepo, hfToken);
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

/**
 * Start the MLX server (round-12 foundation): `mlx_lm.server` via uv, health-
 * probed on `/v1/models`, with an `mlx-stream` models.json block bound to
 * provider-mlx. Gated on Apple Silicon. `mlx_lm.server` auto-downloads the
 * `mlx-community/*` repo on first launch (the app-side multi-file downloader is
 * a deferred follow-up). TPS surfaces client-side via provider-mlx, not here.
 */
async function startMlxServer(
  model: CatalogModel,
  file: CatalogFile,
): Promise<{ success: boolean; baseUrl?: string; error?: string }> {
  if (!isMlxSupported()) {
    return { success: false, error: 'MLX models require Apple Silicon (darwin/arm64)' };
  }
  phase = 'starting';
  lastError = undefined;
  metrics = null;
  emitStatus();
  try {
    if (current !== null) {
      await current.supervisor.dispose();
      current = null;
    }
    const uv = await ensureMlx();
    const contextWindow = Math.min(model.contextWindow, CONTEXT_CAP);
    const supervisor = createMlxSupervisor({ uvPath: uv.uvPath, repo: model.hfRepo });
    supervisor.on((event) => {
      if (event.type === 'metrics') {
        metrics = { lastTps: event.metrics.lastTps, avgTps: event.metrics.avgTps };
        emitStatus();
      } else if (event.type === 'crash' || event.type === 'restart') {
        phase = 'starting';
        emitStatus();
      } else if (event.type === 'exit' && event.reason === 'failed') {
        phase = 'error';
        lastError = event.detail ?? 'mlx_lm.server failed';
        current = null;
        emitStatus();
      }
    });
    const started = await supervisor.start();
    const baseUrl = supervisor.baseUrl;
    current = { supervisor, model, file, contextWindow, baseUrl, launchMode: 'fast-text' };
    phase = 'ready';
    await writeModelsJson(
      MODELS_JSON,
      MLX_PROVIDER_NAME,
      buildMlxProviderBlock(model, { baseUrl, servedModelId: model.hfRepo }),
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

async function startServer(
  modelId: string,
  quant?: string,
  launchMode: LaunchMode = 'fast-text',
  parallel?: number,
): Promise<{ success: boolean; baseUrl?: string; error?: string }> {
  const model = getModel(modelId);
  if (model === undefined) return { success: false, error: `unknown model: ${modelId}` };
  const file = pickFile(model, quant);
  if (file === undefined) return { success: false, error: `unknown quant for ${modelId}` };

  // MLX engine → the mlx_lm.server path (its artifact is not a local GGUF).
  if (modelEngine(model) === 'mlx') return startMlxServer(model, file);

  const modelPath = modelPathFor(model, file);
  if (!existsSync(modelPath)) return { success: false, error: 'model not downloaded' };

  phase = 'starting';
  lastError = undefined;
  metrics = null;
  emitStatus();

  // On-demand vision (LAZY mmproj): the projector is resolved ONLY for a
  // multimodal launch, via the shared chokepoint {@link mmprojFileFor} — it
  // returns undefined for every fast-text launch, so the default (text) path
  // can never even name a projector to fetch or load. When vision IS requested
  // we fetch the sibling if missing (the main GGUF is already present, so that
  // part is a cached no-op). (mmproj ⊥ MTP is enforced in assembleServerArgs.)
  const mmprojFile = mmprojFileFor(model, launchMode);
  let mmprojPath: string | undefined;
  if (launchMode === 'multimodal') {
    if (mmprojFile === undefined) {
      phase = 'error';
      lastError = `${model.displayName} has no vision projector`;
      emitStatus();
      return { success: false, error: lastError };
    }
    mmprojPath = join(modelDir(model.id), mmprojFile.name);
    if (!existsSync(mmprojPath)) {
      phase = 'downloading';
      emitStatus();
      try {
        await downloadModel(model, {
          quant: file.quant,
          launchMode: 'multimodal',
          onProgress: (f, p) =>
            post({
              kind: 'download-progress',
              progress: {
                modelId: model.id,
                file: f,
                received: p.received,
                total: p.total ?? null,
                fraction: p.fraction ?? null,
              },
            }),
        });
      } catch (error) {
        phase = 'error';
        lastError = `failed to fetch vision projector: ${String(error instanceof Error ? error.message : error)}`;
        current = null;
        emitStatus();
        return { success: false, error: lastError };
      }
      phase = 'starting';
      emitStatus();
    }
  }

  try {
    if (current !== null) {
      await current.supervisor.dispose();
      current = null;
    }
    const install = await ensureLlamaCpp();
    const features = await probeServerFeatures(install.serverPath);
    // Per-slot context (the reported/gauge value): a single request/slot sees this.
    const contextWindow = Math.min(model.contextWindow, CONTEXT_CAP);
    // OOM-safe fan-out: for a K-slot fast-text launch the server `-c` must be
    // perSlot × K (llama.cpp splits `-c` across `--parallel` slots) so each slot
    // still gets the full `contextWindow`. K defaults to 1 (single slot, `-c` =
    // contextWindow — unchanged). Multimodal keeps its single-slot budget.
    const launch =
      launchMode === 'fast-text'
        ? fastTextSlotLaunch(contextWindow, parallel)
        : { parallel: 1, contextSize: contextWindow };

    // Resolve the speed-decode sibling for a FAST-TEXT launch (a multimodal
    // launch drops MTP/EAGLE — they are mutually exclusive with --mmproj):
    //   - Gemma4 MTP head (separate sibling in the same repo) → --model-draft.
    //   - EAGLE-3 draft (from draftRepo) → --spec-type draft-eagle3 --model-draft.
    // Both are downloaded alongside the main GGUF (see model-downloader).
    const dir = modelDir(model.id);
    const mtpSiblingPath =
      launchMode === 'fast-text' && model.mtpFile !== undefined && model.mtpEmbedded !== true
        ? join(dir, model.mtpFile.name)
        : undefined;
    const draftPath =
      launchMode === 'fast-text' && model.spec === 'eagle3' && model.draftModel !== undefined
        ? join(dir, model.draftModel.name)
        : undefined;

    // Force the model's OFFICIAL chat template (from its base repo) so llama.cpp
    // routes to the real chat/tool parser instead of the GGUF's stale embedded
    // template. Best-effort + bounded: no baseRepo (or no cached/fetchable
    // template) → `[]`, leaving the launch unchanged. Applies in both modes.
    const chatTemplateArgs = await resolveChatTemplateArgs(model, persistedHfToken());

    const supervisor = new LlamaServerSupervisor({
      serverPath: install.serverPath,
      modelPath,
      launchMode,
      contextSize: launch.contextSize,
      // `--parallel N`: N fast-text slots (default 1), or 1 for multimodal.
      parallel: launch.parallel,
      // Undefined for every fast-text launch (mmprojFileFor is the chokepoint),
      // set only when vision was explicitly requested — the lazy guarantee.
      mmprojPath,
      mtpSupported: features.mtp,
      mtpEmbedded: launchMode === 'fast-text' ? model.mtpEmbedded : undefined,
      mtpPath:
        mtpSiblingPath !== undefined && existsSync(mtpSiblingPath) ? mtpSiblingPath : undefined,
      specType: model.spec === 'eagle3' ? 'draft-eagle3' : 'draft-mtp',
      eagle3Supported: features.eagle3,
      draftPath: draftPath !== undefined && existsSync(draftPath) ? draftPath : undefined,
      extraArgs: chatTemplateArgs.length > 0 ? chatTemplateArgs : undefined,
      // Guarantee no orphaned llama-server: a detached watchdog SIGKILLs this
      // child if THIS utilityProcess dies via a hard crash / SIGKILL (where the
      // signal/exit reap handlers below can never run).
      watchdogFactory: (pid) => startParentDeathWatchdog({ targetPid: pid }),
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
    current = { supervisor, model, file, contextWindow, baseUrl, launchMode };
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
      return startServer(req.modelId, req.quant, req.launchMode, req.parallel);
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

/**
 * Reap the llama-server grandchild when THIS utilityProcess is torn down.
 *
 * The app-quit path SIGTERMs this utilityProcess (llm-main.ts shutdownInference).
 * Without these handlers, killing the utilityProcess never runs the supervisor's
 * kill ladder, so the spawned llama-server is orphaned and keeps holding the
 * model in RAM/VRAM after quit. On a caught signal we synchronously SIGKILL the
 * child (the async dispose ladder can't be trusted to finish before the parent
 * force-exits us), then leave; `process.on('exit')` is the final synchronous
 * backstop for any path that skips the signal handlers.
 */
let reaped = false;
function reapAndExit(): void {
  if (reaped) return;
  reaped = true;
  const c = current;
  current = null;
  try {
    c?.supervisor.killImmediately();
  } catch {
    // best-effort — a dead child is exactly the outcome we want
  }
  process.exit(0);
}
process.once('SIGTERM', reapAndExit);
process.once('SIGINT', reapAndExit);
process.on('exit', () => {
  try {
    current?.supervisor.killImmediately();
  } catch {
    // best-effort
  }
});

// Restore any previously-registered HF models so they stay in the local set
// across a supervisor restart, then announce initial idle state so the host has
// something to broadcast on attach.
loadHfModels();
emitStatus();
