import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureUv, PINNED_UV } from './uv.js';

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'pi-web-tools-uv-'));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
});

describe('ensureUv PATH detection', () => {
  it('resolves an existing uv from a scanned PATH', async () => {
    const bindir = join(workdir, 'bin');
    await mkdir(bindir, { recursive: true });
    await writeFile(join(bindir, 'uv'), '#!/bin/sh\n');
    const install = await ensureUv({ pathEnv: bindir });
    expect(install.source).toBe('path');
    expect(install.uvPath).toBe(join(bindir, 'uv'));
  });
});

describe('ensureUv download path (injected fetch + extract)', () => {
  const bytes = Buffer.from('fake-uv-tarball-contents-1234567890');
  const sha = createHash('sha256').update(bytes).digest('hex');

  const fetchImpl: typeof fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('.sha256')) return new Response(`${sha}  ${PINNED_UV.assetName}\n`);
    return new Response(bytes);
  };
  const extract = async (_archive: string, destDir: string): Promise<void> => {
    const inner = join(destDir, 'uv-aarch64-apple-darwin');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'uv'), '#!/bin/sh\necho uv');
  };

  it('downloads, verifies the checksum, extracts, and records a marker', async () => {
    const dir = join(workdir, 'cache');
    const install = await ensureUv({ ignorePath: true, dir, fetchImpl, extract });
    expect(install.source).toBe('download');
    expect(install.version).toBe(PINNED_UV.version);
    expect(install.uvPath.endsWith('/uv')).toBe(true);
    expect(existsSync(install.uvPath)).toBe(true);
    expect(existsSync(join(dir, '.installed.json'))).toBe(true);
  });

  it('is idempotent — a second call uses the marker without fetching again', async () => {
    const dir = join(workdir, 'cache2');
    const first = await ensureUv({ ignorePath: true, dir, fetchImpl, extract });
    const boom = (): never => {
      throw new Error('should not be called on the cached path');
    };
    const second = await ensureUv({
      ignorePath: true,
      dir,
      fetchImpl: (() => boom()) as unknown as typeof fetch,
      extract: () => boom(),
    });
    expect(second.uvPath).toBe(first.uvPath);
  });

  it('rejects on a checksum mismatch', async () => {
    const dir = join(workdir, 'cache3');
    const badFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('.sha256')) return new Response(`${'0'.repeat(64)}  ${PINNED_UV.assetName}\n`);
      return new Response(bytes);
    };
    await expect(ensureUv({ ignorePath: true, dir, fetchImpl: badFetch, extract })).rejects.toThrow(
      /sha256 mismatch/,
    );
  });
});
