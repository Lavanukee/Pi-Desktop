/**
 * @pi-desktop/web-tools — a pi extension providing three tools plus the
 * malformed-image-block context sanitizer:
 *
 *   - web_search  pluggable backends (DuckDuckGo floor, Brave/Tavily opt-in)
 *   - web_fetch   native fetch → readability → turndown markdown, size-capped
 *   - python_run  a script on a uv-provisioned isolated Python, bounded + sandboxed
 *
 * The default export is the zero-config activation function pi loads via `-e`.
 * `registerWebTools(pi, options)` is the configured entry point W3/W5 use to pass
 * API keys, a custom Python runtime, and the permission seam.
 *
 * Structural / electron-free: everything here is plain Node + pi's public API.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_MARKDOWN_CHARS,
  DEFAULT_TIMEOUT_MS,
  fetchReadable,
} from './fetch.js';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PYTHON_TIMEOUT_MS,
  type PythonRuntime,
  uvPythonRuntime,
} from './python.js';
import { installImageSanitizer } from './sanitizer.js';
import {
  boundCount,
  resolveSearchBackends,
  runWebSearch,
  type WebSearchConfig,
  webSearchConfigFromEnv,
} from './search.js';
import {
  formatBytes,
  runSpotlightSearch,
  type SpotlightHit,
  type SpotlightRunner,
  systemSpotlightRunner,
} from './spotlight.js';

export * from './download.js';
export * from './fetch.js';
export * from './paths.js';
export * from './python.js';
export * from './sanitizer.js';
export * from './search.js';
export * from './spotlight.js';
export * from './uv.js';

/** Stable tool names — also the identifiers W5 gates on via pi's `tool_call` event. */
export const WEB_SEARCH_TOOL = 'web_search';
export const WEB_FETCH_TOOL = 'web_fetch';
export const PYTHON_RUN_TOOL = 'python_run';
export const SPOTLIGHT_SEARCH_TOOL = 'spotlight_search';

/** Result of the python_run permission seam (see {@link WebToolsOptions.python}). */
export interface PythonGateDecision {
  readonly allow: boolean;
  readonly reason?: string;
}

export interface WebToolsOptions {
  /** web_search config; merged over {@link webSearchConfigFromEnv} (env supplies defaults). */
  readonly search?: WebSearchConfig;
  readonly fetch?: {
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly maxMarkdownChars?: number;
  };
  readonly python?: {
    /** Injected runtime; defaults to a uv-provisioned Python. */
    readonly runtime?: PythonRuntime;
    readonly defaultTimeoutMs?: number;
    readonly maxOutputBytes?: number;
    /**
     * PERMISSION SEAM (W5). Called before every python_run; returning
     * `{ allow: false, reason }` blocks execution with that reason. Defaults to
     * allow-all here — W6 exposes the seam and enforces no policy. W5 may hand a
     * policy here, and/or gate any of these tools by name via pi's `tool_call`
     * event (see {@link PYTHON_RUN_TOOL} / {@link WEB_FETCH_TOOL} / {@link WEB_SEARCH_TOOL}).
     */
    readonly canExecute?: (
      script: string,
      ctx: ExtensionContext,
    ) => PythonGateDecision | Promise<PythonGateDecision>;
  };
  readonly spotlight?: {
    /** Injected process runner; defaults to the real `mdfind`/`mdls`-backed runner. */
    readonly runner?: SpotlightRunner;
    /** Enrich the top hits with an `mdls` metadata call (default true). */
    readonly enrich?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    /** Default result limit when the caller omits one (clamped to [1, 50]). */
    readonly defaultLimit?: number;
    /** Platform override (test seam / force-enable); defaults to `process.platform`. */
    readonly platform?: NodeJS.Platform;
  };
}

function textResult<D>(text: string, details: D): AgentToolResult<D> {
  return { content: [{ type: 'text', text }], details };
}

interface WebSearchDetails {
  readonly backend: string;
  readonly count: number;
  readonly note?: string;
  /** Structured rows, so a UI can render them without re-parsing the text body. */
  readonly results: Array<{ title: string; url: string; snippet: string }>;
}

