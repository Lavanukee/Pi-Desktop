import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  boundLimit,
  buildMdfindArgs,
  detectMdfindError,
  formatBytes,
  MAX_SPOTLIGHT_LIMIT,
  mapKind,
  parseMdfindPaths,
  parseMdlsAttributes,
  runSpotlightSearch,
  type SpotlightProcessResult,
  type SpotlightRunner,
  type SpotlightRunOptions,
} from './spotlight.js';

const mdfindOut = readFileSync(new URL('./fixtures/mdfind.txt', import.meta.url), 'utf8');
const mdlsOut = readFileSync(new URL('./fixtures/mdls.txt', import.meta.url), 'utf8');

// --- a recording fake runner -----------------------------------------------

interface RunCall {
  command: string;
  args: string[];
  opts: SpotlightRunOptions;
}

function proc(stdout: string, over: Partial<SpotlightProcessResult> = {}): SpotlightProcessResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
}

/**
 * Fake runner: `mdfind` returns `mdfindResult`; every `mdls` call returns
 * `mdlsResult` (or an empty block). Records all calls for assertion.
 */
function fakeRunner(opts: {
  mdfind?: SpotlightProcessResult;
  mdls?: SpotlightProcessResult;
  throwOn?: string;
}): { runner: SpotlightRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const runner: SpotlightRunner = {
    async run(command, args, runOpts) {
      calls.push({ command, args: [...args], opts: runOpts });
      if (opts.throwOn !== undefined && command === opts.throwOn) {
        throw new Error(`spawn ${command} ENOENT`);
      }
      if (command === 'mdls') return opts.mdls ?? proc('');
      return opts.mdfind ?? proc('');
    },
  };
  return { runner, calls };
}

const darwin = { platform: 'darwin' as const, enrich: false };

// --- pure parsers / mappers ------------------------------------------------

describe('mapKind', () => {
  it('maps the documented kinds to mdfind kind: tokens', () => {
    expect(mapKind('pdf')).toBe('pdf');
    expect(mapKind('image')).toBe('image');
    expect(mapKind('folder')).toBe('folder');
    expect(mapKind('app')).toBe('application');
    expect(mapKind('text')).toBe('text');
  });

  it('maps aliases and is case/whitespace-insensitive; video -> movie', () => {
    expect(mapKind('APPLICATION')).toBe('application');
    expect(mapKind('  Photo ')).toBe('image');
    expect(mapKind('video')).toBe('movie');
    expect(mapKind('music')).toBe('audio');
    expect(mapKind('directory')).toBe('folder');
  });

  it('returns undefined for an unknown kind', () => {
    expect(mapKind('spreadsheet')).toBeUndefined();
    expect(mapKind('')).toBeUndefined();
  });
});

describe('boundLimit', () => {
  it('defaults to 20 and clamps to [1, MAX]', () => {
    expect(boundLimit(undefined)).toBe(20);
    expect(boundLimit(0)).toBe(1);
    expect(boundLimit(999)).toBe(MAX_SPOTLIGHT_LIMIT);
    expect(boundLimit(7)).toBe(7);
    expect(boundLimit(Number.NaN)).toBe(20);
  });
});

describe('buildMdfindArgs', () => {
  it('passes a bare query through as the sole arg', () => {
    expect(buildMdfindArgs({ query: 'invoice' })).toEqual({
      args: ['invoice'],
      kindUnknown: false,
    });
  });

  it('maps scope to -onlyin and appends kind:<token> to the query', () => {
    const built = buildMdfindArgs({ query: 'invoice', scope: '/Users/jedd/Docs', kind: 'pdf' });
    expect(built.args).toEqual(['-onlyin', '/Users/jedd/Docs', 'invoice kind:pdf']);
    expect(built.kindUnknown).toBe(false);
  });

  it('emits a kind-only query when the text is empty', () => {
    expect(buildMdfindArgs({ query: '   ', kind: 'image' }).args).toEqual(['kind:image']);
  });

  it('flags an unknown kind and drops it from the query', () => {
    const built = buildMdfindArgs({ query: 'report', kind: 'spreadsheet' });
    expect(built.args).toEqual(['report']);
    expect(built.kindUnknown).toBe(true);
  });

  it('ignores an empty/whitespace scope', () => {
    expect(buildMdfindArgs({ query: 'x', scope: '   ' }).args).toEqual(['x']);
  });
});

describe('parseMdfindPaths', () => {
  it('extracts absolute paths, skipping blank and non-path lines', () => {
    const paths = parseMdfindPaths(mdfindOut);
    expect(paths).toContain('/Users/jedd/Documents/quarterly-report.pdf');
    expect(paths).toContain('/Applications/Safari.app');
    // preserves spaces inside filenames
    expect(paths).toContain('/Users/jedd/Desktop/notes/meeting notes.txt');
    // no blanks
    expect(paths.every((p) => p.startsWith('/'))).toBe(true);
  });

  it('respects the max bound', () => {
    expect(parseMdfindPaths(mdfindOut, 2)).toHaveLength(2);
  });

  it('strips trailing carriage returns', () => {
    expect(parseMdfindPaths('/a/b\r\n/c/d\r\n')).toEqual(['/a/b', '/c/d']);
  });
});

describe('detectMdfindError', () => {
  it('detects the stdout "Failed to create query" diagnostic', () => {
    const msg = detectMdfindError("Failed to create query for 'kMDItemFSName == '.");
    expect(msg).toContain('could not parse the query');
  });

  it('returns undefined for normal path output', () => {
    expect(detectMdfindError('/Applications/Safari.app\n')).toBeUndefined();
  });
});

