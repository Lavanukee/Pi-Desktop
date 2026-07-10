/**
 * Hugging Face model-search backend for the model manager.
 *
 * Two live endpoints, fetch-based and electron-free (mirrors download.ts /
 * catalog.ts):
 *   1. `GET /api/models?search=&filter=&sort=&limit=&full=true` — text + tag
 *      search. HF ANDs repeated `filter=` params and free-text matches `search`.
 *   2. `GET /api/models/<repo>/tree/main?recursive=true` — the repo file tree,
 *      from which we pull the `.gguf` siblings with their sizes, sha256
 *      (git-lfs `oid`), quant label, and mmproj / MTP flags.
 *
 * We only surface GGUF repos by default because Pi runs GGUF via llama.cpp. An
 * HF hit + a chosen GGUF file adapt to the app's {@link CatalogModel} shape via
 * {@link hfModelToCatalogEntry}, so the EXISTING model-downloader (which already
 * pulls from HF `resolve/main` URLs) can fetch an arbitrary discovered repo with
 * no special-casing — the sha256 from the tree makes those downloads verified.
 *
 * `fetchImpl` is injectable everywhere (defaults to global fetch) so unit tests
 * drive fixtures without touching the network.
 *
 * HF API notes (verified live 2026-07-09):
 * - `gated` is `false | "auto" | "manual"`; normalised to a boolean here.
 * - The tree's `lfs.oid` IS the file's sha256 (equals the `x-linked-etag` a HEAD
 *   on `resolve/main/<file>` returns), and `lfs.size` / `size` is the real byte
 *   count — so no per-file HEAD is needed for size or checksum.
 * - Rate limit: ~500 requests / 300s fixed window (`ratelimit-policy` header).
 * - Files are xet-backed; `resolve/main` 302-redirects to a signed CDN URL that
 *   honours Range, which the existing streamed downloader already handles.
 */
import { type CatalogFile, type CatalogModel, hfResolveUrl } from './catalog.js';

const HF_API = 'https://huggingface.co/api/models';

/** Sort orders the HF models API accepts. */
export type HfSort = 'downloads' | 'likes' | 'lastModified' | 'trendingScore';

export interface HfSearchFilters {
  /** Extra `filter=` tag for a model family, e.g. "gemma4", "qwen3", "llama". */
  readonly family?: string;
  /** Extra `filter=` tag for a pipeline task, e.g. "text-generation". */
  readonly task?: string;
  /** Keep only gated (true) / ungated (false) repos — applied client-side. */
  readonly gated?: boolean;
  /** Drop hits below this like count — applied client-side. */
  readonly minLikes?: number;
}

export interface HfSearchOptions {
  readonly filters?: HfSearchFilters;
  readonly sort?: HfSort;
  /** Result cap (1…100, default 20). */
  readonly limit?: number;
  /** Add `filter=gguf` (default true — we run GGUF via llama.cpp). */
  readonly ggufOnly?: boolean;
  /** Injectable fetch (tests / proxies). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** HF auth token for gated / private repos (public search needs none). */
  readonly hfToken?: string;
  readonly signal?: AbortSignal;
}

export interface HfModelHit {
  /** Full repo id, e.g. "unsloth/gemma-4-E2B-it-GGUF". */
  readonly id: string;
  /** Owner, e.g. "unsloth". */
  readonly author: string;
  /** Repo name without the author, e.g. "gemma-4-E2B-it-GGUF". */
  readonly name: string;
  readonly downloads: number;
  readonly likes: number;
  readonly tags: readonly string[];
  /** True when the repo is gated ("auto"/"manual" on HF). */
  readonly gated: boolean;
  /** HF `pipeline_tag`, e.g. "text-generation", "image-text-to-text". */
  readonly pipelineTag?: string;
  /** ISO timestamp of the last repo change (HF `lastModified`). */
  readonly updatedAt?: string;
  /** Recent-popularity signal (HF `trendingScore`), when present. */
  readonly likesRecent?: number;
}

