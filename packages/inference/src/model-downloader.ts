/**
 * Download a catalog model's GGUF file(s) — plus its mmproj / MTP siblings when
 * a launch mode needs them — from HuggingFace `resolve/main` URLs, reusing the
 * resumable + sha256 + progress machinery in ./download.ts.
 *
 * Files land under `~/.cache/pi-desktop/models/<modelId>/`. Idempotent: already
 * present + verified files are skipped. Electron-free.
 */
import { join } from 'node:path';
import { type CatalogFile, type CatalogModel, hfResolveUrl, type LaunchMode } from './catalog.js';
import { type DownloadProgress, downloadFile } from './download.js';
import { modelDir } from './paths.js';

export interface ModelDownloadOptions {
  /** Which quant to fetch (defaults to the first file listed). */
  readonly quant?: string;
  /** Launch mode decides whether the mmproj / MTP sibling is fetched too. */
  readonly launchMode?: LaunchMode;
  /** Directory override (defaults to `~/.cache/pi-desktop/models/<id>`). */
  readonly dir?: string;
  /** Per-file progress; `file` names which sibling is downloading. */
  readonly onProgress?: (file: string, p: DownloadProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** HF auth header for gated repos (public repos need none). */
  readonly hfToken?: string;
}

export interface DownloadedModel {
  readonly model: CatalogModel;
  readonly dir: string;
  /** Absolute path to the main GGUF. */
  readonly modelPath: string;
  /** Absolute path to the mmproj sibling (multimodal only). */
  readonly mmprojPath?: string;
  /** Absolute path to the separate MTP head (Gemma-style fast-text only). */
  readonly mtpPath?: string;
}

function pickFile(model: CatalogModel, quant: string | undefined): CatalogFile {
  if (quant === undefined) {
    const first = model.files[0];
    if (first === undefined) throw new Error(`model ${model.id} has no files`);
    return first;
  }
  const file = model.files.find((f) => f.quant === quant);
  if (file === undefined) throw new Error(`quant ${quant} not found in ${model.id}`);
  return file;
}

async function fetchOne(
  repo: string,
  file: CatalogFile,
  dir: string,
  opts: ModelDownloadOptions,
): Promise<string> {
  const dest = join(dir, file.name);
  const headers: Record<string, string> = { 'user-agent': 'pi-desktop' };
  if (opts.hfToken !== undefined) headers.authorization = `Bearer ${opts.hfToken}`;
  await downloadFile({
    url: hfResolveUrl(repo, file.name),
    dest,
    expectedSha256: file.sha256,
    // 0 = unverified/unknown → no size assertion (see catalog note).
    expectedBytes: file.bytes > 0 ? file.bytes : undefined,
    onProgress: opts.onProgress !== undefined ? (p) => opts.onProgress?.(file.name, p) : undefined,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    headers,
  });
  return dest;
}

/**
 * Ensure a catalog model's files are downloaded for the given launch mode.
 *
 * - `multimodal` pulls the `mmproj` sibling (required for vision).
 * - `fast-text` pulls the separate `mtpFile` sibling when the model has one
 *   (Gemma4); Qwen3.6 embeds the MTP head so nothing extra is fetched.
 */
export async function downloadModel(
  model: CatalogModel,
  opts: ModelDownloadOptions = {},
): Promise<DownloadedModel> {
  const dir = opts.dir ?? modelDir(model.id);
  const mode = opts.launchMode ?? 'fast-text';

  const mainFile = pickFile(model, opts.quant);
  const modelPath = await fetchOne(model.hfRepo, mainFile, dir, opts);

  let mmprojPath: string | undefined;
  if (mode === 'multimodal' && model.mmproj !== undefined) {
    mmprojPath = await fetchOne(model.hfRepo, model.mmproj, dir, opts);
  }

  let mtpPath: string | undefined;
  if (mode === 'fast-text' && model.mtpFile !== undefined && model.mtpEmbedded !== true) {
    mtpPath = await fetchOne(model.hfRepo, model.mtpFile, dir, opts);
  }

  return { model, dir, modelPath, mmprojPath, mtpPath };
}
