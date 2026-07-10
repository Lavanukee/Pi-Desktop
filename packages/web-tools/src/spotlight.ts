/**
 * spotlight_search — macOS-only local file/content search via the `mdfind` CLI.
 *
 * Per the macOS-integrations research: shelling out to `mdfind` is the zero-native-code
 * way to reach Spotlight from Node today. This module keeps the process boundary
 * behind an injectable {@link SpotlightRunner} so the argument-building and
 * output-parsing logic unit-test without a real `mdfind`/`mdls` (the same
 * injectable-runner style as python_run's `PythonRuntime`).
 *
 * Design notes learned from real `mdfind` behaviour:
 *  - A `kind` convenience filter is composed by appending Spotlight's interpreted
 *    `kind:<token>` syntax to the query (e.g. `invoice kind:pdf`). This is robust
 *    for both free text and raw `kMDItem…` predicates; combining a bare term with
 *    `&&` fails to parse, so we deliberately avoid that.
 *  - `scope` maps to `mdfind -onlyin <dir>`.
 *  - On an unparseable query, `mdfind` prints `Failed to create query for '…'.`
 *    to *stdout* and still exits 0, so we detect that string rather than trusting
 *    the exit code.
 *  - Result enrichment (kind/size/modified) is a best-effort `mdls` call, bounded
 *    to the top N hits and swallowing any per-file failure.
 *
 * macOS 27 note: a richer, LLM-powered semantic `SpotlightSearchTool` (Core
 * Spotlight, used as a Tool inside a LanguageModelSession) exists for later; this
 * `mdfind`-backed tool is the works-everywhere-today floor.
 */
import { basename } from 'node:path';
import { spawnCapture } from './python.js';

/** Default number of results returned when the caller does not specify a limit. */
export const DEFAULT_SPOTLIGHT_LIMIT = 20;
/** Hard ceiling on returned results regardless of what the caller asks for. */
export const MAX_SPOTLIGHT_LIMIT = 50;
/** Wall-clock budget for the `mdfind` process. */
export const DEFAULT_SPOTLIGHT_TIMEOUT_MS = 10_000;
/** Cap on captured `mdfind` stdout (bounds memory; mdfind streams every match). */
export const DEFAULT_SPOTLIGHT_MAX_OUTPUT_BYTES = 512_000;
/** How many of the top hits get the extra `mdls` metadata call. */
export const DEFAULT_ENRICH_TOP_N = 20;
/** Per-file `mdls` budgets (fast, best-effort). */
export const ENRICH_TIMEOUT_MS = 4_000;
export const ENRICH_MAX_OUTPUT_BYTES = 32_000;

/**
 * Friendly `kind` values → Spotlight interpreted `kind:` tokens. Every token here
 * is verified against a live `mdfind`; `video` maps to `movie` because `kind:video`
 * matches nothing. Unknown kinds resolve to `undefined` (ignored, with a note).
 */
const KIND_ALIASES: Readonly<Record<string, string>> = {
  pdf: 'pdf',
  image: 'image',
  images: 'image',
  photo: 'image',
  picture: 'image',
  folder: 'folder',
  folders: 'folder',
  directory: 'folder',
  dir: 'folder',
  app: 'application',
  apps: 'application',
  application: 'application',
  applications: 'application',
  text: 'text',
  txt: 'text',
  audio: 'audio',
  music: 'audio',
  sound: 'audio',
  video: 'movie',
  movie: 'movie',
  movies: 'movie',
  presentation: 'presentation',
  presentations: 'presentation',
};

/** Map a friendly kind name to an `mdfind` `kind:` token, or `undefined` if unknown. */
export function mapKind(kind: string): string | undefined {
  return KIND_ALIASES[kind.trim().toLowerCase()];
}

/** Clamp a requested limit to [1, {@link MAX_SPOTLIGHT_LIMIT}], defaulting when unset. */
export function boundLimit(requested: number | undefined): number {
  const n = requested ?? DEFAULT_SPOTLIGHT_LIMIT;
  if (!Number.isFinite(n)) return DEFAULT_SPOTLIGHT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_SPOTLIGHT_LIMIT);
}

export interface BuildMdfindArgsInput {
  /** Search text; supports Spotlight query syntax. */
  readonly query: string;
  /** Optional directory to restrict the search to (`-onlyin`). */
  readonly scope?: string;
  /** Optional friendly kind filter (mapped to `kind:<token>`). */
  readonly kind?: string;
}

