/**
 * Canonical on-disk locations for the source apps and for pi's own session
 * store. Pure POSIX path math (no node builtins), so this module stays
 * renderer-safe — the desktop renderer type-checks the importers source through
 * the barrel, so importers must not reach for `node:*`. macOS-first (v0.1
 * target); the Claude support dir is the `~/Library/Application Support`
 * location the installed app uses.
 */

/** Join POSIX path segments (single-separator, trims duplicate slashes). */
function join(...segments: string[]): string {
  return segments
    .map((s, i) => (i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, '')))
    .filter((s) => s.length > 0)
    .join('/');
}

export interface ClaudePaths {
  base: string;
  /** claude_desktop_config.json — the `mcpServers` block. */
  mcpConfig: string;
  /** config.json — carries `userThemeMode` (plus token blobs we never read). */
  themeConfig: string;
  /** window-state.json — last window bounds. */
  windowState: string;
}

export function claudePaths(home: string): ClaudePaths {
  const base = join(home, 'Library', 'Application Support', 'Claude');
  return {
    base,
    mcpConfig: join(base, 'claude_desktop_config.json'),
    themeConfig: join(base, 'config.json'),
    windowState: join(base, 'window-state.json'),
  };
}

export interface CodexPaths {
  base: string;
  config: string;
  sessionIndex: string;
  sessions: string;
  skills: string;
}

export function codexPaths(home: string): CodexPaths {
  const base = join(home, '.codex');
  return {
    base,
    config: join(base, 'config.toml'),
    sessionIndex: join(base, 'session_index.jsonl'),
    sessions: join(base, 'sessions'),
    skills: join(base, 'skills'),
  };
}

/**
 * Encode a cwd into pi's session-folder name, matching pi 0.68.1 on disk
 * (e.g. `/Users/jedd/Desktop` → `--Users-jedd-Desktop--`). pi treats the cwd as
 * if it had a trailing slash, so the encoded form is double-dashed on BOTH ends:
 * every `/` becomes `-`, then the whole thing is wrapped in one more `-…-`.
 * Verified against the live `~/.pi/agent/sessions/` layout; the fs-handlers
 * `decodeCwd` is the exact inverse.
 */
export function encodePiSessionFolder(cwd: string): string {
  const withSlash = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return `-${withSlash.replace(/\//g, '-')}-`;
}