export interface HfGgufFile {
  /** Path within the repo, e.g. "gemma-4-E2B-it-Q4_K_M.gguf" or "MTP/mtp-…gguf". */
  readonly path: string;
  /** File size in bytes (git-lfs size), or undefined if the tree omitted it. */
  readonly sizeBytes?: number;
  /** Quant label parsed from the filename, e.g. "Q4_K_M", "UD-Q6_K_XL". */
  readonly quant?: string;
  /** Lowercase hex sha256 (git-lfs `oid`), when the entry is lfs-tracked. */
  readonly sha256?: string;
  /** True for a vision projector sibling (`mmproj-*.gguf`). */
  readonly mmproj?: boolean;
  /** True for a multi-token-prediction head sibling (`mtp-*.gguf` / `MTP/`). */
  readonly mtp?: boolean;
}

export interface HfTreeOptions {
  readonly fetchImpl?: typeof fetch;
  readonly hfToken?: string;
  readonly signal?: AbortSignal;
}

// --- Defensive JSON readers (no `any`; tolerate the API's loose shape) -------

function readString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function readNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function readStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
/** HF `gated` is `false | "auto" | "manual"` → boolean. */
function readGated(v: unknown): boolean {
  return v === true || (typeof v === 'string' && v.length > 0 && v !== 'false');
}
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function authHeaders(hfToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': 'pi-desktop',
    accept: 'application/json',
  };
  if (hfToken !== undefined && hfToken.length > 0) headers.authorization = `Bearer ${hfToken}`;
  return headers;
}

// --- Quant / sibling parsing --------------------------------------------------

// Matches GGUF quant tokens (with an optional Unsloth-Dynamic `UD-` prefix):
// Q4_K_M, Q8_0, Q6_K, IQ4_XS, IQ2_M, UD-Q6_K_XL, BF16, F16, F32, MXFP4_MOE, TQ1_0…
const QUANT_RE =
  /(?:UD-)?(?:IQ\d+(?:_[A-Za-z0-9]+)*|Q\d+(?:_[A-Za-z0-9]+)*|BF16|F32|F16|MXFP4(?:_[A-Za-z0-9]+)*|TQ\d+_\d+)/gi;

const MMPROJ_RE = /mmproj/i;
// "mtp-foo.gguf", ".../mtp-foo.gguf", "MTP/foo.gguf" — a real MTP head/dir.
const MTP_RE = /(?:^|[/\\])mtp[-_./]|(?:^|[/\\])mtp[/\\]/i;

/** Parse the quant label from a gguf filename; undefined when none is found. */
export function parseQuant(path: string): string | undefined {
  const base = (path.split('/').pop() ?? path)
    .replace(/\.gguf$/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, ''); // drop shard suffix
  const matches = base.match(QUANT_RE);
  const last = matches?.at(-1);
  return last === undefined ? undefined : last.toUpperCase();
}

// --- Search -------------------------------------------------------------------

/** Compose the `/api/models` search URL (exported for testing param assembly). */
export function buildSearchUrl(query: string, opts: HfSearchOptions = {}): string {
  const url = new URL(HF_API);
  const p = url.searchParams;
  if (query.length > 0) p.set('search', query);

  // Repeated `filter=` params are ANDed by HF.
  const filters: string[] = [];
  if (opts.ggufOnly ?? true) filters.push('gguf');
  const family = opts.filters?.family;
  if (family !== undefined && family.length > 0) filters.push(family);
  const task = opts.filters?.task;
  if (task !== undefined && task.length > 0) filters.push(task);
  for (const f of filters) p.append('filter', f);

  p.set('sort', opts.sort ?? 'downloads');
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
  p.set('limit', String(limit));
  p.set('full', 'true');
  return url.toString();
}

function parseHit(raw: unknown): HfModelHit | undefined {
  const r = asRecord(raw);
  const id = readString(r.id) ?? readString(r.modelId);
  if (id === undefined) return undefined;
  const slash = id.indexOf('/');
  const author = readString(r.author) ?? (slash > 0 ? id.slice(0, slash) : id);
  const name = slash > 0 ? id.slice(slash + 1) : id;
  return {
    id,
    author,
    name,
    downloads: readNumber(r.downloads) ?? 0,
    likes: readNumber(r.likes) ?? 0,
    tags: readStringArray(r.tags),
    gated: readGated(r.gated),
    pipelineTag: readString(r.pipeline_tag),
    updatedAt: readString(r.lastModified),
    likesRecent: readNumber(r.trendingScore),
  };
}

