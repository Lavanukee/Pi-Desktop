/**
 * End-to-end suite against the REAL mock MCP server spawned as a child (plain
 * node). Proves the client speaks protocol-correct JSONL and that ConnectorHost
 * routing, the MCP-lite proxy tools, and native-mode registration all work
 * against genuine handshake/discovery/call traffic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorHost } from './connector-host';
import { activateMcpLite } from './extension';
import { registerNativeTools, registerProxyTools } from './pi-tools';
import type { McpServerConfig, RegistryFileIO } from './registry';
import { McpStdioClient } from './stdio-client';
import { createFakePi, MOCK_MCP_SERVER } from './test-helpers';

function serverConfig(id: string, env: Record<string, string> = {}): McpServerConfig {
  return { id, name: `Mock ${id}`, command: process.execPath, args: [MOCK_MCP_SERVER], env };
}

const clients: McpStdioClient[] = [];
const hosts: ConnectorHost[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
  for (const h of hosts.splice(0)) h.disposeAll();
});

function newClient(env: Record<string, string> = {}): McpStdioClient {
  const c = new McpStdioClient({
    command: process.execPath,
    args: [MOCK_MCP_SERVER],
    env,
    killGraceMs: 200,
  });
  clients.push(c);
  return c;
}

function newHost(connectTimeoutMs = 5000): ConnectorHost {
  const h = new ConnectorHost({ connectTimeoutMs });
  hosts.push(h);
  return h;
}

describe('McpStdioClient against a real server', () => {
  it('handshakes, discovers, and calls tools', async () => {
    const client = newClient();
    const tools = await client.start({ timeoutMs: 5000 });
    expect(tools.map((t) => t.name)).toContain('echo');
    expect(client.serverInfo?.name).toBe('mock-mcp-server');

    const echo = await client.callTool('echo', { message: 'hello' });
    expect(echo.content?.[0]).toMatchObject({ type: 'text', text: 'hello' });

    const add = await client.callTool('add', { a: 40, b: 2 });
    expect(add.content?.[0]).toMatchObject({ type: 'text', text: '42' });

    const img = await client.callTool('make_image', {});
    expect(img.content?.[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });

    const boom = await client.callTool('boom', {});
    expect(boom.isError).toBe(true);
  });

  it('lists resources and prompts', async () => {
    const client = newClient();
    await client.start({ timeoutMs: 5000 });
    expect((await client.listResources()).map((r) => r.uri)).toContain('mock://readme');
    expect((await client.listPrompts()).map((p) => p.name)).toContain('greet');
  });

  it('times out and tears down a hung server', async () => {
    const client = newClient({ MOCK_MCP_HANG: '1' });
    await expect(client.start({ timeoutMs: 300 })).rejects.toThrow(/timed out/);
    await client.whenClosed();
    expect(client.connected).toBe(false);
  });
});

describe('ConnectorHost', () => {
  it('connects multiple servers and builds a schema-free catalog', async () => {
    const host = newHost();
    const results = await host.connectAll([serverConfig('a'), serverConfig('b')]);
    expect(results.every((r) => r.ok)).toBe(true);

    const catalog = host.getCatalog();
    expect(catalog.map((c) => c.id).sort()).toEqual(['a', 'b']);
    const a = catalog.find((c) => c.id === 'a');
    expect(a?.status).toBe('connected');
    expect(a?.tools.map((t) => t.name)).toContain('echo');
    // Catalog carries names + descriptions only, never schemas.
    expect(JSON.stringify(catalog)).not.toContain('inputSchema');
    expect(JSON.stringify(catalog)).not.toContain('properties');
  });

  it('routes calls to the owning server and errors clearly on unknowns', async () => {
    const host = newHost();
    await host.connectAll([serverConfig('a')]);
    const res = await host.callTool('a', 'echo', { message: 'hi' });
    expect(res.content?.[0]).toMatchObject({ text: 'hi' });

    await expect(host.callTool('nope', 'echo', {})).rejects.toThrow(/Unknown MCP server/);
    await expect(host.callTool('a', 'ghost', {})).rejects.toThrow(/Unknown tool/);
  });

  it('captures connect failures instead of throwing', async () => {
    // 3s (not a tight 600ms) so the GOOD server's real subprocess spawn +
    // handshake never spuriously times out when many test suites run in
    // parallel and saturate the machine; the HANG server (MOCK_MCP_HANG) never
    // replies, so it still errors at this timeout.
    const host = newHost(3000);
    const [ok, bad] = await host.connectAll([
      serverConfig('good'),
      {
        id: 'bad',
        name: 'Bad',
        command: process.execPath,
        args: [MOCK_MCP_SERVER],
        env: { MOCK_MCP_HANG: '1' },
      },
    ]);
    expect(ok?.ok).toBe(true);
    expect(bad?.ok).toBe(false);
    // The errored server still shows in the catalog so mcp_list surfaces it.
    expect(host.getCatalog().find((c) => c.id === 'bad')?.status).toBe('error');
  });
});

describe('MCP-lite proxy tools', () => {
  it('lists tools without schemas, fetches one schema on demand, then calls', async () => {
    const host = newHost();
    await host.connectAll([serverConfig('a')]);
    const pi = createFakePi();
    const names = registerProxyTools(pi.api, host);
    expect(names).toEqual(['mcp_list', 'mcp_schema', 'mcp_call']);

    // mcp_list: names + descriptions, NOT schemas.
    const list = await pi.run('mcp_list', {});
    const listText = (list.content[0] as { text: string }).text;
    expect(listText).toContain('echo');
    expect(listText).toContain('add');
    expect(listText).not.toContain('properties');
    expect(listText).not.toContain('inputSchema');

    // mcp_schema: the full schema on demand only.
    const schema = await pi.run('mcp_schema', { server: 'a', tool: 'echo' });
    const schemaText = (schema.content[0] as { text: string }).text;
    expect(schemaText).toContain('properties');
    expect(schemaText).toContain('message');

    // mcp_call: routes through the host.
    const call = await pi.run('mcp_call', {
      server: 'a',
      tool: 'echo',
      arguments: { message: 'yo' },
    });
    expect(call.content[0]).toMatchObject({ type: 'text', text: 'yo' });
    expect(call.details).toMatchObject({ server: 'a', tool: 'echo', isError: false });
  });

  it('surfaces call errors as tool results, not throws', async () => {
    const host = newHost();
    await host.connectAll([serverConfig('a')]);
    const pi = createFakePi();
    registerProxyTools(pi.api, host);

    const missing = await pi.run('mcp_call', { server: 'a', tool: 'ghost', arguments: {} });
    expect(missing.details).toMatchObject({ isError: true });
    expect((missing.content[0] as { text: string }).text).toMatch(/Unknown tool/);

    // A tool that itself returns isError propagates that flag.
    const boom = await pi.run('mcp_call', { server: 'a', tool: 'boom', arguments: {} });
    expect(boom.details).toMatchObject({ isError: true });
  });
});

describe('native-mode registration', () => {
  it('registers every MCP tool as a prefixed pi tool carrying its schema', async () => {
    const host = newHost();
    await host.connectAll([serverConfig('svc')]);
    const server = host.getConnected()[0];
    if (!server) throw new Error('expected a connected server');
    const pi = createFakePi();
    const names = registerNativeTools(pi.api, host, server);

    expect(names).toContain('svc_echo');
    const echoTool = pi.tools.get('svc_echo');
    expect(echoTool?.label).toContain('echo');
    // Schema is translated onto the pi tool (native = full schema in context).
    const params = echoTool?.parameters as unknown as Record<string, unknown>;
    expect(params.type).toBe('object');
    expect(params.properties).toMatchObject({ message: { type: 'string' } });

    const result = await pi.run('svc_echo', { message: 'native' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'native' });
  });
});

describe('activateMcpLite (extension wiring)', () => {
  function ioWith(config: unknown): RegistryFileIO {
    return { read: () => JSON.stringify(config), write: () => {} };
  }

  it('connects enabled servers and registers per configured mode', async () => {
    const host = newHost();
    const pi = createFakePi();
    const config = {
      version: 1,
      mode: 'lite',
      servers: [
        { id: 'lite1', name: 'Lite', command: process.execPath, args: [MOCK_MCP_SERVER] },
        {
          id: 'nat1',
          name: 'Native',
          command: process.execPath,
          args: [MOCK_MCP_SERVER],
          mode: 'native',
        },
        {
          id: 'off',
          name: 'Disabled',
          command: process.execPath,
          args: [MOCK_MCP_SERVER],
          enabled: false,
        },
      ],
    };
    const activation = await activateMcpLite(pi.api, {
      configPath: '/virtual/mcp.json',
      io: ioWith(config),
      host,
    });

    // Lite server → proxy tools registered; native server → prefixed tools.
    expect(activation.proxyRegistered).toBe(true);
    expect(pi.tools.has('mcp_call')).toBe(true);
    expect(pi.tools.has('nat1_echo')).toBe(true);
    // Disabled server never connected.
    expect(host.getCatalog().some((c) => c.id === 'off')).toBe(false);
    // /mcp command registered.
    expect(pi.commands.has('mcp')).toBe(true);

    // session_shutdown disposes the host.
    for (const h of pi.shutdownHandlers) h();
    expect(host.getConnected()).toHaveLength(0);
  });

  it('registers only the /mcp command when there are no servers', async () => {
    const host = newHost();
    const pi = createFakePi();
    const activation = await activateMcpLite(pi.api, {
      configPath: '/virtual/empty.json',
      io: { read: () => undefined, write: () => {} },
      host,
    });
    expect(activation.proxyRegistered).toBe(false);
    expect(pi.tools.size).toBe(0);
    expect(pi.commands.has('mcp')).toBe(true);
  });
});
