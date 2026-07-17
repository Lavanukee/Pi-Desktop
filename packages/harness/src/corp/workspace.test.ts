import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeNodeWorkspaceFs, slotPath, type WorkspaceFs, writeSlot } from './workspace.js';

describe('slotPath (pure, escape-proof)', () => {
  it('places a relative slot beneath the workspace root', () => {
    expect(slotPath('/ws', 'src/game/state.ts')).toBe(join('/ws', 'src', 'game', 'state.ts'));
  });

  it('drops leading slashes so an "absolute" slot still lands inside the root', () => {
    expect(slotPath('/ws', '/src/a.ts')).toBe(join('/ws', 'src', 'a.ts'));
  });

  it('strips . and .. segments so a slot can never escape the workspace', () => {
    expect(slotPath('/ws', '../../etc/passwd')).toBe(join('/ws', 'etc', 'passwd'));
    expect(slotPath('/ws', 'src/../../../x.ts')).toBe(join('/ws', 'src', 'x.ts'));
  });
});

describe('writeSlot over an injected seam', () => {
  it('writes through the seam and returns the resolved absolute path', () => {
    const store = new Map<string, string>();
    const fs: WorkspaceFs = { writeFile: (p, c) => void store.set(p, c) };
    const path = writeSlot('/ws', 'src/a.ts', 'export const a = 1;\n', fs);
    expect(path).toBe(join('/ws', 'src', 'a.ts'));
    expect(store.get(path)).toBe('export const a = 1;\n');
  });
});

describe('makeNodeWorkspaceFs (real disk)', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'corp-ws-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('mkdir -p the slot parent and writes the file', () => {
    const root = scratch();
    const path = writeSlot(root, 'src/deep/nested/file.ts', 'hello\n', makeNodeWorkspaceFs());
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('hello\n');
  });
});
