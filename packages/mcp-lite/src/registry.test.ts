import { describe, expect, it } from 'vitest';
import {
  defaultRegistry,
  defaultRegistryPath,
  loadRegistry,
  type McpRegistryConfig,
  parseRegistry,
  type RegistryFileIO,
  removeServer,
  saveRegistry,
  serializeRegistry,
  setServerEnabled,
  upsertServer,
} from './registry';

/** In-memory IO for round-trip tests. */
function memoryIO(): RegistryFileIO & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    read: (p) => store.get(p),
    write: (p, d) => {
      store.set(p, d);
    },
  };
}

const sample: McpRegistryConfig = {
  version: 1,
  mode: 'native',
  servers: [
    {
      id: 'fs',
      name: 'Filesystem',
      icon: '📁',
      description: 'files',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { FOO: 'bar' },
      enabled: true,
      mode: 'lite',
    },
  ],
};

describe('defaultRegistryPath', () => {
  it('lands under ~/.pi/desktop', () => {
    expect(defaultRegistryPath('/home/jedd')).toBe('/home/jedd/.pi/desktop/mcp-connectors.json');
  });
});

describe('save/load round-trip', () => {
  it('preserves the config through disk', () => {
    const io = memoryIO();
    const path = '/cfg/mcp.json';
    saveRegistry(path, sample, io);
    expect(io.store.get(path)).toBe(serializeRegistry(sample));
    expect(loadRegistry(path, io)).toEqual(sample);
  });

  it('returns a default when the file is absent', () => {
    const io = memoryIO();
    expect(loadRegistry('/nope.json', io)).toEqual(defaultRegistry());
  });

  it('returns a default on malformed JSON', () => {
    const io = memoryIO();
    io.write('/broken.json', '{ not json');
    expect(loadRegistry('/broken.json', io)).toEqual(defaultRegistry());
  });
});

describe('parseRegistry normalisation', () => {
  it('drops servers missing id or command and dedupes ids', () => {
    const cfg = parseRegistry({
      mode: 'lite',
      servers: [
        { id: 'a', command: 'x' },
        { id: 'a', command: 'y' }, // duplicate id → dropped
        { name: 'no id' },
        { id: 'b' }, // no command → dropped
        'garbage',
      ],
    });
    expect(cfg.servers.map((s) => s.id)).toEqual(['a']);
    expect(cfg.servers[0]?.name).toBe('a'); // name defaults to id
  });

  it('coerces an unknown mode to lite', () => {
    expect(parseRegistry({ mode: 'weird', servers: [] }).mode).toBe('lite');
  });

  it('keeps only string args and string env values', () => {
    const cfg = parseRegistry({
      servers: [{ id: 'a', command: 'x', args: ['ok', 5, null], env: { A: '1', B: 2 } }],
    });
    expect(cfg.servers[0]?.args).toEqual(['ok']);
    expect(cfg.servers[0]?.env).toEqual({ A: '1' });
  });
});

describe('pure mutations', () => {
  it('upserts by id', () => {
    let cfg = defaultRegistry();
    cfg = upsertServer(cfg, { id: 'a', name: 'A', command: 'x' });
    cfg = upsertServer(cfg, { id: 'a', name: 'A2', command: 'y' });
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0]?.name).toBe('A2');
  });

  it('removes by id', () => {
    const cfg = removeServer(sample, 'fs');
    expect(cfg.servers).toHaveLength(0);
  });

  it('toggles enabled', () => {
    const cfg = setServerEnabled(sample, 'fs', false);
    expect(cfg.servers[0]?.enabled).toBe(false);
    // original untouched (pure)
    expect(sample.servers[0]?.enabled).toBe(true);
  });
});
