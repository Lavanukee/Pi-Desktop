/**
 * Shared test helpers: a minimal fake ExtensionAPI that captures registerTool /
 * registerCommand / on, plus a mock-server path resolver. Not a `.test.ts` file
 * so vitest does not treat it as a suite.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';

export const MOCK_MCP_SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tools',
  'mock-mcp-server',
  'mock-mcp-server.mjs',
);

// biome-ignore lint/suspicious/noExplicitAny: registered tools are heterogeneous.
type AnyTool = ToolDefinition<any, any, any>;

export interface FakePi {
  api: ExtensionAPI;
  tools: Map<string, AnyTool>;
  commands: Map<string, Omit<RegisteredCommand, 'name' | 'sourceInfo'>>;
  shutdownHandlers: Array<() => void>;
  /** Run a registered tool's execute with a stub context. */
  run(name: string, params: unknown): Promise<{ content: unknown[]; details: unknown }>;
}

export function createFakePi(): FakePi {
  const tools = new Map<string, AnyTool>();
  const commands = new Map<string, Omit<RegisteredCommand, 'name' | 'sourceInfo'>>();
  const shutdownHandlers: Array<() => void> = [];

  const api = {
    registerTool: (tool: AnyTool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
      commands.set(name, options);
    },
    on: (event: string, handler: (...args: never[]) => void) => {
      if (event === 'session_shutdown') shutdownHandlers.push(handler as () => void);
    },
  } as unknown as ExtensionAPI;

  const run = async (name: string, params: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool "${name}"`);
    const ctx = {} as unknown as ExtensionContext;
    return tool.execute(`call-${name}`, params, undefined, undefined, ctx);
  };

  return { api, tools, commands, shutdownHandlers, run };
}
