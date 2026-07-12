/**
 * Round-9 SB-1 regression: the fs:write-file fence must resolve symlinks BEFORE
 * enforcing the allowed-root boundary, so a symlink that sits lexically under a
 * root but points OUTSIDE it can never be used to write an arbitrary system file
 * (e.g. ~/.ssh/authorized_keys) via the live canvas editor.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedWriteRoots, writeFileFenced } from './fs-handlers';
import { sandboxBaseDir } from './sandbox';

let root: string;
let outside: string;

beforeEach(() => {
  // realpathSync the sandbox up front: on macOS os.tmpdir() is itself a symlink
  // (/var → /private/var), and the fence canonicalizes paths — so the allowed
  // root we pass must already be canonical or a legit write would read as escape.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fence-')));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('writeFileFenced — symlink escape (SB-1)', () => {
  it('refuses a write through a symlink that points outside the allowed root', () => {
    const secret = path.join(outside, 'authorized_keys');
    fs.writeFileSync(secret, 'ORIGINAL', 'utf8');
    // The model (via the canvas PTY) drops a symlink lexically inside the root…
    const evil = path.join(root, 'evil');
    fs.symlinkSync(secret, evil);

    // …then tries to "save" it. path.resolve(evil) is lexically under root, so a
    // lexical-only fence would pass and writeFileSync would follow the link.
    const res = writeFileFenced(evil, 'PWNED', [root]);

    expect(res.ok).toBe(false);
    // The out-of-fence file was NOT written through.
    expect(fs.readFileSync(secret, 'utf8')).toBe('ORIGINAL');
  });

  it('refuses a write through a symlinked intermediate directory', () => {
    // A symlinked *directory* under the root pointing outside must not let a
    // nested write escape the fence.
    const linkDir = path.join(root, 'linkdir');
    fs.symlinkSync(outside, linkDir);
    const target = path.join(linkDir, 'planted.txt');

    const res = writeFileFenced(target, 'PWNED', [root]);

    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
  });

  it('still allows a normal write to a new file inside the root (incl. new dirs)', () => {
    const dest = path.join(root, 'src', 'note.md');
    const res = writeFileFenced(dest, 'hello', [root]);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello');
  });

  it('rejects a path entirely outside every allowed root', () => {
    const res = writeFileFenced(path.join(outside, 'x.txt'), 'nope', [root]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside an allowed/i);
  });

  it('rejects overwriting an existing directory', () => {
    fs.mkdirSync(path.join(root, 'adir'));
    const res = writeFileFenced(path.join(root, 'adir'), 'x', [root]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/directory/i);
  });

  it('rejects a payload over the size limit before touching disk', () => {
    const big = 'a'.repeat(5 * 1024 * 1024 + 1);
    const res = writeFileFenced(path.join(root, 'big.txt'), big, [root]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/size limit/i);
    expect(fs.existsSync(path.join(root, 'big.txt'))).toBe(false);
  });
});

describe('writeFileFenced — per-conversation sandbox (Wave D)', () => {
  it('allows a canvas-editor save inside a conversation sandbox and still fences escapes', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sbx-')));
    const sandboxBase = path.join(base, '.pi', 'desktop', 'sandbox');
    fs.mkdirSync(sandboxBase, { recursive: true });
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    try {
      // A file the model would write in its projectless sandbox — including a
      // not-yet-existing conversation subdir — is allowed under the base root.
      const dest = path.join(sandboxBase, 'conv-abc', 'note.md');
      const ok = writeFileFenced(dest, 'hi from the sandbox', [sandboxBase]);
      expect(ok.ok).toBe(true);
      expect(fs.readFileSync(dest, 'utf8')).toBe('hi from the sandbox');

      // The realpath/O_NOFOLLOW fence still holds: a symlink planted in the
      // sandbox that points outside it cannot be written through.
      const secret = path.join(outside, 'secret');
      fs.writeFileSync(secret, 'ORIGINAL', 'utf8');
      const evil = path.join(sandboxBase, 'evil');
      fs.symlinkSync(secret, evil);
      const escapeRes = writeFileFenced(evil, 'PWNED', [sandboxBase]);
      expect(escapeRes.ok).toBe(false);
      expect(fs.readFileSync(secret, 'utf8')).toBe('ORIGINAL');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('includes the sandbox base among the default allowed write roots', () => {
    // So a canvas save into a projectless conversation sandbox passes the fence
    // even before pi has recorded a session at that cwd (sessionCwdRoots).
    expect(allowedWriteRoots()).toContain(sandboxBaseDir());
  });
});
