/**
 * bash-CLI mode: the pure argv parser + help renderer + shim generators, then a
 * live socket round-trip against the REAL mock MCP server through a
 * ConnectorHost — proving `pi-tool list`/`--help`/call all route correctly and
 * that the shim install + PATH injection + dispose lifecycle is clean.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDispatcherSource,
  buildPiToolWrapper,
  coerceArgs,
  dispatchCommand,
  PI_MCP_CLI_SOCK_ENV,
  PI_MCP_CLI_TOKEN_ENV,
  parseDispatcherArgs,
  registerBashCliTools,
  renderHelp,
} from './bash-cli';
import { ConnectorHost } from './connector-host';
import type { McpServerConfig } from './registry';
import { createFakePi, MOCK_MCP_SERVER } from './test-helpers';

function serverConfig(id: string): McpServerConfig {
  return { id, name: `Mock ${id}`, command: process.execPath, args: [MOCK_MCP_SERVER] };
}

const hosts: ConnectorHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.disposeAll();
});
function newHost(): ConnectorHost {
  const h = new ConnectorHost({ connectTimeoutMs: 5000 });
  hosts.push(h);
  return h;
}

describe('parseDispatcherArgs', () => {
  it('parses list, help, and call forms', () => {
    expect(parseDispatcherArgs([])).toEqual({ op: 'usage' });
    expect(parseDispatcherArgs(['--help'])).toEqual({ op: 'usage' });
    expect(parseDispatcherArgs(['list'])).toEqual({ op: 'list' });
    expect(parseDispatcherArgs(['list', 'github'])).toEqual({ op: 'list', server: 'github' });
    expect(parseDispatcherArgs(['gh', 'search', '--help'])).toEqual({
      op: 'help',
      server: 'gh',
      tool: 'search',
    });
    expect(parseDispatcherArgs(['gh', 'search', '--query', 'bug', '--limit', '5'])).toEqual({
      op: 'call',
      server: 'gh',
      tool: 'search',
      rawArgs: { query: 'bug', limit: '5' },
    });
  });

  it('supports --key=value and bare boolean flags', () => {
    expect(parseDispatcherArgs(['s', 't', '--a=1', '--flag', '--b', 'two'])).toEqual({
      op: 'call',
      server: 's',
      tool: 't',
      rawArgs: { a: '1', flag: true, b: 'two' },
    });
  });

  it('errors clearly when a tool name is missing', () => {
    const cmd = parseDispatcherArgs(['github']);
    expect(cmd.op).toBe('error');
  });
});

describe('coerceArgs', () => {
  it('coerces by the tool schema types', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'number' },
        on: { type: 'boolean' },
        tags: { type: 'array' },
        name: { type: 'string' },
      },
    };
    expect(coerceArgs({ count: '42', on: 'true', tags: '["a","b"]', name: 'x' }, schema)).toEqual({
      count: 42,
      on: true,
      tags: ['a', 'b'],
      name: 'x',
    });
  });

  it('keeps bare flags as booleans and unknown keys as strings', () => {
    expect(coerceArgs({ verbose: true, other: 'y' }, undefined)).toEqual({
      verbose: true,
      other: 'y',
    });
  });
});

describe('renderHelp', () => {
  it('renders arguments + required markers from an inputSchema', () => {
    const help = renderHelp('gh', 'search', {
      description: 'Search issues.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The query.' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    });
    expect(help).toContain('Usage: pi-tool gh search');
    expect(help).toContain('Search issues.');
    expect(help).toContain('--query <string> (required) — The query.');
    expect(help).toContain('--limit <number>');
  });

  it('reports unknown tools and no-argument tools', () => {
    expect(renderHelp('gh', 'nope', undefined)).toContain('unknown tool');
    expect(renderHelp('gh', 't', { inputSchema: { type: 'object', properties: {} } })).toContain(
      'Arguments: none.',
    );
  });
});

describe('shim generators', () => {
  it('build a POSIX pi-tool wrapper that re-execs Electron as Node', () => {
    const sh = buildPiToolWrapper('/x/electron', '/y/dispatcher.js');
    expect(sh.startsWith('#!/bin/sh')).toBe(true);
    expect(sh).toContain('ELECTRON_RUN_AS_NODE=1 exec "/x/electron" "/y/dispatcher.js" "$@"');
  });

  it('build a dispatcher that reads the socket/token env', () => {
    const src = buildDispatcherSource();
    expect(src).toContain(PI_MCP_CLI_SOCK_ENV);
    expect(src).toContain(PI_MCP_CLI_TOKEN_ENV);
    expect(src).toContain("require('node:net')");
  });
});

describe('dispatchCommand (in-process routing)', () => {
  it('lists, helps, and calls against a real server', async () => {
    const host = newHost();
    await host.connectAll([serverConfig('a')]);

    const list = await dispatchCommand(host, parseDispatcherArgs(['list']));
    expect(list.isError).toBe(false);
    expect(list.text).toContain('echo');

    const help = await dispatchCommand(host, parseDispatcherArgs(['a', 'echo', '--help']));
    expect(help.text).toContain('--message');

    const call = await dispatchCommand(
      host,
      parseDispatcherArgs(['a', 'echo', '--message', 'hey']),
    );
    expect(call.isError).toBe(false);
    expect(call.text).toBe('hey');

    const bad = await dispatchCommand(host, parseDispatcherArgs(['a', 'ghost']));
    expect(bad.isError).toBe(true);
  });
});

describe('registerBashCliTools (live socket bridge)', () => {
  it('installs shims, injects PATH, round-trips a call, and disposes cleanly', async () => {
    const host = newHost();
    await host.connectAll([serverConfig('svc')]);
    const pi = createFakePi();

    const shimDir = mkdtempSync(path.join(tmpdir(), 'pi-mcpcli-test-'));
    const socketPath = path.join(shimDir, 'bridge.sock');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    const handle = registerBashCliTools(pi.api, host, {
      shimDir,
      socketPath,
      token: 'secret-token',
      execPath: '/fake/electron',
      env,
    });

    // Shim files written; PATH injected; socket/token published.
    expect(existsSync(handle.piToolPath)).toBe(true);
    expect(readFileSync(handle.piToolPath, 'utf8')).toContain('/fake/electron');
    expect(existsSync(path.join(shimDir, 'dispatcher.js'))).toBe(true);
    expect(env.PATH?.startsWith(`${shimDir}${path.delimiter}`)).toBe(true);
    expect(env[PI_MCP_CLI_SOCK_ENV]).toBe(socketPath);
    expect(env[PI_MCP_CLI_TOKEN_ENV]).toBe('secret-token');

    // The `cli` fallback tool is registered by default.
    expect(pi.tools.has('cli')).toBe(true);

    // Socket round-trip: a raw client mimics the dispatcher.
    const reply = await roundTrip(socketPath, {
      id: 1,
      token: 'secret-token',
      argv: ['svc', 'echo', '--message', 'socket'],
    });
    expect(reply.ok).toBe(true);
    expect(reply.isError).toBe(false);
    expect(reply.text).toBe('socket');

    // Wrong token is rejected.
    const denied = await roundTrip(socketPath, { id: 2, token: 'nope', argv: ['list'] });
    expect(denied.ok).toBe(false);

    // Dispose restores PATH + env and removes the shim dir + socket.
    handle.dispose();
    expect(env.PATH).toBe('/usr/bin');
    expect(env[PI_MCP_CLI_SOCK_ENV]).toBeUndefined();
    expect(existsSync(shimDir)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });

  it('the cli fallback tool routes without a socket', async () => {
    const host = newHost();
    await host.connectAll([serverConfig('svc')]);
    const pi = createFakePi();
    const shimDir = mkdtempSync(path.join(tmpdir(), 'pi-mcpcli-test-'));
    const handle = registerBashCliTools(pi.api, host, {
      shimDir,
      socketPath: path.join(shimDir, 'b.sock'),
      env: { PATH: '' },
    });
    const res = await pi.run('cli', { argv: ['svc', 'echo', '--message', 'viacli'] });
    expect((res.content[0] as { text: string }).text).toBe('viacli');
    handle.dispose();
  });
});

/** Send one line-delimited request and resolve the first reply. */
function roundTrip(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; text?: string; isError?: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('round-trip timed out'));
    }, 4000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(buf.slice(0, nl)));
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
