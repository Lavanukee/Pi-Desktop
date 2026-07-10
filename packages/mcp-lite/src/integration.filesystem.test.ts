/**
 * Env-guarded integration test against the real reference filesystem MCP server
 * (`npx -y @modelcontextprotocol/server-filesystem <dir>`). Skipped unless
 * PI_MCP_INTEGRATION=1 because it needs network on first run to fetch the npx
 * package. The mock-server suite is the always-on equivalent.
 *
 *   PI_MCP_INTEGRATION=1 pnpm --filter @pi-desktop/mcp-lite test
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConnectorHost } from './connector-host';
import { registerNativeTools, registerProxyTools } from './pi-tools';
import { createFakePi } from './test-helpers';

const ENABLED = process.env.PI_MCP_INTEGRATION === '1';

describe.skipIf(!ENABLED)('filesystem MCP server (both modes)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-fs-'));
  writeFileSync(path.join(dir, 'hello.txt'), 'hello from mcp-lite');
  const host = new ConnectorHost({ connectTimeoutMs: 120_000 });

  afterAll(() => host.disposeAll());

  it('connects and lists filesystem tools', async () => {
    const [res] = await host.connectAll([
      {
        id: 'fs',
        name: 'Filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', dir],
      },
    ]);
    expect(res?.ok).toBe(true);
    const names = host.getServerTools('fs').map((t) => t.name);
    expect(names.some((n) => n.includes('read'))).toBe(true);
  });

  it('reads a file through the lite proxy', async () => {
    const pi = createFakePi();
    registerProxyTools(pi.api, host);
    const list = await pi.run('mcp_list', {});
    expect((list.content[0] as { text: string }).text).toContain('fs');
    const read = await pi.run('mcp_call', {
      server: 'fs',
      tool: 'read_text_file',
      arguments: { path: path.join(dir, 'hello.txt') },
    });
    expect((read.content[0] as { text: string }).text).toContain('hello from mcp-lite');
  });

  it('reads a file through a native tool', async () => {
    const server = host.getConnected()[0];
    if (!server) throw new Error('expected connected fs server');
    const pi = createFakePi();
    registerNativeTools(pi.api, host, server);
    const read = await pi.run('fs_read_text_file', { path: path.join(dir, 'hello.txt') });
    expect((read.content[0] as { text: string }).text).toContain('hello from mcp-lite');
  });
});