interface WebFetchDetails {
  readonly url?: string;
  readonly title?: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

interface PythonRunDetails {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly blocked?: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

interface SpotlightSearchDetails {
  readonly count: number;
  readonly truncated: boolean;
  readonly results: SpotlightHit[];
  readonly note?: string;
  readonly error?: string;
}

/** Register the three tools + the image-block context hook onto `pi`. */
export function registerWebTools(pi: ExtensionAPI, options: WebToolsOptions = {}): void {
  installImageSanitizer(pi);

  // --- web_search ----------------------------------------------------------
  const searchConfig: WebSearchConfig = { ...webSearchConfigFromEnv(), ...options.search };
  const backends = resolveSearchBackends(searchConfig);

  pi.registerTool({
    name: WEB_SEARCH_TOOL,
    label: 'Web Search',
    description:
      'Reliable access to real-time internet data: search the web and get a ranked list of ' +
      'results with title, URL, and snippet. Use web_fetch to read the full content of a result.',
    promptSnippet: 'Search the web for up-to-date information',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      count: Type.Optional(
        Type.Number({ description: 'Max results (default 8, max 20)', minimum: 1, maximum: 20 }),
      ),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<WebSearchDetails>> {
      const count = boundCount(params.count);
      const outcome = await runWebSearch(backends, params.query, { count, signal });
      const lines = outcome.results.map(
        (r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`,
      );
      const header =
        outcome.results.length > 0
          ? `${outcome.results.length} result(s) via ${outcome.backend}`
          : `No results (via ${outcome.backend}).`;
      const note = outcome.note !== undefined ? `\n(note: ${outcome.note})` : '';
      const text = `${header}${note}\n\n${lines.join('\n\n')}`.trim();
      return textResult(text, {
        backend: outcome.backend,
        count: outcome.results.length,
        note: outcome.note,
        results: outcome.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      });
    },
  });

  // --- web_fetch -----------------------------------------------------------
  const fetchOpts = options.fetch ?? {};
  pi.registerTool({
    name: WEB_FETCH_TOOL,
    label: 'Fetch URL',
    description:
      'Reliable access to real-time internet data: fetch a URL and return its main content as ' +
      'readable markdown (article extraction, scripts/styles stripped). Output is length-capped; ' +
      '`truncated` indicates capping.',
    promptSnippet: 'Read the content of a web page as markdown',
    parameters: Type.Object({
      url: Type.String({ description: 'URL to fetch' }),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<WebFetchDetails>> {
      try {
        const result = await fetchReadable(params.url, {
          fetchImpl: fetchOpts.fetchImpl,
          timeoutMs: fetchOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBytes: fetchOpts.maxBytes ?? DEFAULT_MAX_BYTES,
          maxMarkdownChars: fetchOpts.maxMarkdownChars ?? DEFAULT_MAX_MARKDOWN_CHARS,
          signal,
        });
        const head = [
          result.title ? `# ${result.title}` : undefined,
          `URL: ${result.url}`,
          result.truncated ? '(content truncated)' : undefined,
        ]
          .filter((l): l is string => l !== undefined)
          .join('\n');
        const text = `${head}\n\n${result.markdown}`.trim();
        return textResult(text, {
          url: result.url,
          title: result.title,
          truncated: result.truncated,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(`Fetch failed: ${message}`, { url: params.url, error: message });
      }
    },
  });

  // --- python_run ----------------------------------------------------------
  const runtime = options.python?.runtime ?? uvPythonRuntime();
  const canExecute = options.python?.canExecute;
  const pyTimeout = options.python?.defaultTimeoutMs ?? DEFAULT_PYTHON_TIMEOUT_MS;
  const pyMaxOutput = options.python?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  pi.registerTool({
    name: PYTHON_RUN_TOOL,
    label: 'Run Python',
    description:
      'Execute a Python script in an isolated, uv-provisioned interpreter inside a sandboxed ' +
      'temp directory. Returns stdout, stderr, and exit status. Bounded by a timeout and ' +
      'output size cap. The Python standard library is available; no third-party packages.',
    promptSnippet: 'Run a Python script for computation or data work',
    parameters: Type.Object({
      script: Type.String({ description: 'Python source to execute' }),
      timeout_ms: Type.Optional(
        Type.Number({ description: 'Max run time in ms (default 30000)', minimum: 1 }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<PythonRunDetails>> {
      if (canExecute !== undefined) {
        const decision = await canExecute(params.script, ctx);
        if (!decision.allow) {
          return textResult(`python_run blocked: ${decision.reason ?? 'not permitted'}`, {
            exitCode: null,
            signal: null,
            timedOut: false,
            aborted: false,
            blocked: true,
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 0,
          });
        }
      }

      try {
        const result = await runtime.run(params.script, {
          timeoutMs: params.timeout_ms ?? pyTimeout,
          maxOutputBytes: pyMaxOutput,
          signal,
        });
        const parts: string[] = [];
        if (result.timedOut) parts.push(`(timed out after ${result.durationMs}ms)`);
        else if (result.aborted) parts.push('(aborted)');
        parts.push(
          `exit: ${result.exitCode ?? `signal ${result.signal ?? 'unknown'}`}`,
          `--- stdout${result.stdoutTruncated ? ' (truncated)' : ''} ---`,
          result.stdout.length > 0 ? result.stdout : '(empty)',
          `--- stderr${result.stderrTruncated ? ' (truncated)' : ''} ---`,
          result.stderr.length > 0 ? result.stderr : '(empty)',
        );
        return textResult(parts.join('\n'), {
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          aborted: result.aborted,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          durationMs: result.durationMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(`python_run failed to start: ${message}`, {
          exitCode: null,
          signal: null,
          timedOut: false,
          aborted: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
        });
      }
    },
  });

  // --- spotlight_search (macOS only) ---------------------------------------
  const spotlightOpts = options.spotlight ?? {};
  const spotlightRunner = spotlightOpts.runner ?? systemSpotlightRunner();

  pi.registerTool({
    name: SPOTLIGHT_SEARCH_TOOL,
    label: 'Spotlight Search',
    description:
      'Search local files and their indexed content via macOS Spotlight (mdfind). ' +
      'Supports Spotlight query syntax. Optional `scope` restricts the search to a ' +
      'directory, `kind` filters by type (pdf, image, folder, app, text, audio, video, ' +
      'presentation), and `limit` caps results. Returns matching paths with basename and ' +
      'best-effort kind/size/modified metadata. macOS only.',
    promptSnippet: 'Search local files and content with macOS Spotlight',
    parameters: Type.Object({
      query: Type.String({
        description:
          'Search text. Supports Spotlight query syntax (a phrase, or a raw kMDItem predicate).',
      }),
      scope: Type.Optional(
        Type.String({ description: 'Restrict the search to this directory (mdfind -onlyin)' }),
      ),
      kind: Type.Optional(
        Type.String({
          description:
            'Convenience type filter: pdf, image, folder, app, text, audio, video, or presentation',
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: 'Max results (default 20, max 50)', minimum: 1, maximum: 50 }),
      ),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<SpotlightSearchDetails>> {
      const outcome = await runSpotlightSearch(
        spotlightRunner,
        {
          query: params.query,
          scope: params.scope,
          kind: params.kind,
          limit: params.limit ?? spotlightOpts.defaultLimit,
        },
        {
          signal,
          enrich: spotlightOpts.enrich,
          timeoutMs: spotlightOpts.timeoutMs,
          maxOutputBytes: spotlightOpts.maxOutputBytes,
          platform: spotlightOpts.platform,
        },
      );

      if (outcome.error !== undefined) {
        return textResult(outcome.error, {
          count: 0,
          truncated: false,
          results: [],
          error: outcome.error,
        });
      }

      const lines = outcome.hits.map((h, i) => {
        const meta = [
          h.kind,
          h.size !== undefined ? formatBytes(h.size) : undefined,
          h.modified,
        ].filter((m): m is string => m !== undefined && m.length > 0);
        const metaStr = meta.length > 0 ? ` (${meta.join(', ')})` : '';
        return `[${i + 1}] ${h.name}${metaStr}\n    ${h.path}`;
      });
      const header =
        outcome.hits.length > 0
          ? `${outcome.hits.length} result(s) via mdfind${outcome.truncated ? ' (more available)' : ''}`
          : 'No results via mdfind.';
      const note = outcome.note !== undefined ? `\n(note: ${outcome.note})` : '';
      const text = `${header}${note}\n\n${lines.join('\n')}`.trim();
      return textResult(text, {
        count: outcome.hits.length,
        truncated: outcome.truncated,
        results: outcome.hits,
        note: outcome.note,
      });
    },
  });
}

/** pi extension factory (zero-config; reads keys from env). */
export default function activate(pi: ExtensionAPI): void {
  registerWebTools(pi);
}
