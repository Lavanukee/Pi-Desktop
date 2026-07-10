import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSearchUrl,
  estimateRamGB,
  type HfGgufFile,
  type HfModelHit,
  hfModelToCatalogEntry,
  listHfGgufFiles,
  parseQuant,
  searchHfModels,
} from './hf-search.js';
import { downloadModel } from './model-downloader.js';

// --- Fixtures (shaped like the real HF API, verified live 2026-07-09) --------

const SEARCH_FIXTURE = [
  {
    id: 'unsloth/gemma-4-E2B-it-GGUF',
    author: 'unsloth',
    gated: false,
    lastModified: '2026-07-09T06:45:19.000Z',
    likes: 943,
    downloads: 1_464_126,
    trendingScore: 157,
    tags: ['gguf', 'gemma4', 'image-text-to-text', 'license:apache-2.0'],
    pipeline_tag: 'image-text-to-text',
    modelId: 'unsloth/gemma-4-E2B-it-GGUF',
  },
  {
    // `id` absent → falls back to `modelId`; gated "manual" → boolean true.
    modelId: 'google/gemma-4-gated-GGUF',
    author: 'google',
    gated: 'manual',
    likes: 12,
    downloads: 500,
    tags: ['gguf', 'license:gemma'],
    pipeline_tag: 'text-generation',
  },
  { id: 'not-an-object-guard', downloads: 'nope', likes: null, tags: 'oops' },
];

const TREE_FIXTURE = [
  { type: 'directory', oid: 'a'.repeat(40), size: 0, path: 'MTP' },
  { type: 'file', oid: 'b'.repeat(40), size: 3891, path: '.gitattributes' },
  { type: 'file', oid: 'c'.repeat(40), size: 28_500, path: 'README.md' },
  {
    type: 'file',
    size: 3_106_736_256,
    lfs: {
      oid: '9378bc471710229ef165709b62e34bfb62231420ddaf6d729e727305b5b8672d',
      size: 3_106_736_256,
    },
    path: 'gemma-4-E2B-it-Q4_K_M.gguf',
  },
  {
    // lowercase quant in the name → normalised to Q6_K.
    type: 'file',
    size: 4_501_719_168,
    lfs: { oid: 'd'.repeat(64), size: 4_501_719_168 },
    path: 'gemma-4-E2B-it-q6_k.gguf',
  },
  {
    // Unsloth-Dynamic quant → UD-Q4_K_XL.
    type: 'file',
    size: 3_184_494_720,
    lfs: { oid: 'e'.repeat(64), size: 3_184_494_720 },
    path: 'gemma-4-E2B-it-UD-Q4_K_XL.gguf',
  },
  {
    type: 'file',
    size: 985_654_080,
    lfs: { oid: 'f'.repeat(64), size: 985_654_080 },
    path: 'mmproj-F16.gguf',
  },
  {
    type: 'file',
    size: 97_817_664,
    lfs: { oid: '1'.repeat(64), size: 97_817_664 },
    path: 'MTP/mtp-gemma-4-E2B-it-Q8_0.gguf',
  },
  {
    // No lfs block → size only, no sha. Should still parse.
    type: 'file',
    size: 123_456,
    path: 'tiny-Q2_K.gguf',
  },
];