describe('parseMdlsAttributes', () => {
  it('parses kind/size/modified and strips quotes from kind', () => {
    expect(parseMdlsAttributes(mdlsOut)).toEqual({
      kind: 'Application',
      size: 36327161,
      modified: '2026-03-05 06:48:29 +0000',
    });
  });

  it('skips (null) values and unknown attributes', () => {
    const out = parseMdlsAttributes(
      'kMDItemKind = "Folder"\nkMDItemFSSize = (null)\nkMDItemWhatever = 1\n',
    );
    expect(out).toEqual({ kind: 'Folder' });
  });

  it('returns an empty object for a "could not find" block', () => {
    expect(parseMdlsAttributes('/x: could not find /x.\n')).toEqual({});
  });
});

describe('formatBytes', () => {
  it('formats sizes with sensible units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(36327161)).toBe('35 MB');
  });
});

// --- runSpotlightSearch (injected fake runner) -----------------------------

describe('runSpotlightSearch', () => {
  it('returns a macOS-only error on non-darwin without touching the runner', async () => {
    const { runner, calls } = fakeRunner({});
    const outcome = await runSpotlightSearch(
      runner,
      { query: 'x' },
      { platform: 'linux', enrich: false },
    );
    expect(outcome.error).toContain('macOS-only');
    expect(outcome.hits).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('parses hits from mdfind output and derives basenames', async () => {
    const { runner, calls } = fakeRunner({ mdfind: proc(mdfindOut) });
    const outcome = await runSpotlightSearch(runner, { query: 'invoice' }, darwin);
    expect(outcome.error).toBeUndefined();
    expect(outcome.count).toBeGreaterThan(0);
    expect(outcome.hits[0]).toMatchObject({
      path: '/Users/jedd/Documents/quarterly-report.pdf',
      name: 'quarterly-report.pdf',
    });
    // enrich:false -> only the single mdfind call, no mdls
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('mdfind');
  });

  it('threads scope + kind into the mdfind args', async () => {
    const { runner, calls } = fakeRunner({ mdfind: proc('/Users/jedd/a.pdf\n') });
    await runSpotlightSearch(
      runner,
      { query: 'invoice', scope: '/Users/jedd', kind: 'pdf' },
      darwin,
    );
    expect(calls[0]?.args).toEqual(['-onlyin', '/Users/jedd', 'invoice kind:pdf']);
  });

  it('enriches the top hits with mdls metadata (best-effort)', async () => {
    const { runner, calls } = fakeRunner({
      mdfind: proc('/Applications/Safari.app\n'),
      mdls: proc(mdlsOut),
    });
    const outcome = await runSpotlightSearch(runner, { query: 'safari' }, { platform: 'darwin' });
    expect(outcome.hits[0]).toMatchObject({
      name: 'Safari.app',
      kind: 'Application',
      size: 36327161,
    });
    expect(calls.some((c) => c.command === 'mdls')).toBe(true);
  });

  it('survives a failing mdls (hit stays un-enriched, no throw)', async () => {
    const { runner } = fakeRunner({ mdfind: proc('/Applications/Safari.app\n'), throwOn: 'mdls' });
    const outcome = await runSpotlightSearch(runner, { query: 'safari' }, { platform: 'darwin' });
    expect(outcome.error).toBeUndefined();
    expect(outcome.hits[0]).toMatchObject({ name: 'Safari.app' });
    expect(outcome.hits[0]?.kind).toBeUndefined();
  });

  it('caps to the limit and flags truncation when more matched', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `/tmp/f${i}.txt`).join('\n');
    const { runner } = fakeRunner({ mdfind: proc(many) });
    const outcome = await runSpotlightSearch(runner, { query: 'f', limit: 3 }, darwin);
    expect(outcome.count).toBe(3);
    expect(outcome.truncated).toBe(true);
    expect(outcome.note).toContain('more than 3 results');
  });

  it('surfaces an unrecognized kind as a note (still searches free text)', async () => {
    const { runner, calls } = fakeRunner({ mdfind: proc('/tmp/a\n') });
    const outcome = await runSpotlightSearch(
      runner,
      { query: 'report', kind: 'spreadsheet' },
      darwin,
    );
    expect(outcome.note).toContain('unrecognized kind');
    expect(calls[0]?.args).toEqual(['report']);
  });

  it('reports a query-parse failure as an error', async () => {
    const { runner } = fakeRunner({
      mdfind: proc("Failed to create query for 'kMDItemFSName == '.\n"),
    });
    const outcome = await runSpotlightSearch(runner, { query: 'kMDItemFSName == ' }, darwin);
    expect(outcome.error).toContain('could not parse');
    expect(outcome.hits).toEqual([]);
  });

  it('rejects an empty query with no kind', async () => {
    const { runner, calls } = fakeRunner({});
    const outcome = await runSpotlightSearch(runner, { query: '   ' }, darwin);
    expect(outcome.error).toContain('non-empty query');
    expect(calls).toHaveLength(0);
  });

  it('never throws when the runner cannot spawn mdfind', async () => {
    const { runner } = fakeRunner({ throwOn: 'mdfind' });
    const outcome = await runSpotlightSearch(runner, { query: 'x' }, darwin);
    expect(outcome.error).toContain('mdfind failed to start');
    expect(outcome.hits).toEqual([]);
  });

  it('flags truncation and notes a timeout', async () => {
    const { runner } = fakeRunner({ mdfind: proc('/tmp/a\n', { timedOut: true }) });
    const outcome = await runSpotlightSearch(runner, { query: 'x' }, darwin);
    expect(outcome.truncated).toBe(true);
    expect(outcome.note).toContain('timed out');
  });
});
