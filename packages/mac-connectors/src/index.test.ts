import { readFileSync } from 'node:fs';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  CALENDAR_LIST_EVENTS_TOOL,
  CONTACTS_SEARCH_TOOL,
  MAC_CONNECTOR_TOOLS,
  type MacConnectorsOptions,
  MESSAGES_RECENT_TOOL,
  registerMacConnectors,
} from './index.js';
import type { SqliteProcessResult, SqliteRunner } from './messages.js';
import type { OsascriptProcessResult, OsascriptRunner } from './osascript.js';

const calendarOut = readFileSync(
  new URL('./fixtures/calendar-events.txt', import.meta.url),
  'utf8',
);
const messagesJson = readFileSync(new URL('./fixtures/messages.json', import.meta.url), 'utf8');

// biome-ignore lint/suspicious/noExplicitAny: tool params/details vary per tool in this registry map.
type AnyTool = ToolDefinition<any, any, any>;

function collectPi(options: MacConnectorsOptions): Map<string, AnyTool> {
  const tools = new Map<string, AnyTool>();
  const pi = {
    registerTool(def: AnyTool): void {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  registerMacConnectors(pi, options);
  return tools;
}

function osaReturning(over: Partial<OsascriptProcessResult>): OsascriptRunner {
  return {
    async run() {
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
    },
  };
}
function sqliteReturning(over: Partial<SqliteProcessResult>): SqliteRunner {
  return {
    async query() {
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
    },
  };
}

const ctx = {} as unknown as ExtensionContext;
function run(tool: AnyTool, params: unknown): Promise<AgentToolResult<unknown>> {
  return tool.execute('call-1', params, undefined, undefined, ctx);
}

describe('registerMacConnectors', () => {
  it('registers all ten connector tools by name', () => {
    const tools = collectPi({ platform: 'darwin' });
    expect(tools.size).toBe(MAC_CONNECTOR_TOOLS.length);
    for (const name of MAC_CONNECTOR_TOOLS) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it('calendar_list_events returns structured events + a readable summary', async () => {
    const tools = collectPi({
      platform: 'darwin',
      osascript: osaReturning({ stdout: calendarOut }),
    });
    const tool = tools.get(CALENDAR_LIST_EVENTS_TOOL);
    expect(tool).toBeDefined();
    // A named calendar takes the single-query fast path (one runner call).
    const result = await run(tool as AnyTool, { calendar: 'Work' });
    const details = result.details as { count: number };
    expect(details.count).toBe(2);
    const text = result.content[0];
    expect(text?.type).toBe('text');
    expect(text?.type === 'text' && text.text).toContain('Team Standup');
  });

  it('degrades every tool off-platform (macOS-only), never throwing', async () => {
    const tools = collectPi({ platform: 'linux' });
    const tool = tools.get(CALENDAR_LIST_EVENTS_TOOL);
    const result = await run(tool as AnyTool, {});
    const first = result.content[0];
    expect(first?.type === 'text' && first.text).toContain('macOS-only');
  });

  it('contacts_search reports an empty-query error as a normal result', async () => {
    const tools = collectPi({ platform: 'darwin' });
    const tool = tools.get(CONTACTS_SEARCH_TOOL);
    const result = await run(tool as AnyTool, { query: '' });
    const first = result.content[0];
    expect(first?.type === 'text' && first.text).toContain('non-empty query');
  });

  it('messages_recent surfaces the Full Disk Access gate in text + details', async () => {
    const tools = collectPi({
      platform: 'darwin',
      sqlite: sqliteReturning({ exitCode: 1, stderr: 'unable to open database file' }),
    });
    const tool = tools.get(MESSAGES_RECENT_TOOL);
    const result = await run(tool as AnyTool, {});
    const details = result.details as { needsFullDiskAccess: boolean };
    expect(details.needsFullDiskAccess).toBe(true);
    const first = result.content[0];
    expect(first?.type === 'text' && first.text).toContain('Full Disk Access');
  });

  it('messages_recent parses a successful chat.db read', async () => {
    const tools = collectPi({
      platform: 'darwin',
      sqlite: sqliteReturning({ stdout: messagesJson }),
    });
    const tool = tools.get(MESSAGES_RECENT_TOOL);
    const result = await run(tool as AnyTool, { limit: 10 });
    const details = result.details as { count: number };
    expect(details.count).toBe(4);
  });
});
