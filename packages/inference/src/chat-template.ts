/**
 * Chat-template fetch + cache for a model's canonical base repo.
 *
 * Why this exists: llama.cpp (b9934) has a native Gemma-4 tool-call PEG parser,
 * but it only routes to it when the *chat template* it is handed matches the
 * official Gemma-4 format. The Unsloth GGUFs ship an "outdated gemma4" template
 * that llama.cpp downgrades to a generic/compatibility path — which is why
 * today's tool-calling is weak. Forcing the OFFICIAL template (from Google's
 * BASE repo) via `--jinja --chat-template-file <path>` routes to the real
 * parser. The base repos carry the canonical `chat_template.jinja`; they are
 * gated, so the fetch needs the plumbed HF token.
 *
 * This module is engine-agnostic and Electron-free: given a `baseRepo` it pulls
 * `resolve/main/chat_template.jinja` (falling back to the `chat_template` field
 * of `tokenizer_config.json`) and caches it to a stable path under the shared
 * download cache. A freshness policy re-pulls when the remote blob changed
 * (ETag) or the cache is older than ~24h (Google updates these). `fetchImpl`,
 * `now`, and `cacheDir` are injectable so it unit-tests against a mock fetch.
 *
 * Cache layout (per repo):
 *   ~/.cache/pi-desktop/chat-templates/<repo-slug>.jinja        ← the template
 *   ~/.cache/pi-desktop/chat-templates/<repo-slug>.meta.json    ← etag + fetchedAt
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hfResolveUrl } from './catalog.js';
import { cacheRoot } from './paths.js';

/** Re-pull a cached template if it is older than this (Google updates them). */
export const CHAT_TEMPLATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TEMPLATE_FILE = 'chat_template.jinja';
const TOKENIZER_CONFIG = 'tokenizer_config.json';

/** Directory holding cached chat templates (`~/.cache/pi-desktop/chat-templates`). */
export function chatTemplatesDir(): string {
  return join(cacheRoot(), 'chat-templates');
}

/** Filesystem-safe slug for a repo id (`google/gemma-4-E2B-it` → `google--gemma-4-E2B-it`). */
export function repoSlug(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]+/g, '--');
}

/** Stable cache path for a repo's chat template (default cache root). */
export function chatTemplatePath(repo: string, dir: string = chatTemplatesDir()): string {
  return join(dir, `${repoSlug(repo)}.jinja`);
}

function metaPath(repo: string, dir: string): string {
  return join(dir, `${repoSlug(repo)}.meta.json`);
}

/** Where the template body came from on the last fetch. `cache` = served from disk. */
export type ChatTemplateSource = 'jinja' | 'tokenizer_config' | 'cache';

interface TemplateMeta {
  readonly repo: string;
  readonly source: 'jinja' | 'tokenizer_config';
  readonly etag?: string;
  /** Epoch ms of the last successful (re)fetch. */
  readonly fetchedAt: number;
}

export interface ChatTemplateResult {
  /** Absolute path to the cached `.jinja` file to hand `--chat-template-file`. */
  readonly path: string;
  /** Provenance of the CURRENT on-disk body. */
  readonly source: ChatTemplateSource;
  /** True when served from cache without downloading the body this call. */
  readonly cached: boolean;
  /** True when the body was (re)downloaded this call. */
  readonly refreshed: boolean;
  /** Remote blob ETag recorded for the cached body, if known. */
  readonly etag?: string;
}

