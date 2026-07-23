/**
 * Read-only filesystem IPC handlers backing the composer @-mention picker and
 * the session sidebar. Everything here is read-only by design: session
 * mutations always go through the pi RPC bridge so the app never drifts from
 * pi's own on-disk format. Logic (cwd encode/decode double-dash quirk, session
 * summary parsing, fuzzy listFiles) is ported from RemotePi's fs-handlers.ts.
 *
 * Registered in main.ts via registerIpcHandlers with the same trusted-sender
 * gate as the other app channels — these read arbitrary project files, so only
 * the main frame of an app-created window may reach them.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FsInvokeMap, FsTreeNode, SessionSummary } from './ipc-contract';
import { sandboxBaseDir } from './sandbox';

const HOME = os.homedir();
const AGENT_DIR = path.join(HOME, '.pi', 'agent');
const SESSIONS_DIR = path.join(AGENT_DIR, 'sessions');
const PROJECTS_PATH = path.join(HOME, '.pi', 'desktop', 'projects.json');

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Inverse of pi's cwd→folder encoding; strips the trailing slash so it matches
 * the cwd recorded inside session JSONL (RemotePi's double-dash quirk). */
function decodeCwd(folder: string): string {
  if (!folder.startsWith('-') || !folder.endsWith('-')) return folder;
  let s = folder.slice(1, -1).replace(/-/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function normalizeCwd(p: string): string {
  if (!p) return p;
  let s = p.trim();
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function readSessionSummary(file: string): SessionSummary | null {
  const st = statSafe(file);
  if (st === null) return null;
  const txt = safeRead(file);
  if (txt === null) return null;

  let id = '';
  let cwd = '';
  let startedAt = '';
  let messageCount = 0;
  let firstUserText: string | null = null;

  for (const line of txt.split('\n')) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === 'session') {
      id = typeof obj.id === 'string' ? obj.id : '';
      cwd = typeof obj.cwd === 'string' ? obj.cwd : '';
      startedAt = typeof obj.timestamp === 'string' ? obj.timestamp : '';
      continue;
    }
    // Newer sessions wrap messages: { type: 'message', message: { role, content } }.
    const msg = (obj.type === 'message' && obj.message !== undefined ? obj.message : obj) as Record<
      string,
      unknown
    >;
    const role = (msg.role ?? obj.role) as string | undefined;
    if (role === 'user') {
      messageCount++;
      if (firstUserText === null) {
        const c = msg.content ?? obj.content;
        if (typeof c === 'string') firstUserText = c;
        else if (Array.isArray(c)) {
          const first = c.find((x) => (x as { type?: string })?.type === 'text') as
            | { text?: string }
            | undefined;
          if (typeof first?.text === 'string') firstUserText = first.text;
        }
      }
    } else if (role === 'assistant') {
      messageCount++;
    }
  }

  const title = firstUserText
    ? firstUserText.slice(0, 80).replace(/\s+/g, ' ').trim()
    : 'Untitled session';

  return {
    file,
    id,
    cwd,
    cwdLabel: cwd.replace(HOME, '~'),
    startedAt: startedAt || st.birthtime.toISOString(),
    modifiedAt: st.mtime.toISOString(),
    messageCount,
    firstUserText,
    title,
  };
}

function listAllSessions(filterCwd?: string): SessionSummary[] {
  const wantCwd = filterCwd ? normalizeCwd(filterCwd) : undefined;
  const out: SessionSummary[] = [];
  for (const p of listDir(SESSIONS_DIR)) {
    const dir = path.join(SESSIONS_DIR, p);
    if (statSafe(dir)?.isDirectory() !== true) continue;
    for (const f of listDir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const summary = readSessionSummary(path.join(dir, f));
      if (summary === null) continue;
      if (!summary.cwd) summary.cwd = decodeCwd(p);
      summary.cwd = normalizeCwd(summary.cwd);
      if (!summary.cwdLabel) summary.cwdLabel = summary.cwd.replace(HOME, '~');
      if (wantCwd !== undefined && summary.cwd !== wantCwd) continue;
      out.push(summary);
    }
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1;
  const base = haystack.split('/').pop() ?? haystack;
  if (base.startsWith(needle)) return 100;
  if (base.includes(needle)) return 80;
  if (haystack.includes(needle)) return 60;
  let i = 0;
  for (const c of haystack) {
    if (c === needle[i]) i++;
    if (i === needle.length) break;
  }
  return i === needle.length ? 30 + (needle.length / haystack.length) * 20 : 0;
}

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'out',
  '.next',
  '.turbo',
  '.vscode',
  '.idea',
  'build',
  '.pi',
  'Library',
  '.cache',
  '.npm',
]);

