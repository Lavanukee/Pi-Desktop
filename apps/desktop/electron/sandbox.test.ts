/**
 * Wave D — per-conversation sandbox folder. Covers: deterministic path
 * derivation, id sanitization (no traversal escape), lazy on-demand creation,
 * and the cwd-resolution rule that roots a projectless conversation at its
 * sandbox while letting a real project / a resumed session override it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureSandboxDir,
  resolveSessionCwd,
  sandboxBaseDir,
  sandboxPathFor,
  sanitizeConversationId,
} from './sandbox';

let home: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sandbox-')));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('sandbox path derivation', () => {
  it('is deterministic and rooted under ~/.pi/desktop/sandbox/<id>', () => {
    const a = sandboxPathFor('conv-123', home);
    const b = sandboxPathFor('conv-123', home);
    expect(a).toBe(b);
    expect(a).toBe(path.join(home, '.pi', 'desktop', 'sandbox', 'conv-123'));
    expect(sandboxBaseDir(home)).toBe(path.join(home, '.pi', 'desktop', 'sandbox'));
  });

  it('derives distinct folders for distinct conversation ids', () => {
    expect(sandboxPathFor('a', home)).not.toBe(sandboxPathFor('b', home));
  });

  it('sanitizes ids so they cannot escape the base (no traversal / separators)', () => {
    // Separators collapse to '-' and leading dots are stripped, so the result
    // is always a single safe path segment (a middle '..' is just filename text).
    expect(sanitizeConversationId('../../etc')).toBe('-..-etc');
    expect(sanitizeConversationId('a/b/c')).toBe('a-b-c');
    // An id that is only dots/separators has nothing legal left → 'default'.
    expect(sanitizeConversationId('..')).toBe('default');
    expect(sanitizeConversationId('')).toBe('default');
    for (const evil of ['../../etc', 'a/b/c', '..\\..\\win', './x']) {
      const seg = sanitizeConversationId(evil);
      expect(seg).not.toContain('/');
      expect(seg).not.toContain('\\');
      expect(seg.startsWith('.')).toBe(false);
    }
    // A malicious id still resolves to a path *inside* the sandbox base.
    const escaped = sandboxPathFor('../../../../etc/passwd', home);
    const base = sandboxBaseDir(home);
    expect(escaped.startsWith(base + path.sep)).toBe(true);
    expect(path.dirname(escaped)).toBe(base);
  });

  it('does not touch disk when only deriving the path', () => {
    const p = sandboxPathFor('never-created', home);
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe('lazy sandbox creation', () => {
  it('creates the directory on demand and is idempotent', () => {
    const dir = sandboxPathFor('lazy', home);
    expect(fs.existsSync(dir)).toBe(false);

    const created = ensureSandboxDir('lazy', home);
    expect(created).toBe(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);

    // Second call must not throw (recursive mkdir) and returns the same path.
    expect(ensureSandboxDir('lazy', home)).toBe(dir);
  });
});

describe('resolveSessionCwd — projectless conversation lands in its sandbox', () => {
  it('returns (and lazily creates) the sandbox when no project / no session', () => {
    const cwd = resolveSessionCwd({ conversationId: 'fresh' }, home);
    expect(cwd).toBe(sandboxPathFor('fresh', home));
    // Created on demand so pi (which requires an existing cwd) actually roots here.
    expect(fs.existsSync(cwd as string)).toBe(true);
  });

  it('lets an explicit project cwd win over the sandbox (existing behavior)', () => {
    const project = path.join(home, 'my-project');
    fs.mkdirSync(project);
    expect(resolveSessionCwd({ cwd: project, conversationId: 'fresh' }, home)).toBe(project);
    // The sandbox was NOT created — the project path short-circuits.
    expect(fs.existsSync(sandboxPathFor('fresh', home))).toBe(false);
  });

  it('routes a MISSING (stale/deleted) project cwd to the sandbox, never HOME (file-spill fix)', () => {
    // The persisted active project no longer exists on disk (deleted /tmp dir).
    const deleted = path.join(home, 'pi-rt8-project'); // never created
    expect(fs.existsSync(deleted)).toBe(false);

    const cwd = resolveSessionCwd({ cwd: deleted, conversationId: 'wc-9' }, home);

    // NOT the dead project path, NOT HOME — the conversation's own sandbox.
    expect(cwd).toBe(sandboxPathFor('wc-9', home));
    expect(cwd).not.toBe(deleted);
    expect(cwd).not.toBe(home);
    expect(fs.statSync(cwd as string).isDirectory()).toBe(true);
  });

  it('prefers the sandbox over a resumed session when the requested cwd is missing', () => {
    // A missing cwd must not fall through to pi restoring that same dead cwd, so
    // even with a sessionPath present we root at the sandbox.
    const deleted = path.join(home, 'gone');
    const cwd = resolveSessionCwd(
      { cwd: deleted, sessionPath: '/some/session.jsonl', conversationId: 'wc-10' },
      home,
    );
    expect(cwd).toBe(sandboxPathFor('wc-10', home));
  });

  it('rejects a cwd that exists but is a FILE (not a directory) → sandbox', () => {
    const file = path.join(home, 'not-a-dir');
    fs.writeFileSync(file, 'x', 'utf8');
    const cwd = resolveSessionCwd({ cwd: file, conversationId: 'wc-11' }, home);
    expect(cwd).toBe(sandboxPathFor('wc-11', home));
  });

  it('defers to the resumed session (returns undefined) so pi restores its cwd', () => {
    const cwd = resolveSessionCwd(
      { sessionPath: '/some/session.jsonl', conversationId: 'fresh' },
      home,
    );
    expect(cwd).toBeUndefined();
    expect(fs.existsSync(sandboxPathFor('fresh', home))).toBe(false);
  });

  it('returns undefined when there is nothing to root at (pi HOME fallback)', () => {
    expect(resolveSessionCwd({}, home)).toBeUndefined();
  });

  it('integration: a projectless spawn hands pi the sandbox as its cwd', () => {
    // Mirrors pi-main's createBridge: cwd = resolveSessionCwd(req).
    const spawned: Array<{ cwd?: string }> = [];
    const createBridge = (req: { cwd?: string; sessionPath?: string; conversationId?: string }) => {
      spawned.push({ cwd: resolveSessionCwd(req, home) });
    };

    createBridge({ conversationId: 'wc-7' }); // no project selected
    expect(spawned[0]?.cwd).toBe(sandboxPathFor('wc-7', home));
    expect(fs.statSync(spawned[0]?.cwd as string).isDirectory()).toBe(true);
  });
});
