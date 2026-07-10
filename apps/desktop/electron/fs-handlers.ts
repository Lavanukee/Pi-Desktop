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
import type { FsInvokeMap, SessionSummary } from './ipc-contract';

const HOME = os.homedir();
const AGENT_DIR = path.join(HOME, '.pi', 'agent');
const SESSIONS_DIR = path.join(AGENT_DIR, 'sessions');

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

/** The fs channel implementations, spread into main.ts's registerIpcHandlers. */
export const fsHandlers: {
  [K in keyof FsInvokeMap]: (req: FsInvokeMap[K]['request']) => FsInvokeMap[K]['response'];
} = {
  'fs:list-files': (req) => listFiles(req.cwd ?? '', req.query ?? '', req.limit ?? 30),
  'fs:list-sessions': (req) => listAllSessions(req?.cwd),
  'fs:read-session': (req) => ({ text: readSession(req.file) }),
};