/** Fuzzy file listing for the composer @-mention autocomplete. Hard depth/count
 * caps keep this from ever recursing into node_modules et al. */
function listFiles(cwd: string, query: string, limit = 30): Array<{ path: string; rel: string }> {
  const root = cwd && statSafe(cwd)?.isDirectory() === true ? cwd : HOME;
  const out: Array<{ path: string; rel: string; score: number }> = [];
  const q = query.toLowerCase();

  function walk(dir: string, depth: number): void {
    if (depth > 3 || out.length > 600) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        const score = fuzzyScore(rel.toLowerCase(), q);
        if (q === '' || score > 0) out.push({ path: full, rel, score });
      }
    }
  }
  walk(root, 0);
  out.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
  return out.slice(0, limit).map(({ path: p, rel }) => ({ path: p, rel }));
}

/** Reads a session JSONL, but only within the pi sessions dir — the renderer is
 * trusted, yet this is the one channel that returns raw file contents by path,
 * so it is fenced to where sessions actually live. */
function readSession(file: string): string | null {
  const resolved = path.resolve(file);
  if (resolved !== SESSIONS_DIR && !resolved.startsWith(SESSIONS_DIR + path.sep)) return null;
  return safeRead(resolved);
}

/** Delete a session JSONL, fenced to the sessions dir (the sidebar "Delete chat"
 * action). Only `.jsonl` files under SESSIONS_DIR are eligible. */
