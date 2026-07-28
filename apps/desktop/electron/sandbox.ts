/**
 * Per-conversation sandbox folder (Wave D).
 *
 * When a conversation has NO project/working-folder selected, file operations
 * must not spill into a random cwd — historically pi fell back to the user's
 * HOME (see engine pi-bridge: `cwd = existsSync(opts.cwd) ? opts.cwd :
 * os.homedir()`), so a bare "make me a file" landed in ~. Instead each such
 * conversation gets a DEDICATED sandbox directory under
 * `~/.pi/desktop/sandbox/<conversationId>/`, created lazily on first use, and
 * pi is spawned rooted there. Because every downstream file surface keys off
 * pi's cwd — the built-in read/write/edit/ls tools (they resolve relative
 * paths against pi's process cwd), the harness + its subagents (they inherit
 * pi's cwd), the canvas file-tree (`fs:list-tree` root = session cwd), the
 * canvas live-editor write fence, and a new terminal's cwd (`pty:spawn` cwd =
 * session cwd) — rooting pi at the sandbox transparently points all of them at
 * it. Selecting a real project passes an explicit cwd and overrides this
 * (existing behavior).
 *
 * This module is Electron-free (node fs/os/path only) so it stays inside the
 * unit-testable electron seam (see vitest.config include note) and can be
 * driven with an injected HOME.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Root under which every conversation's private sandbox lives. Added as an
 * allowed write root in fs-handlers so the canvas editor can save into a
 * sandbox even before pi has recorded a session there. */
export function sandboxBaseDir(home: string = os.homedir()): string {
  return path.join(home, '.pi', 'desktop', 'sandbox');
}

/**
 * Reduce a conversation id to a single safe path segment: only
 * `[A-Za-z0-9._-]` survive, leading dots are stripped (no `.`/`..` traversal,
 * no separators that could escape the base), and it is length-capped. Empty /
 * all-illegal ids collapse to `default` so a folder always resolves.
 * Deterministic: same id → same segment.
 */
export function sanitizeConversationId(id: string): string {
  const cleaned = id
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.]+/, '')
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'default';
}

/** Deterministic absolute sandbox path for a conversation id (no fs touch). */
export function sandboxPathFor(conversationId: string, home: string = os.homedir()): string {
  return path.join(sandboxBaseDir(home), sanitizeConversationId(conversationId));
}

/** Lazily create (mkdir -p) and return the conversation's sandbox directory.
 * Idempotent — safe to call on every spawn. */
export function ensureSandboxDir(conversationId: string, home: string = os.homedir()): string {
  const dir = sandboxPathFor(conversationId, home);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * True when `p` IS the user's home directory (not merely inside it).
 *
 * HOME is never an acceptable working directory for an agent: a bare "make me a
 * file" drops it straight into `~`, and the sidebar's directory grouping then
 * invents a project literally called `~` that swallows every such chat (the
 * folder name is the cwd label's last segment). jedd asked for both to stop.
 * Trailing slashes are tolerated so `/Users/x/` and `/Users/x` both match.
 */
export function isHomeDir(p: string | undefined | null, home: string = os.homedir()): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  const strip = (s: string) => (s.length > 1 && s.endsWith(path.sep) ? s.slice(0, -1) : s);
  return path.resolve(strip(p)) === path.resolve(strip(home));
}

/**
 * The cwd a session was recorded under, from its own first line —
 * `{"type":"session",…,"cwd":"/Users/x"}`. Returns null when it cannot be read.
 *
 * From the FILE, not the directory name. pi also encodes the cwd into the
 * folder (`--Users-jedd-work--`) by replacing `/` with `-`, but that mapping is
 * lossy: it does not escape hyphens already in the path, so any real folder with
 * a `-` in its name decodes back wrong. One short read is cheap enough to do per
 * spawn and it is exact.
 */
export function cwdFromSessionPath(sessionPath: string): string | null {
  try {
    const fd = fs.openSync(sessionPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const line = buf.toString('utf8', 0, read).split('\n', 1)[0] ?? '';
      const parsed = JSON.parse(line) as { cwd?: unknown };
      return typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null; // unreadable / not JSON / truncated — treat as unknown
  }
}

/** True when `p` resolves to an existing directory on disk. */
function directoryExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The pi:start / pi:restart request shape this resolver reads. */
export interface SessionCwdRequest {
  /** Explicit working folder (an active project). Wins when present AND it still
   * exists on disk. */
  cwd?: string;
  /** Resuming an existing session — pi restores that session's own recorded
   * cwd, so we must NOT override it with a sandbox. */
  sessionPath?: string;
  /** Stable id of the conversation, used to derive its sandbox folder. */
  conversationId?: string;
}

/**
 * Resolve the cwd a pi child should be spawned in:
 *   1. an explicit project/working-folder cwd wins — but ONLY while it still
 *      EXISTS on disk;
 *   2. else when resuming a session (and no cwd was requested), defer to pi
 *      (returns undefined so the session's recorded cwd is restored);
 *   3. else (a fresh/projectless conversation, OR a project cwd that no longer
 *      exists) the conversation's dedicated sandbox, created on demand.
 * Returns undefined only when there is nothing to root at (no usable cwd, no
 * session, no conversation id) — pi then applies its own HOME fallback.
 *
 * The existence gate on (1) is the file-spill fix: a persisted-but-deleted
 * project path (e.g. `/tmp/pi-rt8-project` removed after a reboot) must NOT be
 * handed to pi, because pi's own resolver falls back to HOME for a missing cwd
 * (`existsSync(cwd) ? cwd : os.homedir()`) and the agent then writes files into
 * the user's HOME. A missing cwd instead falls through to the per-conversation
 * sandbox — NEVER HOME. We also skip the resume-defer branch when a cwd was
 * requested-but-missing, so pi is never left to restore that same dead cwd.
 */
export function resolveSessionCwd(
  req: SessionCwdRequest,
  home: string = os.homedir(),
): string | undefined {
  const cwdRequested = typeof req.cwd === 'string' && req.cwd.length > 0;
  // An explicit HOME is refused like a missing folder: nothing should ever root
  // an agent at `~`, however it was asked for.
  if (cwdRequested && !isHomeDir(req.cwd, home) && directoryExists(req.cwd as string)) {
    return req.cwd;
  }
  const resuming = !cwdRequested && typeof req.sessionPath === 'string' && req.sessionPath.length > 0;
  if (resuming) {
    // Defer to the session's own recorded cwd — UNLESS that cwd is HOME. Those
    // sessions exist (40 of them on this machine): anything that reached pi
    // without a usable cwd got pi's own `existsSync(cwd) ? cwd : os.homedir()`
    // fallback, and re-opening one would go on writing into `~` forever. Re-root
    // those at the conversation sandbox instead.
    const recorded = cwdFromSessionPath(req.sessionPath as string);
    if (!isHomeDir(recorded, home)) return undefined;
  }
  // No usable cwd anywhere. A conversation id gives this chat its own sandbox;
  // WITHOUT one we still must not return undefined, because pi's fallback for
  // "no cwd" is HOME — the exact thing this module exists to prevent. A shared
  // `default` sandbox is a poor working folder but it is not the user's home.
  return ensureSandboxDir(
    typeof req.conversationId === 'string' && req.conversationId.length > 0
      ? req.conversationId
      : 'default',
    home,
  );
}