export interface BuiltMdfindArgs {
  readonly args: string[];
  /** True when a non-empty `kind` was supplied but did not map to a known token. */
  readonly kindUnknown: boolean;
}

/**
 * Build the `mdfind` argv from a query + optional scope + optional kind.
 * `scope` becomes `-onlyin <dir>`; `kind` is appended to the query as
 * `kind:<token>` (composes with both free text and raw predicates).
 */
export function buildMdfindArgs(input: BuildMdfindArgsInput): BuiltMdfindArgs {
  const args: string[] = [];
  const scope = input.scope?.trim();
  if (scope !== undefined && scope.length > 0) {
    args.push('-onlyin', scope);
  }
  const token = input.kind !== undefined ? mapKind(input.kind) : undefined;
  const kindUnknown =
    input.kind !== undefined && input.kind.trim().length > 0 && token === undefined;

  const parts: string[] = [];
  const q = input.query.trim();
  if (q.length > 0) parts.push(q);
  if (token !== undefined) parts.push(`kind:${token}`);
  args.push(parts.join(' '));
  return { args, kindUnknown };
}

/**
 * Parse `mdfind` stdout into a list of absolute paths. Blank lines and any stray
 * non-path diagnostic lines are skipped; parsing stops once `max` paths are found.
 */
export function parseMdfindPaths(stdout: string, max?: number): string[] {
  const out: string[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    // Every real mdfind hit is an absolute path; anything else is noise.
    if (!line.startsWith('/')) continue;
    out.push(line);
    if (max !== undefined && out.length >= max) break;
  }
  return out;
}

/**
 * Detect `mdfind`'s "Failed to create query" diagnostic, which it prints to
 * *stdout* (with exit 0) when the Spotlight query cannot be parsed.
 */
export function detectMdfindError(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('Failed to create query')) {
      return `mdfind could not parse the query: ${line.trim()}`;
    }
  }
  return undefined;
}

export interface MdlsAttributes {
  readonly kind?: string;
  readonly size?: number;
  /** Raw modification-date string as printed by `mdls`. */
  readonly modified?: string;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse the `kMDItemKind` / `kMDItemFSSize` / `kMDItemContentModificationDate`
 * lines from an `mdls` block. Unknown attributes, `(null)` values, and the
 * `<path>: could not find …` line for a vanished file are all ignored.
 */
export function parseMdlsAttributes(stdout: string): MdlsAttributes {
  let kind: string | undefined;
  let size: number | undefined;
  let modified: string | undefined;
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (match === null) continue;
    const key = match[1];
    const value = (match[2] ?? '').trim();
    if (value.length === 0 || value === '(null)') continue;
    if (key === 'kMDItemKind') kind = stripQuotes(value);
    else if (key === 'kMDItemFSSize') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) size = n;
    } else if (key === 'kMDItemContentModificationDate') {
      modified = value;
    }
  }
  const attrs: MdlsAttributes = {};
  return {
    ...attrs,
    ...(kind !== undefined ? { kind } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(modified !== undefined ? { modified } : {}),
  };
}

export interface SpotlightRunOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface SpotlightProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** True when stdout hit the byte cap (results may be partial). */
  readonly truncated: boolean;
}

/**
 * Injectable process seam so the tool runs without a real `mdfind`/`mdls` in unit
 * tests. The default {@link systemSpotlightRunner} wraps {@link spawnCapture}.
 */
export interface SpotlightRunner {
  run(
    command: string,
    args: readonly string[],
    opts: SpotlightRunOptions,
  ): Promise<SpotlightProcessResult>;
}

/** A {@link SpotlightRunner} backed by the real `mdfind`/`mdls` binaries. */
export function systemSpotlightRunner(): SpotlightRunner {
  return {
    async run(command, args, opts) {
      const r = await spawnCapture(command, args, {
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
        signal: opts.signal,
      });
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        truncated: r.stdoutTruncated,
      };
    },
  };
}

export interface SpotlightHit {
  readonly path: string;
  readonly name: string;
  readonly kind?: string;
  readonly size?: number;
  readonly modified?: string;
}

export interface SpotlightSearchParams {
  readonly query: string;
  readonly scope?: string;
  readonly kind?: string;
  readonly limit?: number;
}