function deleteSession(file: string): { ok: boolean; error?: string } {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(SESSIONS_DIR + path.sep) || !resolved.endsWith('.jsonl')) {
    return { ok: false, error: 'refused: not a session file' };
  }
  try {
    fs.rmSync(resolved, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Bounded directory tree for the canvas file operation bar's file-tree panel.
 * Same hard caps + skip-list as `listFiles` so it never recurses into
 * node_modules et al: depth ≤ `maxDepth` (default 3), ≤ TREE_MAX_ENTRIES nodes,
 * directories first then files, each level alphabetized. Dotfiles are skipped.
 */
const TREE_MAX_ENTRIES = 2000;
const TREE_MAX_DEPTH = 4;

function listTree(root: string, maxDepth: number): FsTreeNode[] {
  const base = statSafe(root)?.isDirectory() === true ? root : path.dirname(root);
  let count = 0;

  function walk(dir: string, depth: number): FsTreeNode[] {
    if (depth > maxDepth || count > TREE_MAX_ENTRIES) return [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: FsTreeNode[] = [];
    const files: FsTreeNode[] = [];
    for (const e of entries) {
      if (count > TREE_MAX_ENTRIES) break;
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      count++;
      if (e.isDirectory()) {
        dirs.push({ name: e.name, path: full, kind: 'dir', children: walk(full, depth + 1) });
      } else if (e.isFile()) {
        files.push({ name: e.name, path: full, kind: 'file' });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  if (statSafe(base)?.isDirectory() !== true) return [];
  return walk(base, 0);
}

/**
 * UTF-8 contents of a single file for the live canvas file surface. Size-capped
 * (default 512 KiB) so a runaway write never streams a huge payload into the
 * renderer, and flagged `binary` when a NUL byte appears in the head (so the app
 * shows a note instead of mojibake). No path fence: the renderer is trusted and
 * the model writes files anywhere in the project.
 */
const READ_FILE_DEFAULT_MAX = 512 * 1024;

function readFileBounded(
  file: string,
  maxBytes: number,
): { text: string | null; truncated: boolean; tooLarge: boolean; binary: boolean; bytes: number } {
  const resolved = path.resolve(file);
  const st = statSafe(resolved);
  if (st === null || !st.isFile()) {
    return { text: null, truncated: false, tooLarge: false, binary: false, bytes: 0 };
  }
  const cap = Math.max(0, maxBytes);
  const tooLarge = st.size > cap;
  let fd: number | null = null;
  try {
    fd = fs.openSync(resolved, 'r');
    const length = Math.min(st.size, cap);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    const head = buffer.subarray(0, Math.min(read, 8192));
    const binary = head.includes(0);
    return {
      text: binary ? null : buffer.subarray(0, read).toString('utf8'),
      truncated: tooLarge,
      tooLarge,
      binary,
      bytes: st.size,
    };
  } catch {
    return { text: null, truncated: false, tooLarge: false, binary: false, bytes: st.size };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * WRITE fence (round-9 live canvas editing). Unlike the read channels — where the
 * renderer is trusted and reads anywhere — writing is fenced to the roots the app
 * actually works in: the registered project folders, every cwd pi has a session
 * for, and pi's own agent/session data dir. A path outside all of them is refused
 * (belt-and-braces against a traversal/typo clobbering a system file). Payloads
 * are size-capped and a path that already resolves to a directory is refused.
 */
const WRITE_FILE_MAX = 5 * 1024 * 1024;

function normalizeRoot(p: string): string {
  const abs = path.resolve(p.trim());
  return abs.length > 1 && abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

/** Absolute paths of the registered project working folders (projects.json). */
function projectRoots(): string[] {
  const raw = safeRead(PROJECTS_PATH);
  if (raw === null) return [];
  try {
    const doc = JSON.parse(raw) as { projects?: Array<{ path?: unknown }> };
    return (doc.projects ?? [])
      .map((p) => p?.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

/** Every cwd pi has a session directory for (decoded from the folder name). */
function sessionCwdRoots(): string[] {
  const out: string[] = [];
  for (const p of listDir(SESSIONS_DIR)) {
    if (statSafe(path.join(SESSIONS_DIR, p))?.isDirectory() !== true) continue;
    const cwd = decodeCwd(p);
    if (cwd && cwd !== '/') out.push(cwd);
  }
  return out;
}

/** The union of allowed write roots, normalized + de-duplicated. */
function allowedWriteRoots(): string[] {
  const roots = new Set<string>();
  for (const p of projectRoots()) roots.add(normalizeRoot(p));
  for (const p of sessionCwdRoots()) roots.add(normalizeRoot(p));
  roots.add(normalizeRoot(AGENT_DIR));
  // Per-conversation sandbox base (Wave D): pi is spawned rooted at
  // `~/.pi/desktop/sandbox/<conversationId>/` when no project is selected, so
  // the canvas live-editor must be able to save there too — even before pi has
  // recorded a session for that cwd (which is when it would show up via
  // sessionCwdRoots). Allowing the base covers every conversation's sandbox;
  // the realpath/O_NOFOLLOW checks below still fence out any symlink escape.
  roots.add(normalizeRoot(sandboxBaseDir()));
  return [...roots];
}

export { allowedWriteRoots };

/** True when `target` is `root` itself or nested under it. */
function isUnderRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolve `p` to a real (symlink-free) absolute path WITHOUT following a symlink
 * on the final component and WITHOUT requiring the target to exist yet.
 *
 * `path.resolve` is purely lexical, so a symlink that sits lexically under a
 * root but points outside would pass {@link isUnderRoot} while `writeFileSync`
 * silently follows it — an arbitrary-file-write escape. We instead realpath the
 * NEAREST EXISTING ANCESTOR directory (the file, and possibly some parent dirs,
 * may not exist yet) so every symlink in the existing portion of the path is
 * collapsed, then re-append the not-yet-existing trailing segments. Returns
 * `null` only when nothing on the path resolves (should never happen — `/`
 * always does).
 */
function realResolve(p: string): string | null {
  const abs = path.resolve(p);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null; // reached the filesystem root; unresolvable
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

function writeFileFenced(
  file: string,
  content: string,
  roots: string[] = allowedWriteRoots(),
): { ok: boolean; bytes?: number; error?: string } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > WRITE_FILE_MAX) return { ok: false, error: 'File exceeds the write size limit' };

  // Collapse symlinks in the existing portion of the path BEFORE fencing, so a
  // symlink lexically under a root but pointing outside can't defeat the fence.
  const resolved = realResolve(file);
  if (resolved === null) return { ok: false, error: 'Path could not be resolved' };
  // Compare in realpath space on BOTH sides. `resolved` collapses symlinks, so the
  // allowed roots must too — otherwise a project/session dir that lives under a
  // symlinked path (macOS /tmp -> /private/tmp, /var/folders temp dirs, or a
  // symlinked working folder) would wrongly reject legit in-root writes. A symlink
  // ESCAPE still fails: the target's realpath lands outside every root's realpath.
  const realRoots = roots.map((root) => realResolve(root) ?? normalizeRoot(root));
  if (!realRoots.some((root) => isUnderRoot(root, resolved))) {
    return { ok: false, error: 'Path is outside an allowed project or session folder' };
  }

  // Defense in depth: refuse a final component that already exists as a symlink
  // (points elsewhere) or a directory (overwriting a dir is never a file write).
  const lst = lstatSafe(resolved);
  if (lst?.isSymbolicLink() === true) return { ok: false, error: 'Path is a symlink' };
  if (lst?.isDirectory() === true) return { ok: false, error: 'Path is a directory' };

  const parent = path.dirname(resolved);
  let fd: number | null = null;
  try {
    fs.mkdirSync(parent, { recursive: true });
    // Re-realpath the parent now that it exists: mkdirSync(recursive) will happily
    // descend THROUGH a symlinked intermediate dir, so re-check the real parent
    // stays inside the fence (catches a symlinked dir swapped in mid-flight).
    const realParent = fs.realpathSync(parent);
    if (!realRoots.some((root) => isUnderRoot(root, realParent))) {
      return { ok: false, error: 'Path is outside an allowed project or session folder' };
    }
    const finalPath = path.join(realParent, path.basename(resolved));
    // O_NOFOLLOW makes the open FAIL (ELOOP) rather than follow a symlink at the
    // final component. Open WITHOUT O_TRUNC so a target we go on to refuse (a
    // hardlink, below) is never truncated before the check.
    fd = fs.openSync(
      finalPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      0o644,
    );
    // O_NOFOLLOW stops symlinks but NOT hardlinks (a hardlink's realpath is
    // itself). Refuse a multiply-linked file so a hardlink planted inside a root
    // can't write through to an out-of-root inode; and confirm the opened fd is
    // still the inode we fenced (residual-TOCTOU belt-and-braces).
    const opened = fs.fstatSync(fd);
    if (opened.nlink > 1) return { ok: false, error: 'Path is a hard link' };
    const named = lstatSafe(finalPath);
    if (named !== null && (named.dev !== opened.dev || named.ino !== opened.ino)) {
      return { ok: false, error: 'Path changed during write' };
    }
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, 'utf8');
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, error: (error as { message?: string })?.message ?? String(error) };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

export { writeFileFenced };

/** The fs channel implementations, spread into main.ts's registerIpcHandlers. */
export const fsHandlers: {
  [K in keyof FsInvokeMap]: (req: FsInvokeMap[K]['request']) => FsInvokeMap[K]['response'];
} = {
  'fs:list-files': (req) => listFiles(req.cwd ?? '', req.query ?? '', req.limit ?? 30),
  'fs:list-sessions': (req) => listAllSessions(req?.cwd),
  'fs:read-session': (req) => ({ text: readSession(req.file) }),
  'fs:list-tree': (req) => ({
    root: req.root,
    tree: listTree(req.root, Math.min(req.depth ?? 3, TREE_MAX_DEPTH)),
  }),
  'fs:read-file': (req) => readFileBounded(req.path, req.maxBytes ?? READ_FILE_DEFAULT_MAX),
  'fs:write-file': (req) => writeFileFenced(req.path, req.content),
  'fs:delete-session': (req) => deleteSession(req.file),
};