/** A fetch that records the URL it was called with and returns a JSON body. */
function jsonFetch(body: unknown, sink?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (sink !== undefined) {
      sink.url = String(url);
      sink.init = init;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

// --- buildSearchUrl / param composition --------------------------------------

describe('buildSearchUrl', () => {
  it('composes search + ANDed filters + sort + limit + full', () => {
    const u = new URL(
      buildSearchUrl('gemma gguf', {
        sort: 'likes',
        limit: 5,
        filters: { family: 'gemma4', task: 'text-generation' },
      }),
    );
    expect(u.searchParams.get('search')).toBe('gemma gguf');
    // Repeated filter params, gguf first (default on), then family, then task.
    expect(u.searchParams.getAll('filter')).toEqual(['gguf', 'gemma4', 'text-generation']);
    expect(u.searchParams.get('sort')).toBe('likes');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('full')).toBe('true');
  });

  it('omits the gguf filter when ggufOnly is false and defaults sort to downloads', () => {
    const u = new URL(buildSearchUrl('qwen', { ggufOnly: false }));
    expect(u.searchParams.getAll('filter')).toEqual([]);
    expect(u.searchParams.get('sort')).toBe('downloads');
    expect(u.searchParams.get('limit')).toBe('20');
  });

  it('clamps limit into [1,100]', () => {
    expect(new URL(buildSearchUrl('x', { limit: 9999 })).searchParams.get('limit')).toBe('100');
    expect(new URL(buildSearchUrl('x', { limit: 0 })).searchParams.get('limit')).toBe('1');
  });
});

// --- searchHfModels ----------------------------------------------------------

describe('searchHfModels', () => {
  it('parses hits, normalises gated, maps trendingScore → likesRecent', async () => {
    const sink: { url?: string } = {};
    const hits = await searchHfModels('gemma', {
      fetchImpl: jsonFetch(SEARCH_FIXTURE, sink),
      sort: 'downloads',
    });
    // The third fixture row (bad shape) is tolerated, not crashed on.
    expect(hits).toHaveLength(3);

    const g = hits[0];
    expect(g?.id).toBe('unsloth/gemma-4-E2B-it-GGUF');
    expect(g?.author).toBe('unsloth');
    expect(g?.name).toBe('gemma-4-E2B-it-GGUF');
    expect(g?.downloads).toBe(1_464_126);
    expect(g?.likes).toBe(943);
    expect(g?.gated).toBe(false);
    expect(g?.pipelineTag).toBe('image-text-to-text');
    expect(g?.updatedAt).toBe('2026-07-09T06:45:19.000Z');
    expect(g?.likesRecent).toBe(157);

    // "manual" gated string → boolean true; id derived from modelId fallback.
    const gated = hits[1];
    expect(gated?.gated).toBe(true);
    expect(gated?.id).toBe('google/gemma-4-gated-GGUF');
    expect(gated?.author).toBe('google');

    // A malformed row degrades to zeros/empties rather than throwing.
    expect(hits[2]?.downloads).toBe(0);
    expect(hits[2]?.tags).toEqual([]);
  });

  it('applies client-side gated + minLikes filters', async () => {
    const onlyGated = await searchHfModels('gemma', {
      fetchImpl: jsonFetch(SEARCH_FIXTURE),
      filters: { gated: true },
    });
    expect(onlyGated.map((h) => h.id)).toEqual(['google/gemma-4-gated-GGUF']);

    const popular = await searchHfModels('gemma', {
      fetchImpl: jsonFetch(SEARCH_FIXTURE),
      filters: { minLikes: 100 },
    });
    expect(popular.map((h) => h.id)).toEqual(['unsloth/gemma-4-E2B-it-GGUF']);
  });

  it('throws on a non-ok response', async () => {
    const failing = (async () =>
      new Response('nope', {
        status: 429,
        statusText: 'Too Many Requests',
      })) as unknown as typeof fetch;
    await expect(searchHfModels('x', { fetchImpl: failing })).rejects.toThrow(/429/);
  });
});

// --- parseQuant --------------------------------------------------------------

describe('parseQuant', () => {
  it('parses standard, IQ, UD, lowercase, and sharded quant labels', () => {
    expect(parseQuant('gemma-4-E2B-it-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(parseQuant('model-Q8_0.gguf')).toBe('Q8_0');
    expect(parseQuant('model-IQ4_XS.gguf')).toBe('IQ4_XS');
    expect(parseQuant('gemma-4-E2B-it-UD-Q6_K_XL.gguf')).toBe('UD-Q6_K_XL');
    expect(parseQuant('Gemma-3-1B-it-Foo-Q4_k_m.gguf')).toBe('Q4_K_M');
    expect(parseQuant('gemma-4-26B-A4B-it-BF16-00001-of-00002.gguf')).toBe('BF16');
    expect(parseQuant('gemma-4-26B-A4B-it-MXFP4_MOE.gguf')).toBe('MXFP4_MOE');
    expect(parseQuant('mmproj-F16.gguf')).toBe('F16');
  });

  it('returns undefined when no quant token is present', () => {
    expect(parseQuant('model-final.gguf')).toBeUndefined();
    expect(parseQuant('config.json')).toBeUndefined();
  });
});

// --- listHfGgufFiles ---------------------------------------------------------

describe('listHfGgufFiles', () => {
  it('returns only gguf files, with sizes, sha256 (lfs.oid), quant, and flags', async () => {
    const sink: { url?: string } = {};
    const files = await listHfGgufFiles('unsloth/gemma-4-E2B-it-GGUF', {
      fetchImpl: jsonFetch(TREE_FIXTURE, sink),
    });
    expect(sink.url).toBe(
      'https://huggingface.co/api/models/unsloth/gemma-4-E2B-it-GGUF/tree/main?recursive=true',
    );
    // Directory, .gitattributes, README are excluded; 6 gguf files remain.
    expect(files.map((f) => f.path)).toEqual([
      'gemma-4-E2B-it-Q4_K_M.gguf',
      'gemma-4-E2B-it-q6_k.gguf',
      'gemma-4-E2B-it-UD-Q4_K_XL.gguf',
      'mmproj-F16.gguf',
      'MTP/mtp-gemma-4-E2B-it-Q8_0.gguf',
      'tiny-Q2_K.gguf',
    ]);

    const q4 = files.find((f) => f.path.endsWith('Q4_K_M.gguf'));
    expect(q4?.sizeBytes).toBe(3_106_736_256);
    expect(q4?.quant).toBe('Q4_K_M');
    expect(q4?.sha256).toBe('9378bc471710229ef165709b62e34bfb62231420ddaf6d729e727305b5b8672d');
    expect(q4?.mmproj).toBe(false);
    expect(q4?.mtp).toBe(false);

    expect(files.find((f) => f.path === 'gemma-4-E2B-it-q6_k.gguf')?.quant).toBe('Q6_K');
    expect(files.find((f) => f.path.includes('UD-Q4_K_XL'))?.quant).toBe('UD-Q4_K_XL');

    const mmproj = files.find((f) => f.path === 'mmproj-F16.gguf');
    expect(mmproj?.mmproj).toBe(true);
    expect(mmproj?.mtp).toBe(false);

    const mtp = files.find((f) => f.path.includes('mtp-gemma'));
    expect(mtp?.mtp).toBe(true);
    expect(mtp?.mmproj).toBe(false);

    // No lfs block → size preserved, sha absent.
    const tiny = files.find((f) => f.path === 'tiny-Q2_K.gguf');
    expect(tiny?.sizeBytes).toBe(123_456);
    expect(tiny?.sha256).toBeUndefined();
    expect(tiny?.quant).toBe('Q2_K');
  });

  it('follows Link rel="next" pagination', async () => {
    const page1 = [TREE_FIXTURE[3]]; // one gguf file
    const page2 = [TREE_FIXTURE[4]]; // another
    let call = 0;
    const paged = (async (url: string | URL) => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify(page1), {
          status: 200,
          headers: {
            link: '<https://huggingface.co/api/models/x/tree/main?recursive=true&cursor=ZZ>; rel="next"',
          },
        });
      }
      expect(String(url)).toContain('cursor=ZZ');
      return new Response(JSON.stringify(page2), { status: 200 });
    }) as unknown as typeof fetch;

    const files = await listHfGgufFiles('x', { fetchImpl: paged });
    expect(files).toHaveLength(2);
    expect(call).toBe(2);
  });
});

