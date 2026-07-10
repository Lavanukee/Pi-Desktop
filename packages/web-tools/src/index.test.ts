import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  PYTHON_RUN_TOOL,
  type PythonRunResult,
  type PythonRuntime,
  registerWebTools,
  SPOTLIGHT_SEARCH_TOOL,
  type SpotlightProcessResult,
  type SpotlightRunner,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from './index.js';

const ddgHtml = readFileSync(new URL('./fixtures/duckduckgo.html', import.meta.url), 'utf8');
const articleHtml = readFileSync(new URL('./fixtures/article.html', import.meta.url), 'utf8');

interface ToolResultShape {
  content: Array<{ type: string; text?: string }>;
  details: Record<string, unknown>;
}
interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResultShape>;
}
type ContextHandler = (event: { messages: unknown[] }) => unknown;

function createFakePi(): {
  pi: ExtensionAPI;
  tools: Map<string, CapturedTool>;
  contextHandlers: ContextHandler[];
} {
  const tools = new Map<string, CapturedTool>();
  const contextHandlers: ContextHandler[] = [];
  const pi = {
    registerTool(def: unknown) {
      const t = def as CapturedTool;
      tools.set(t.name, t);
    },
    on(event: string, handler: unknown) {
      if (event === 'context') contextHandlers.push(handler as ContextHandler);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, contextHandlers };
}

function makeRuntime(result: Partial<PythonRunResult>, onRun?: () => void): PythonRuntime {
  return {
    async run(): Promise<PythonRunResult> {
      onRun?.();
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
        ...result,
      };
    },
  };
}

function getTool(tools: Map<string, CapturedTool>, name: string): CapturedTool {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
}

function makeSpotlightRunner(byCommand: Record<string, string>): SpotlightRunner {
  return {
    async run(command): Promise<SpotlightProcessResult> {
      return {
        stdout: byCommand[command] ?? '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
    },
  };
}

const emptyCtx = {} as unknown as never;

describe('registerWebTools wiring', () => {
  it('registers all four tools and the image-sanitizer context hook', () => {
    const { pi, tools, contextHandlers } = createFakePi();
    registerWebTools(pi, { python: { runtime: makeRuntime({}) } });
    expect([...tools.keys()].sort()).toEqual(
      [WEB_FETCH_TOOL, PYTHON_RUN_TOOL, WEB_SEARCH_TOOL, SPOTLIGHT_SEARCH_TOOL].sort(),
    );
    expect(contextHandlers).toHaveLength(1);
  });

  it('web_search returns formatted results with backend details', async () => {
    const { pi, tools } = createFakePi();
    registerWebTools(pi, {
      search: { backend: 'duckduckgo', fetchImpl: async () => new Response(ddgHtml) },
      python: { runtime: makeRuntime({}) },
    });
    const res = await getTool(tools, WEB_SEARCH_TOOL).execute('t1', { query: 'example' });
    expect(res.content[0]?.text).toContain('Example Domain');
    expect(res.content[0]?.text).toContain('via duckduckgo');
    expect(res.details).toMatchObject({ backend: 'duckduckgo', count: 3 });
  });

  it('web_fetch returns markdown with title/url details', async () => {
    const { pi, tools } = createFakePi();
    registerWebTools(pi, {
      fetch: { fetchImpl: async () => new Response(articleHtml) },
      python: { runtime: makeRuntime({}) },
    });
    const res = await getTool(tools, WEB_FETCH_TOOL).execute('t2', {
      url: 'https://birds.example',
    });
    expect(res.content[0]?.text).toContain('Peregrine Falcon');
    expect(res.details.title).toContain('Peregrine Falcon');
  });

  it('web_fetch surfaces a clean error message on failure', async () => {
    const { pi, tools } = createFakePi();
    registerWebTools(pi, {
      fetch: { fetchImpl: async () => new Response('x', { status: 404, statusText: 'Not Found' }) },
      python: { runtime: makeRuntime({}) },
    });
    const res = await getTool(tools, WEB_FETCH_TOOL).execute('t3', {
      url: 'https://missing.example',
    });
    expect(res.content[0]?.text).toContain('Fetch failed');
    expect(res.details.error).toContain('404');
  });

  it('python_run formats stdout/exit from the injected runtime', async () => {
    const { pi, tools } = createFakePi();
    registerWebTools(pi, {
      python: { runtime: makeRuntime({ stdout: '4\n', exitCode: 0 }) },
    });
    const res = await getTool(tools, PYTHON_RUN_TOOL).execute('t4', { script: 'print(2+2)' });
    expect(res.content[0]?.text).toContain('exit: 0');
    expect(res.content[0]?.text).toContain('4');
    expect(res.details).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('python_run reports timeouts', async () => {
    const { pi, tools } = createFakePi();
    registerWebTools(pi, {
      python: { runtime: makeRuntime({ timedOut: true, exitCode: null, signal: 'SIGKILL' }) },
    });
    const res = await getTool(tools, PYTHON_RUN_TOOL).execute('t5', { script: 'while True: pass' });
    expect(res.content[0]?.text).toContain('timed out');
    expect(res.details).toMatchObject({ timedOut: true });
  });

  it('python_run permission seam blocks execution without invoking the runtime', async () => {
    const { pi, tools } = createFakePi();
    let ran = false;
    registerWebTools(pi, {
      python: {
        runtime: makeRuntime({}, () => {
          ran = true;
        }),
        canExecute: () => ({ allow: false, reason: 'not permitted in this mode' }),
      },
    });
    const res = await getTool(tools, PYTHON_RUN_TOOL).execute(
      't6',
      { script: "import os; os.system('rm -rf /')" },
      undefined,
      undefined,
      emptyCtx,
    );
    expect(res.content[0]?.text).toContain('blocked');
    expect(res.details).toMatchObject({ blocked: true });
    expect(ran).toBe(false);
  });

  it('spotlight_search formats hits + enrichment from the injected runner', async () => {
    const { pi, tools } = createFakePi();
    registerWebTools(pi, {
      python: { runtime: makeRuntime({}) },
      spotlight: {
        platform: 'darwin',
        runner: makeSpotlightRunner({
          mdfind: '/Applications/Safari.app\n',
          mdls: 'kMDItemFSSize = 36327161\nkMDItemKind = "Application"\n',
        }),
      },
    });
    const res = await getTool(tools, SPOTLIGHT_SEARCH_TOOL).execute('s1', { query: 'safari' });
    expect(res.content[0]?.text).toContain('Safari.app');
    expect(res.content[0]?.text).toContain('Application');
    expect(res.details).toMatchObject({ count: 1, truncated: false });
    expect((res.details.results as unknown[]).length).toBe(1);
  });

  it('spotlight_search returns the macOS-only message off-darwin', async () => {
    const { pi, tools } = createFakePi();
    registerWebTools(pi, {
      python: { runtime: makeRuntime({}) },
      spotlight: { platform: 'linux', runner: makeSpotlightRunner({}) },
    });
    const res = await getTool(tools, SPOTLIGHT_SEARCH_TOOL).execute('s2', { query: 'safari' });
    expect(res.content[0]?.text).toContain('macOS-only');
    expect(res.details).toMatchObject({ count: 0, error: expect.stringContaining('macOS-only') });
  });
});