/**
 * Search Hugging Face for (GGUF) models. Composes the `search` + repeated
 * `filter` + `sort` + `limit` query, then applies client-side `gated` / `minLikes`
 * refinement the API does not express. Tolerant of the API's loose JSON shape.
 */
export async function searchHfModels(
  query: string,
  opts: HfSearchOptions = {},
): Promise<HfModelHit[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(buildSearchUrl(query, opts), {
    headers: authHeaders(opts.hfToken),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`HF search failed: HTTP ${res.status} ${res.statusText}`);
  }
  const body: unknown = await res.json();
  const rows = Array.isArray(body) ? body : [];

  let hits = rows.map(parseHit).filter((h): h is HfModelHit => h !== undefined);

  const wantGated = opts.filters?.gated;
  if (wantGated !== undefined) hits = hits.filter((h) => h.gated === wantGated);
  const minLikes = opts.filters?.minLikes;
  if (minLikes !== undefined) hits = hits.filter((h) => h.likes >= minLikes);

  return hits;
}

// --- Tree listing -------------------------------------------------------------

/** `<url>; rel="next"` cursor from a paginated tree response's Link header. */
function parseNextLink(link: string | null): string | undefined {
  if (link === null) return undefined;
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
  return m?.[1];
}

function parseTreeEntry(raw: unknown): HfGgufFile | undefined {
  const r = asRecord(raw);
  if (readString(r.type) !== 'file') return undefined;
  const path = readString(r.path);
  if (path === undefined || !/\.gguf$/i.test(path)) return undefined;

  const lfs = asRecord(r.lfs);
  const sizeBytes = readNumber(lfs.size) ?? readNumber(r.size);
  const oid = readString(lfs.oid);
  const sha256 = oid !== undefined && /^[0-9a-f]{64}$/.test(oid) ? oid : undefined;

  const entry: HfGgufFile = {
    path,
    sizeBytes,
    quant: parseQuant(path),
    sha256,
    mmproj: MMPROJ_RE.test(path),
    mtp: MTP_RE.test(path),
  };
  return entry;
}

/**
 * List a repo's `.gguf` files (including any `mmproj-*` / `mtp-*` siblings, each
 * flagged) via the tree API, with sizes, sha256, and parsed quant labels. Follows
 * the tree's `Link: rel="next"` pagination (capped) for large repos.
 */
export async function listHfGgufFiles(
  repoId: string,
  opts: HfTreeOptions = {},
): Promise<HfGgufFile[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  let next: string | undefined = `${HF_API}/${repoId}/tree/main?recursive=true`;
  const files: HfGgufFile[] = [];

  for (let page = 0; next !== undefined && page < 20; page++) {
    const res = await doFetch(next, { headers: authHeaders(opts.hfToken), signal: opts.signal });
    if (!res.ok) {
      throw new Error(`HF tree failed for ${repoId}: HTTP ${res.status} ${res.statusText}`);
    }
    const body: unknown = await res.json();
    if (Array.isArray(body)) {
      for (const row of body) {
        const entry = parseTreeEntry(row);
        if (entry !== undefined) files.push(entry);
      }
    }
    next = parseNextLink(res.headers.get('link'));
  }
  return files;
}

/**
 * HEAD `resolve/main/<path>` to read the CDN-linked size + sha256 (the
 * `x-linked-size` / `x-linked-etag` headers HF returns on the 302). Useful when
 * the tree omitted a size, and to prove a discovered repo's file resolves before
 * a real (multi-GB) download. `redirect: 'manual'` keeps the 302 so its headers
 * are readable instead of following through to the signed CDN URL.
 */
