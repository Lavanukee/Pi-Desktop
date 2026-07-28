/**
 * Both real manglings, and the legitimate paths that must survive untouched.
 * A false positive here would silently relocate a correct file, which is worse
 * than the bug being fixed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repairNote, repairShadowTree, shadowRoots, unmanglePath } from './workspace-paths';

describe('the path the agent meant', () => {
  it('undoes run 11’s mangling — the whole absolute path, minus its leading slash', () => {
    const cwd = '/private/tmp/claude-501/abc-123/scratchpad/mesh11/ws';
    expect(unmanglePath(cwd, 'private/tmp/claude-501/abc-123/scratchpad/mesh11/ws/src/cli.py')).toBe(
      'src/cli.py',
    );
  });

  it('undoes run 9’s mangling — only the tail of the path', () => {
    const cwd = '/private/tmp/claude-501/abc-123/scratchpad/mesh9/ws';
    expect(unmanglePath(cwd, 'scratchpad/mesh9/ws/test_converter.py')).toBe('test_converter.py');
  });

  it('leaves ordinary relative paths completely alone', () => {
    const cwd = '/private/tmp/x/scratchpad/mesh9/ws';
    for (const p of ['cli.py', 'src/cli.py', 'tests/test_convert.py', 'a/b/c/d.py']) {
      expect(unmanglePath(cwd, p)).toBeUndefined();
    }
  });

  it('leaves absolute paths alone — those resolve correctly already', () => {
    const cwd = '/private/tmp/x/ws';
    expect(unmanglePath(cwd, '/private/tmp/x/ws/cli.py')).toBeUndefined();
  });

  it('does not strip a single matching component', () => {
    // The workspace ends in `src`, and `src/cli.py` is a perfectly normal thing
    // to write. One component is never enough evidence.
    const cwd = '/home/u/project/src';
    expect(unmanglePath(cwd, 'src/cli.py')).toBeUndefined();
  });

  it('never strips the whole path away', () => {
    const cwd = '/a/b/ws';
    expect(unmanglePath(cwd, 'b/ws')).toBeUndefined();
  });
});

describe('rescuing a shadow tree', () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(path.join(os.tmpdir(), 'pd-ws-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  /** Rebuild run 11's wreckage: the product written into a nested copy of ws. */
  const buildShadow = (): string => {
    const inner = path.join(ws, ...ws.split(path.sep).filter((c) => c !== ''));
    mkdirSync(path.join(inner, 'src'), { recursive: true });
    writeFileSync(path.join(inner, 'src', 'cli.py'), 'print("real work")');
    writeFileSync(path.join(inner, 'src', 'json_converter.py'), 'x = 1');
    return inner;
  };

  it('finds the shadow root', () => {
    const inner = buildShadow();
    expect(shadowRoots(ws)).toContain(inner);
  });

  it('moves the product to where the gate will look', () => {
    buildShadow();
    const moved = repairShadowTree(ws);
    expect(moved.map((m) => m.to).sort()).toEqual(
      [path.join('src', 'cli.py'), path.join('src', 'json_converter.py')].sort(),
    );
    expect(readFileSync(path.join(ws, 'src', 'cli.py'), 'utf8')).toBe('print("real work")');
  });

  it('never overwrites the real tree — the orphan is left readable', () => {
    const inner = buildShadow();
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src', 'cli.py'), 'the version already here');
    const moved = repairShadowTree(ws);
    expect(readFileSync(path.join(ws, 'src', 'cli.py'), 'utf8')).toBe('the version already here');
    expect(existsSync(path.join(inner, 'src', 'cli.py'))).toBe(true);
    expect(moved.map((m) => m.to)).toEqual([path.join('src', 'json_converter.py')]);
  });

  it('does nothing at all to a clean workspace', () => {
    writeFileSync(path.join(ws, 'cli.py'), 'fine');
    expect(shadowRoots(ws)).toEqual([]);
    expect(repairShadowTree(ws)).toEqual([]);
    expect(readFileSync(path.join(ws, 'cli.py'), 'utf8')).toBe('fine');
  });

  it('never throws on a directory that is not there', () => {
    expect(() => repairShadowTree('/definitely/not/a/directory')).not.toThrow();
  });

  it('says nothing when nothing moved, and names the files when they did', () => {
    expect(repairNote([])).toBe('');
    const note = repairNote([{ from: 'private/tmp/x/ws/src/cli.py', to: 'src/cli.py' }]);
    expect(note).toContain('src/cli.py');
    expect(note).toContain('BARE relative paths');
  });
});