// --- estimateRamGB -----------------------------------------------------------

describe('estimateRamGB', () => {
  it('is monotonic in size and context, and lands near catalog minRamGB', () => {
    const e2bQ4 = estimateRamGB(3_106_736_256, 32_768);
    const qwen27bQ4 = estimateRamGB(17_106_773_120, 65_536);
    expect(e2bQ4).toBeGreaterThan(0);
    expect(qwen27bQ4).toBeGreaterThan(e2bQ4);
    // Qwen3.6-27B Q4 (catalog minRamGB 24) — heuristic should be in the ballpark.
    expect(qwen27bQ4).toBeGreaterThanOrEqual(22);
    expect(qwen27bQ4).toBeLessThanOrEqual(28);
    // More context → more RAM.
    expect(estimateRamGB(3_106_736_256, 128_000)).toBeGreaterThan(e2bQ4);
  });
});

// --- hfModelToCatalogEntry + downloader flow ---------------------------------

describe('hfModelToCatalogEntry', () => {
  const hit: HfModelHit = {
    id: 'unsloth/gemma-4-E2B-it-GGUF',
    author: 'unsloth',
    name: 'gemma-4-E2B-it-GGUF',
    downloads: 1_464_126,
    likes: 943,
    tags: ['gguf', 'gemma4', 'image-text-to-text', 'license:apache-2.0'],
    gated: false,
    pipelineTag: 'image-text-to-text',
  };
  const file: HfGgufFile = {
    path: 'gemma-4-E2B-it-Q4_K_M.gguf',
    sizeBytes: 3_106_736_256,
    quant: 'Q4_K_M',
    sha256: '9378bc471710229ef165709b62e34bfb62231420ddaf6d729e727305b5b8672d',
    mmproj: false,
    mtp: false,
  };

  it('adapts an HF hit + file into a downloader-ready CatalogModel', () => {
    const entry = hfModelToCatalogEntry(hit, file, { contextWindow: 32_768 });
    expect(entry.hfRepo).toBe('unsloth/gemma-4-E2B-it-GGUF');
    expect(entry.id).toBe('unsloth-gemma-4-e2b-it-gguf-q4-k-m');
    expect(entry.files).toHaveLength(1);
    expect(entry.files[0]?.name).toBe('gemma-4-E2B-it-Q4_K_M.gguf');
    expect(entry.files[0]?.bytes).toBe(3_106_736_256);
    expect(entry.files[0]?.quant).toBe('Q4_K_M');
    expect(entry.files[0]?.sha256).toBe(file.sha256);
    expect(entry.license).toBe('apache-2.0');
    expect(entry.input).toEqual(['text', 'image']); // image-text-to-text pipeline
    expect(entry.gated).toBe(false);
    expect(entry.verified).toBe(false);
    expect(entry.minRamGB).toBeGreaterThan(0);
  });

  it('attaches mmproj / mtp siblings when supplied', () => {
    const mmproj: HfGgufFile = {
      path: 'mmproj-F16.gguf',
      sizeBytes: 985_654_080,
      quant: 'F16',
      mmproj: true,
    };
    const entry = hfModelToCatalogEntry(hit, file, { mmproj });
    expect(entry.mmproj?.name).toBe('mmproj-F16.gguf');
    expect(entry.mmproj?.bytes).toBe(985_654_080);
  });

  it('flows through the EXISTING downloader for an arbitrary HF repo', async () => {
    // Prove a discovered repo downloads like a curated catalog entry: build a
    // tiny payload, adapt it, and drive downloadModel with an injected fetch.
    const payload = Buffer.from('a-fake-but-verified-gguf-payload');
    const sha = createHash('sha256').update(payload).digest('hex');
    const discovered: HfGgufFile = {
      path: 'toy-Q4_K_M.gguf',
      sizeBytes: payload.length,
      quant: 'Q4_K_M',
      sha256: sha,
    };
    const entry = hfModelToCatalogEntry(
      { ...hit, id: 'someone/toy-GGUF', name: 'toy-GGUF' },
      discovered,
    );

    const seen: string[] = [];
    const fakeDownload = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.length), 'accept-ranges': 'bytes' },
      });
    }) as unknown as typeof fetch;

    const dir = join(tmpdir(), `pi-hf-${Math.random().toString(36).slice(2)}`);
    tmpDirs.push(dir);
    const result = await downloadModel(entry, { dir, fetchImpl: fakeDownload });

    // The downloader targeted the HF resolve URL derived purely from the entry.
    expect(seen[0]).toBe('https://huggingface.co/someone/toy-GGUF/resolve/main/toy-Q4_K_M.gguf');
    const written = await readFile(result.modelPath);
    expect(written.equals(payload)).toBe(true);
  });
});

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// --- LIVE (network) — env-guarded so CI stays offline -----------------------