export interface EnsureChatTemplateOptions {
  /** HF auth token — base repos (e.g. `google/gemma-4-*`) are gated. */
  readonly hfToken?: string;
  /** Injectable fetch (tests / proxies). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Clock injection (tests). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Freshness window; older cache triggers an ETag re-check. Default 24h. */
  readonly maxAgeMs?: number;
  /** Cache directory override (tests). Defaults to {@link chatTemplatesDir}. */
  readonly cacheDir?: string;
  /** Bypass the freshness short-circuit and always re-check the remote. */
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

function authHeaders(hfToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': 'pi-desktop' };
  if (hfToken !== undefined && hfToken.length > 0) headers.authorization = `Bearer ${hfToken}`;
  return headers;
}

/** Normalise an ETag header: strip weak marker + quotes, lowercase. Undefined when absent. */
function normEtag(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const v = raw.replace(/^W\//i, '').replace(/"/g, '').trim().toLowerCase();
  return v.length > 0 ? v : undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readMeta(p: string): Promise<TemplateMeta | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(p, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const m = parsed as Record<string, unknown>;
    if (typeof m.fetchedAt !== 'number') return undefined;
    const source = m.source === 'tokenizer_config' ? 'tokenizer_config' : 'jinja';
    return {
      repo: typeof m.repo === 'string' ? m.repo : '',
      source,
      etag: typeof m.etag === 'string' ? m.etag : undefined,
      fetchedAt: m.fetchedAt,
    };
  } catch {
    return undefined;
  }
}

async function writeMeta(p: string, meta: TemplateMeta): Promise<void> {
  await writeFile(p, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/**
 * Pull the `chat_template` string out of a parsed `tokenizer_config.json`.
 * Handles both the plain-string form and the newer array-of-`{name,template}`
 * form (prefers a `default` entry, else the first with a string template).
 */
export function extractChatTemplate(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const ct = (config as Record<string, unknown>).chat_template;
  if (typeof ct === 'string' && ct.trim().length > 0) return ct;
  if (Array.isArray(ct)) {
    const named = ct.filter(
      (e): e is { name?: unknown; template: string } =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as Record<string, unknown>).template === 'string',
    );
    const preferred = named.find((e) => e.name === 'default') ?? named[0];
    if (preferred !== undefined && preferred.template.trim().length > 0) return preferred.template;
  }
  return undefined;
}

interface FetchedTemplate {
  readonly content: string;
  readonly source: 'jinja' | 'tokenizer_config';
  readonly etag?: string;
}

/** Fetch the template body: `chat_template.jinja` first, `tokenizer_config.json` fallback. */
async function fetchTemplate(
  repo: string,
  opts: EnsureChatTemplateOptions,
): Promise<FetchedTemplate> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = authHeaders(opts.hfToken);

  const jinjaRes = await doFetch(hfResolveUrl(repo, TEMPLATE_FILE), {
    headers,
    redirect: 'follow',
    signal: opts.signal,
  });
  if (jinjaRes.ok) {
    const content = await jinjaRes.text();
    if (content.trim().length > 0) {
      return { content, source: 'jinja', etag: normEtag(jinjaRes.headers.get('etag')) };
    }
  }

  // Fallback: the template embedded in tokenizer_config.json.
  const cfgRes = await doFetch(hfResolveUrl(repo, TOKENIZER_CONFIG), {
    headers,
    redirect: 'follow',
    signal: opts.signal,
  });
  if (!cfgRes.ok) {
    throw new Error(
      `chat template fetch failed for ${repo}: ` +
        `${TEMPLATE_FILE} HTTP ${jinjaRes.status}, ${TOKENIZER_CONFIG} HTTP ${cfgRes.status}`,
    );
  }
  const config: unknown = await cfgRes.json();
  const content = extractChatTemplate(config);
  if (content === undefined) {
    throw new Error(`no chat_template found in ${repo}/${TOKENIZER_CONFIG}`);
  }
  return { content, source: 'tokenizer_config', etag: normEtag(cfgRes.headers.get('etag')) };
}

/** HEAD the jinja file to read its current ETag (freshness check). */
async function headEtag(
  repo: string,
  opts: EnsureChatTemplateOptions,
): Promise<string | undefined> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(hfResolveUrl(repo, TEMPLATE_FILE), {
    method: 'HEAD',
    headers: authHeaders(opts.hfToken),
    redirect: 'manual',
    signal: opts.signal,
  });
  return normEtag(res.headers.get('etag'));
}

/**
 * Ensure a fresh, cached chat template for `repo`, returning the path to hand
 * `--chat-template-file`.
 *
 * Freshness policy:
 *   - Cached + younger than `maxAgeMs` → serve from disk (no network).
 *   - Cached + stale → HEAD the remote; if the ETag is unchanged, touch the
 *     timestamp and keep the file; otherwise re-download the body.
 *   - Not cached → download the body.
 *
 * Resilient: if a refresh fetch fails but a (stale) cached body exists, the
 * cached path is returned rather than throwing — a launch still gets a template.
 * Only a first-ever fetch failure (nothing cached) throws.
 */
export async function ensureChatTemplate(
  repo: string,
  opts: EnsureChatTemplateOptions = {},
): Promise<ChatTemplateResult> {
  const dir = opts.cacheDir ?? chatTemplatesDir();
  const now = opts.now ?? Date.now;
  const maxAge = opts.maxAgeMs ?? CHAT_TEMPLATE_MAX_AGE_MS;
  const tplPath = chatTemplatePath(repo, dir);
  const mPath = metaPath(repo, dir);

  const meta = await readMeta(mPath);
  const haveFile = await pathExists(tplPath);

  if (haveFile && meta !== undefined && opts.force !== true) {
    const age = now() - meta.fetchedAt;
    if (age < maxAge) {
      return { path: tplPath, source: 'cache', cached: true, refreshed: false, etag: meta.etag };
    }
    // Stale — compare the remote ETag before re-downloading a possibly-identical body.
    try {
      const remoteEtag = await headEtag(repo, opts);
      if (remoteEtag !== undefined && meta.etag !== undefined && remoteEtag === meta.etag) {
        await writeMeta(mPath, { ...meta, fetchedAt: now() });
        return { path: tplPath, source: 'cache', cached: true, refreshed: false, etag: meta.etag };
      }
    } catch {
      // HEAD failed (offline/gated hiccup) — fall through and try a full fetch,
      // which itself falls back to the cached body on failure below.
    }
  }

  try {
    const fetched = await fetchTemplate(repo, opts);
    await mkdir(dir, { recursive: true });
    await writeFile(tplPath, fetched.content, 'utf8');
    await writeMeta(mPath, {
      repo,
      source: fetched.source,
      etag: fetched.etag,
      fetchedAt: now(),
    });
    return {
      path: tplPath,
      source: fetched.source,
      cached: false,
      refreshed: true,
      etag: fetched.etag,
    };
  } catch (err) {
    // Refresh failed but we still have a usable (stale) cached body — use it.
    if (haveFile) {
      return {
        path: tplPath,
        source: 'cache',
        cached: true,
        refreshed: false,
        etag: meta?.etag,
      };
    }
    throw err;
  }
}