export interface SpotlightSearchOutcome {
  readonly hits: SpotlightHit[];
  readonly count: number;
  /** True when more results existed than were returned (over-limit / size-cap / timeout). */
  readonly truncated: boolean;
  /** Non-fatal note (unknown kind ignored, partial results, …). */
  readonly note?: string;
  /** Set when the search could not run (macOS-only, bad query, spawn failure); `hits` is empty. */
  readonly error?: string;
}

export interface RunSpotlightOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Enrich the top hits with an `mdls` metadata call (default true). */
  readonly enrich?: boolean;
  readonly enrichTopN?: number;
  /** Platform override (test seam / force-enable); defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function enrichHits(
  runner: SpotlightRunner,
  hits: readonly SpotlightHit[],
  signal: AbortSignal | undefined,
): Promise<SpotlightHit[]> {
  return Promise.all(
    hits.map(async (hit) => {
      try {
        const r = await runner.run(
          'mdls',
          [
            '-name',
            'kMDItemKind',
            '-name',
            'kMDItemFSSize',
            '-name',
            'kMDItemContentModificationDate',
            hit.path,
          ],
          { timeoutMs: ENRICH_TIMEOUT_MS, maxOutputBytes: ENRICH_MAX_OUTPUT_BYTES, signal },
        );
        return { ...hit, ...parseMdlsAttributes(r.stdout) };
      } catch {
        return hit; // best-effort: a failed mdls just leaves the hit un-enriched
      }
    }),
  );
}

/**
 * Run a Spotlight search. Never throws — every failure mode (non-macOS, empty
 * query, unparseable query, spawn failure) is returned as an outcome with an
 * `error` string and empty `hits`.
 */
export async function runSpotlightSearch(
  runner: SpotlightRunner,
  params: SpotlightSearchParams,
  opts: RunSpotlightOptions = {},
): Promise<SpotlightSearchOutcome> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      hits: [],
      count: 0,
      truncated: false,
      error: `spotlight_search is macOS-only (it shells out to the mdfind CLI); current platform is "${platform}".`,
    };
  }

  const built = buildMdfindArgs({
    query: params.query,
    scope: params.scope,
    kind: params.kind,
  });
  // The query argument is the last element of args; if it is empty there is nothing to search.
  const queryArg = built.args[built.args.length - 1] ?? '';
  if (queryArg.trim().length === 0) {
    return {
      hits: [],
      count: 0,
      truncated: false,
      error: 'spotlight_search requires a non-empty query (or a recognized kind filter).',
    };
  }

  const notes: string[] = [];
  if (built.kindUnknown) {
    notes.push(`unrecognized kind "${params.kind}" was ignored`);
  }

  const limit = boundLimit(params.limit);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPOTLIGHT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_SPOTLIGHT_MAX_OUTPUT_BYTES;

  let result: SpotlightProcessResult;
  try {
    result = await runner.run('mdfind', built.args, {
      timeoutMs,
      maxOutputBytes,
      signal: opts.signal,
    });
  } catch (err) {
    return {
      hits: [],
      count: 0,
      truncated: false,
      error: `mdfind failed to start: ${errMessage(err)}`,
    };
  }

  const parseErr = detectMdfindError(result.stdout);
  if (parseErr !== undefined) {
    return { hits: [], count: 0, truncated: false, error: parseErr };
  }

  // Parse one extra path so we can tell whether more results existed than the limit.
  const parsed = parseMdfindPaths(result.stdout, limit + 1);
  const overLimit = parsed.length > limit;
  const paths = parsed.slice(0, limit);
  const truncated = overLimit || result.truncated || result.timedOut;

  if (result.timedOut) notes.push(`search timed out after ${timeoutMs}ms; results may be partial`);
  else if (result.truncated) notes.push('mdfind output was size-capped; results may be partial');
  else if (overLimit) notes.push(`more than ${limit} results matched; showing the first ${limit}`);

  let hits: SpotlightHit[] = paths.map((p) => ({ path: p, name: basename(p) }));

  const enrich = opts.enrich ?? true;
  if (enrich && hits.length > 0) {
    const topN = Math.min(opts.enrichTopN ?? DEFAULT_ENRICH_TOP_N, hits.length);
    const enriched = await enrichHits(runner, hits.slice(0, topN), opts.signal);
    hits = [...enriched, ...hits.slice(topN)];
  }

  return {
    hits,
    count: hits.length,
    truncated,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

/** Human-readable byte size for display in the tool's text output. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const unit = units[idx] ?? 'B';
  const rounded = idx === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0);
  return `${rounded} ${unit}`;
}