const LIVE = process.env.PI_HF_E2E === '1';

describe.skipIf(!LIVE)('LIVE Hugging Face API', () => {
  it('searchHfModels("gemma gguf") returns real gguf hits', async () => {
    const hits = await searchHfModels('gemma gguf', { limit: 5, sort: 'downloads' });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.id).toContain('/');
      expect(h.downloads).toBeGreaterThanOrEqual(0);
    }
    console.log(
      'LIVE gemma hits:',
      hits.map((h) => `${h.id} (dl=${h.downloads}, likes=${h.likes}, gated=${h.gated})`),
    );
  }, 30_000);

  it('searchHfModels("qwen") returns real hits', async () => {
    const hits = await searchHfModels('qwen', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    console.log(
      'LIVE qwen hits:',
      hits.map((h) => h.id),
    );
  }, 30_000);

  it('listHfGgufFiles on a known repo returns real gguf files with sizes + quants', async () => {
    const files = await listHfGgufFiles('unsloth/gemma-4-E2B-it-GGUF');
    const withSize = files.filter((f) => (f.sizeBytes ?? 0) > 0);
    expect(withSize.length).toBeGreaterThan(0);
    for (const f of withSize) expect(f.sizeBytes).toBeGreaterThan(0);
    console.log(
      'LIVE gguf files:',
      files.map(
        (f) =>
          `${f.path} [${f.quant ?? '?'}] ${((f.sizeBytes ?? 0) / 1e9).toFixed(2)}GB sha=${f.sha256?.slice(0, 8) ?? 'none'}`,
      ),
    );
  }, 30_000);

  it('adapts a live repo to a catalog entry whose file HEAD-resolves', async () => {
    const [hit] = await searchHfModels('gemma gguf', { limit: 1, sort: 'downloads' });
    expect(hit).toBeDefined();
    if (hit === undefined) return;
    const files = await listHfGgufFiles(hit.id);
    const main = files.find((f) => f.quant?.startsWith('Q4') && !f.mmproj && !f.mtp) ?? files[0];
    expect(main).toBeDefined();
    if (main === undefined) return;

    const entry = hfModelToCatalogEntry(hit, main);
    expect(entry.hfRepo).toBe(hit.id);
    expect(entry.files[0]?.name).toBe(main.path);

    // HEAD the resolve URL the downloader would use — no GB transferred.
    const { hfHeadFile } = await import('./hf-search.js');
    const head = await hfHeadFile(entry.hfRepo, entry.files[0]?.name ?? '');
    expect(head.ok).toBe(true);
    console.log(
      `LIVE adapt: ${entry.id} → ${entry.hfRepo}/${entry.files[0]?.name} minRamGB=${entry.minRamGB} HEAD size=${head.sizeBytes} sha=${head.sha256?.slice(0, 8)}`,
    );
  }, 30_000);
});
