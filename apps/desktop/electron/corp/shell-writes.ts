/**
 * FILES WRITTEN THROUGH `bash` — seen, instead of invisible.
 *
 * The telemetry counted a file as written only when the `write`/`edit` TOOLS were
 * called. Run 19's manager wrote the entire product with
 *
 *     cat > converter.py << 'EOF'
 *     …
 *     EOF
 *
 * — 28 of its 34 tool calls — and `summary.json` recorded `files: []` for every
 * agent while a 4.7KB `converter.py` sat on disk. The run looked like nobody had
 * built anything. Every question worth asking of a transcript ("who owns this
 * file?", "did the manager write code?", "did anything change since the last
 * submission?") was answered wrongly, and the one structural regression of the
 * night was nearly missed because of it.
 *
 * A heredoc and a shell redirect are how people actually write files in a
 * terminal; treating them as anything other than a file write is the tooling
 * being precious about its own abstractions. So the common shapes are parsed and
 * reported exactly as if the write tool had been called.
 *
 * Deliberately conservative: it reports what it is SURE about. A path built from
 * a shell variable, or a python heredoc that opens a computed filename, is left
 * alone rather than guessed at — a wrong path in the ledger is worse than a
 * missing one, because it accuses the wrong agent.
 */

/** One file a shell command writes to. */
export interface ShellWrite {
  /** The path exactly as the command names it (relative to the agent's cwd). */
  readonly path: string;
  /** `>>` and python `'a'` mode — the file is extended, not replaced. */
  readonly append: boolean;
}

/** Strip one layer of quoting from a shell word. */
function unquote(word: string): string {
  const m = /^(['"])(.*)\1$/.exec(word);
  return m?.[2] ?? word;
}

/** Is this a path we are confident about? Rejects anything the shell would
 * expand — variables, globs, command substitution, `~` — because we cannot know
 * what those became. */
function isLiteralPath(p: string): boolean {
  if (p === '' || p.length > 400) return false;
  if (/[$`*?~]/.test(p)) return false;
  if (p === '/dev/null' || p.startsWith('/dev/')) return false;
  return true;
}

/** `> path`, `>> path`, `1> path`, and `tee [-a] path…`, ignoring `2>` and `&>`
 * (those are diagnostics, not products). */
function redirectWrites(command: string): ShellWrite[] {
  const out: ShellWrite[] = [];
  // A redirect not preceded by a digit other than 1, and not part of `>&`.
  const redirect = /(^|[^0-9&>])(1?>>?)\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g;
  for (const m of command.matchAll(redirect)) {
    const op = m[2] ?? '';
    const path = unquote(m[3] ?? '');
    if (isLiteralPath(path)) out.push({ path, append: op.includes('>>') });
  }
  const tee = /\btee\s+(-a\s+)?("[^"]+"|'[^']+'|[^\s;|&<>]+)/g;
  for (const m of command.matchAll(tee)) {
    const path = unquote(m[2] ?? '');
    if (isLiteralPath(path)) out.push({ path, append: m[1] !== undefined });
  }
  return out;
}

/** `open('path', 'w')` inside a python heredoc — jedd's other common shape:
 * `python3 << 'EOF'` that writes files from inside the script. */
function pythonWrites(command: string): ShellWrite[] {
  if (!/\bpython[0-9.]*\b/.test(command)) return [];
  const out: ShellWrite[] = [];
  const open = /\bopen\(\s*("[^"]+"|'[^']+')\s*,\s*("[^"]*"|'[^']*')/g;
  for (const m of command.matchAll(open)) {
    const path = unquote(m[1] ?? '');
    const mode = unquote(m[2] ?? '');
    if (!/[wax]/.test(mode)) continue; // read modes write nothing
    if (isLiteralPath(path)) out.push({ path, append: mode.includes('a') });
  }
  // `Path("x").write_text(...)` / `write_bytes` — the other idiom worth knowing.
  const pathlib = /\bPath\(\s*("[^"]+"|'[^']+')\s*\)\s*\.\s*write_(?:text|bytes)\b/g;
  for (const m of command.matchAll(pathlib)) {
    const path = unquote(m[1] ?? '');
    if (isLiteralPath(path)) out.push({ path, append: false });
  }
  return out;
}

/**
 * Every file this shell command writes, deduplicated, in first-seen order.
 * Never throws — a parser that explodes would take the whole activity stream
 * with it.
 */
export function shellWrites(command: string): ShellWrite[] {
  if (typeof command !== 'string' || command === '') return [];
  try {
    const seen = new Map<string, ShellWrite>();
    for (const w of [...redirectWrites(command), ...pythonWrites(command)]) {
      // A path written twice in one command is one write; a plain `>` anywhere
      // means the file was replaced, so truncation wins over append.
      const prior = seen.get(w.path);
      if (prior === undefined) seen.set(w.path, w);
      else if (!w.append && prior.append) seen.set(w.path, w);
    }
    return [...seen.values()];
  } catch {
    return [];
  }
}
