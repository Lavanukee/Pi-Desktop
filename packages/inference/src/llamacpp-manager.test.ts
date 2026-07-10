import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureLlamaCpp, probeServerFeatures } from './llamacpp-manager.js';
import type { LlamaCppRelease } from './llamacpp-manifest.js';

const PAYLOAD = Buffer.from('fake-tarball-bytes-'.repeat(1000));
const SHA = createHash('sha256').update(PAYLOAD).digest('hex');

const RELEASE: LlamaCppRelease = {
  tag: 'test-tag',
  repo: 'ggml-org/llama.cpp',
  macosArm64: { name: 'llama-test-bin-macos-arm64.tar.gz', sha256: SHA, sizeBytes: PAYLOAD.length },
};

/** Fake fetch that streams PAYLOAD once per call and counts invocations. */
function makeFetch(counter: { n: number }): typeof fetch {
  return (async () => {
    counter.n += 1;
    async function* body(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(PAYLOAD);
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (k: string) => (k === 'content-length' ? String(PAYLOAD.length) : null) },
      body: body(),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('ensureLlamaCpp', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `pi-llamacpp-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads, verifies, extracts, and locates llama-server', async () => {
    const counter = { n: 0 };
    const install = await ensureLlamaCpp({
      release: RELEASE,
      dir,
      fetchImpl: makeFetch(counter),
      extract: async (_archive, destDir) => {
        // Mimic the release layout: binaries nested under build/bin.
        await mkdir(join(destDir, 'build', 'bin'), { recursive: true });
        await writeFile(join(destDir, 'build', 'bin', 'llama-server'), '#!/bin/sh\n');
      },
    });
    expect(install.serverPath.endsWith('llama-server')).toBe(true);
    expect(install.archiveSha256).toBe(SHA);
    expect(counter.n).toBe(1);
  });

  it('is idempotent: a second call skips download + extract', async () => {
    const counter = { n: 0 };
    let extractCalls = 0;
    const opts = {
      release: RELEASE,
      dir,
      fetchImpl: makeFetch(counter),
      extract: async (_a: string, destDir: string) => {
        extractCalls += 1;
        await mkdir(destDir, { recursive: true });
        await writeFile(join(destDir, 'llama-server'), '#!/bin/sh\n');
      },
    };
    await ensureLlamaCpp(opts);
    await ensureLlamaCpp(opts);
    expect(counter.n).toBe(1);
    expect(extractCalls).toBe(1);
  });
});

describe('probeServerFeatures', () => {
  it('detects draft-mtp, mmproj, parallel, and model-draft from --help', async () => {
    const help = [
      '  --mmproj FILE            path to a multimodal projector file',
      '  --parallel N             number of parallel sequences',
      '  -md, --model-draft FILE  draft model for speculative decoding',
      '  --spec-type TYPE         speculative type: draft, draft-mtp, draft-eagle3',
    ].join('\n');
    const features = await probeServerFeatures('/bin/llama-server', {
      execFileImpl: async () => ({ stdout: help, stderr: '' }),
    });
    expect(features.mtp).toBe(true);
    expect(features.eagle3).toBe(true);
    expect(features.mmproj).toBe(true);
    expect(features.parallel).toBe(true);
    expect(features.draftModel).toBe(true);
  });

  it('reports mtp:false / eagle3:false when the build lacks those spec types', async () => {
    const features = await probeServerFeatures('/bin/llama-server', {
      execFileImpl: async () => ({ stdout: '  --parallel N\n  --mmproj FILE\n', stderr: '' }),
    });
    expect(features.mtp).toBe(false);
    expect(features.eagle3).toBe(false);
    expect(features.mmproj).toBe(true);
  });
});