export async function hfHeadFile(
  repoId: string,
  path: string,
  opts: HfTreeOptions = {},
): Promise<{ sizeBytes?: number; sha256?: string; ok: boolean; status: number }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(hfResolveUrl(repoId, path), {
    method: 'HEAD',
    headers: authHeaders(opts.hfToken),
    redirect: 'manual',
    signal: opts.signal,
  });
  const size = Number(res.headers.get('x-linked-size') ?? '');
  const etag = (res.headers.get('x-linked-etag') ?? '').replace(/"/g, '').toLowerCase();
  return {
    sizeBytes: Number.isFinite(size) && size > 0 ? size : undefined,
    sha256: /^[0-9a-f]{64}$/.test(etag) ? etag : undefined,
    // A 200/206 (followed) or a 302 (manual) both mean the file resolves.
    ok: res.ok || res.status === 302 || res.type === 'opaqueredirect',
    status: res.status,
  };
}

// --- RAM estimate + catalog adaptation ---------------------------------------

/**
 * Rough "fits comfortably" RAM estimate (GiB) for a GGUF: weights (the file
 * size) + a KV-cache/compute allowance that scales with the model size and the
 * context window, + fixed OS/runtime headroom. A heuristic, not a guarantee —
 * calibrated so the headline catalog models land near their hand-set minRamGB
 * (e.g. the 17.1GB Qwen3.6-27B Q4 at 64k ≈ 24GB).
 */
export function estimateRamGB(sizeBytes: number, contextWindow = 8192): number {
  const weightsGB = sizeBytes / 1024 ** 3;
  const ctx = contextWindow > 0 ? contextWindow : 8192;
  const kvGB = weightsGB * (ctx / 32768) * 0.2; // KV + compute buffers
  const overheadGB = 1; // OS + runtime headroom
  return Math.max(1, Math.ceil(weightsGB + kvGB + overheadGB));
}

/** Extract the license id from HF `license:<id>` tags, if present. */
function licenseFromTags(tags: readonly string[]): string {
  const tag = tags.find((t) => t.startsWith('license:'));
  return tag !== undefined ? tag.slice('license:'.length) : 'unknown';
}

function slugId(id: string, quant: string | undefined): string {
  const base = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const q = quant?.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return q !== undefined && q.length > 0 ? `${base}-${q}` : base;
}

export interface HfCatalogAdaptOptions {
  /** Context window to record + size RAM against (HF does not expose it; default 8192). */
  readonly contextWindow?: number;
  /** Vision projector sibling to attach for a multimodal launch. */
  readonly mmproj?: HfGgufFile;
  /** Separate MTP head sibling to attach (Gemma-style; undefined when embedded). */
  readonly mtpFile?: HfGgufFile;
}

function toCatalogFile(f: HfGgufFile): CatalogFile {
  return {
    name: f.path,
    bytes: f.sizeBytes ?? 0,
    quant: f.quant ?? 'unknown',
    sha256: f.sha256,
  };
}

/**
 * Adapt an HF hit + a chosen GGUF file into the app's {@link CatalogModel} so the
 * EXISTING model-downloader can fetch it. The downloader builds
 * `hfResolveUrl(hfRepo, file.name)` and enforces sha256 when present + size when
 * `bytes > 0` — both of which the tree gives us — so a discovered repo downloads
 * exactly like a hand-curated catalog entry (just `verified: false`, since we
 * did not HEAD-verify the sha ourselves).
 */
export function hfModelToCatalogEntry(
  hit: HfModelHit,
  file: HfGgufFile,
  opts: HfCatalogAdaptOptions = {},
): CatalogModel {
  const contextWindow = opts.contextWindow ?? 8192;
  const input: ('text' | 'image')[] = hit.pipelineTag?.includes('image')
    ? ['text', 'image']
    : ['text'];
  return {
    id: slugId(hit.id, file.quant),
    displayName: file.quant !== undefined ? `${hit.name} · ${file.quant}` : hit.name,
    hfRepo: hit.id,
    files: [toCatalogFile(file)],
    mmproj: opts.mmproj !== undefined ? toCatalogFile(opts.mmproj) : undefined,
    mtpFile: opts.mtpFile !== undefined ? toCatalogFile(opts.mtpFile) : undefined,
    license: licenseFromTags(hit.tags),
    minRamGB: estimateRamGB(file.sizeBytes ?? 0, contextWindow),
    contextWindow,
    input,
    gated: hit.gated,
    verified: false,
  };
}
