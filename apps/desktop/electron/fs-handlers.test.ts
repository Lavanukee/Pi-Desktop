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
import { writeFileFenced } from './fs-handlers';

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
