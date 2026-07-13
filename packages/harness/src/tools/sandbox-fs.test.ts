/**
 * File-spill containment (blind-test round-2 #2). These cover the ROOT-CAUSE fix:
 * a RELATIVE path a tool writes must land in the resolved sandbox/project cwd, and
 * NEVER in HOME. The "fake tool runner" case drives the actual `write` tool
 * definition against a real temp workspace and asserts the byte hit the sandbox.
 *
 * NOTE: a REAL end-to-end check with a live local model (Gemma-class) issuing a
 * bare `write {path:"file1.txt"}` and confirming the file lands in the sandbox
 * (not /Users/<you>/) is still required to fully close the backlog item — that
 * needs the desktop app + a downloaded model and can't run in unit CI.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowedWriteRoots,
  createSandboxFileTools,
  isInsideRoots,
  registerSandboxFileTools,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  sandboxBaseDir,
} from './sandbox-fs.js';

const norm = (p: string) => path.resolve(p);

describe('resolveWorkspacePath', () => {
  const sandbox = '/tmp/pi/sandbox/conv1';

  it('roots a bare relative path at the workspace — NOT HOME (the reported bug)', () => {
    expect(resolveWorkspacePath('file1.txt', sandbox)).toBe(path.join(sandbox, 'file1.txt'));
    expect(resolveWorkspacePath('notes/todo.md', sandbox)).toBe(
      path.join(sandbox, 'notes/todo.md'),
    );
    // Crucially it does NOT land under the user's home directory.
    expect(resolveWorkspacePath('file1.txt', sandbox).startsWith(os.homedir() + path.sep)).toBe(
      false,
    );
  });

  it('passes an absolute path through (normalized)', () => {
    expect(resolveWorkspacePath('/etc/hosts', sandbox)).toBe('/etc/hosts');
    expect(resolveWorkspacePath('/tmp/a/../b/c.txt', sandbox)).toBe('/tmp/b/c.txt');
  });

  it('expands ~ and a leading @ the way pi does (so the fence can catch them)', () => {
    expect(resolveWorkspacePath('~/evil.txt', sandbox)).toBe(path.join(os.homedir(), 'evil.txt'));
    expect(resolveWorkspacePath('@file1.txt', sandbox)).toBe(path.join(sandbox, 'file1.txt'));
  });

  it('collapses .. escapes so the fence sees the real target', () => {
    expect(resolveWorkspacePath('../../escape.txt', sandbox)).toBe('/tmp/pi/escape.txt');
  });
});

describe('isInsideRoots', () => {
  const roots = [norm('/tmp/ws'), norm('/tmp/sandbox')];
  it('accepts the root itself and nested paths', () => {
    expect(isInsideRoots('/tmp/ws', roots)).toBe(true);
    expect(isInsideRoots('/tmp/ws/a/b.txt', roots)).toBe(true);
    expect(isInsideRoots('/tmp/sandbox/x.txt', roots)).toBe(true);
  });
  it('rejects HOME, siblings, and prefix look-alikes', () => {
    expect(isInsideRoots(path.join(os.homedir(), 'evil.txt'), roots)).toBe(false);
    expect(isInsideRoots('/tmp/wsomething/x', roots)).toBe(false);
    expect(isInsideRoots('/etc/passwd', roots)).toBe(false);
  });
});

describe('resolveWorkspaceRoot', () => {
  it('prefers the desktop env hint, then ctx.cwd', () => {
    const home = '/Users/tester';
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ws2-'));
    try {
      expect(resolveWorkspaceRoot(ws, { PI_DESKTOP_WORKSPACE_ROOT: ws2 }, home)).toBe(norm(ws2));
      expect(resolveWorkspaceRoot(ws, {}, home)).toBe(norm(ws));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });

  it('never roots at the bare HOME dir — a HOME candidate is skipped', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    try {
      // env hint == HOME is skipped; ctx.cwd (a real temp dir != HOME) wins.
      expect(resolveWorkspaceRoot(ws, { PI_DESKTOP_WORKSPACE_ROOT: home }, home)).toBe(norm(ws));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls through to a dedicated sandbox dir — NEVER HOME — when every candidate is HOME', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
    const originalCwd = process.cwd();
    try {
      // Force process.cwd() == HOME too so ALL candidates collapse to HOME.
      process.chdir(home);
      const root = resolveWorkspaceRoot(home, { PI_DESKTOP_WORKSPACE_ROOT: home }, home);
      expect(root).not.toBe(norm(home));
      expect(root.startsWith(norm(sandboxBaseDir(home)))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('createSandboxFileTools — fake tool runner', () => {
  let ws: string;
  let outside: string;
  const ctx = (cwd: string) => ({ cwd }) as unknown as ExtensionContext;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function writeTool() {
    const tools = createSandboxFileTools({ getRoot: () => ws });
    const write = tools.find((t) => t.name === 'write');
    if (write === undefined) throw new Error('write tool missing');
    return write;
  }

  it('CONTAINS a relative write into the sandbox, not HOME', async () => {
    const write = writeTool();
    const res = await write.execute(
      'call-1',
      { path: 'file1.txt', content: 'hello sandbox' },
      undefined,
      undefined,
      ctx(ws),
    );
    // The byte landed in the sandbox…
    expect(fs.readFileSync(path.join(ws, 'file1.txt'), 'utf8')).toBe('hello sandbox');
    // …and nowhere near HOME.
    expect(fs.existsSync(path.join(os.homedir(), 'file1.txt'))).toBe(false);
    expect(res.content[0]?.type).toBe('text');
  });

  it('creates parent dirs for a nested relative path inside the sandbox', async () => {
    const write = writeTool();
    await write.execute(
      'call-2',
      { path: 'sub/dir/note.md', content: '# hi' },
      undefined,
      undefined,
      ctx(ws),
    );
    expect(fs.readFileSync(path.join(ws, 'sub/dir/note.md'), 'utf8')).toBe('# hi');
  });

  it('REFUSES an absolute write that escapes the workspace (fence), writing nothing', async () => {
    const write = writeTool();
    const target = path.join(outside, 'evil.txt');
    await expect(
      write.execute('call-3', { path: target, content: 'nope' }, undefined, undefined, ctx(ws)),
    ).rejects.toThrow(/outside the workspace/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('REFUSES a ~ escape without touching HOME', async () => {
    const write = writeTool();
    // Resolves to <HOME>/pi-fence-should-never-write.txt — the fence rejects
    // BEFORE any fs call, so HOME is never touched.
    await expect(
      write.execute(
        'call-4',
        { path: '~/pi-fence-should-never-write.txt', content: 'nope' },
        undefined,
        undefined,
        ctx(ws),
      ),
    ).rejects.toThrow(/outside the workspace/);
    expect(fs.existsSync(path.join(os.homedir(), 'pi-fence-should-never-write.txt'))).toBe(false);
  });

  it('allowedWriteRoots always includes the sandbox base', () => {
    expect(allowedWriteRoots(ws)).toContain(norm(sandboxBaseDir()));
    expect(allowedWriteRoots(ws)).toContain(norm(ws));
  });
});

describe('registerSandboxFileTools gating', () => {
  it('registers the four overrides only when PI_DESKTOP_FS_FENCE=1', () => {
    const names: string[] = [];
    const pi = { registerTool: (t: { name: string }) => names.push(t.name) } as never;

    expect(registerSandboxFileTools(pi, { env: {} })).toBe(false);
    expect(names).toHaveLength(0);

    expect(registerSandboxFileTools(pi, { env: { PI_DESKTOP_FS_FENCE: '1' } })).toBe(true);
    expect(names.sort()).toEqual(['edit', 'ls', 'read', 'write']);
  });
});
