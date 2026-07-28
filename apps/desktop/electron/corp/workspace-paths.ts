/**
 * WHEN AN AGENT TURNS THE WORKSPACE PATH INTO A RELATIVE ONE.
 *
 * Measured twice, in two different shapes, both fatal:
 *
 *   run 9   cwd  …/scratchpad/mesh9/ws
 *           wrote `scratchpad/mesh9/ws/test_converter.py`
 *           landed …/ws/scratchpad/mesh9/ws/test_converter.py — parents missing,
 *           so the write FAILED and no file appeared anywhere.
 *
 *   run 11  cwd  /private/tmp/claude-501/<uuid>/scratchpad/mesh11/ws
 *           wrote `private/tmp/claude-501/<uuid>/scratchpad/mesh11/ws/src/cli.py`
 *           landed …/ws/private/tmp/…/ws/src/cli.py — a complete SHADOW COPY of
 *           the product, four levels down, invisible to the gate. The engineer
 *           then submitted `python3 run_tests.py` eight times and was refused
 *           eight times with "No such file or directory", because everything it
 *           had built was in the shadow and the real tree held three files.
 *
 * Both are one mistake: the model reads the absolute workspace path out of a
 * shell prompt or an `ls`, drops some leading part of it, and passes the rest to
 * a file tool that resolves relative paths against that very directory. It is not
 * a comprehension failure a prompt can fix — the prompt already says to use bare
 * relative paths, and it has said so since run 8.
 *
 * The rule below is exact rather than heuristic: a relative path whose LEADING
 * components are a SUFFIX of the workspace's own components is that mistake, and
 * nothing else. `.../a/b/ws` + `b/ws/main.py` means `main.py`. Two components
 * minimum, so a project that legitimately contains a directory named like the
 * workspace's last folder is untouched.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/** Split a path into components, dropping the root and any empties. */
function parts(p: string): string[] {
  return p.split(path.sep).filter((c) => c !== '');
}

/** Fewest leading components that may be treated as a mangled prefix. One would
 * strip a legitimate `src/x.py` under a workspace that happens to end in `src`. */
const MIN_PREFIX = 2;

/**
 * The path the agent MEANT, when it re-stated part of the workspace path as a
 * relative one. Returns `undefined` when the path is fine as given — which is the
 * overwhelmingly common case, so this must be cheap and must not guess.
 */
export function unmanglePath(cwd: string, rel: string): string | undefined {
  if (path.isAbsolute(rel)) return undefined;
  const cwdParts = parts(path.resolve(cwd));
  const relParts = parts(rel);
  const most = Math.min(cwdParts.length, relParts.length - 1);
  for (let k = most; k >= MIN_PREFIX; k--) {
    const head = relParts.slice(0, k);
    const tail = cwdParts.slice(-k);
    if (head.every((c, i) => c === tail[i])) {
      const rest = relParts.slice(k);
      if (rest.length > 0) return rest.join(path.sep);
    }
  }
  return undefined;
}

/**
 * Directories inside `cwd` that are a re-stated copy of `cwd` itself — the roots
 * of any shadow tree. Cheap: at most one `existsSync` per suffix length.
 */
export function shadowRoots(cwd: string): string[] {
  const abs = path.resolve(cwd);
  const cwdParts = parts(abs);
  const found: string[] = [];
  for (let k = cwdParts.length; k >= MIN_PREFIX; k--) {
    const candidate = path.join(abs, ...cwdParts.slice(-k));
    if (existsSync(candidate) && statSync(candidate).isDirectory()) found.push(candidate);
  }
  return found;
}

/** One file moved out of a shadow tree. */
export interface RepairedFile {
  readonly from: string;
  readonly to: string;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      if (statSync(full).isDirectory()) walkFiles(full, out);
      else out.push(full);
    } catch {
      // a file that vanished mid-walk is not worth failing over
    }
  }
  return out;
}

/**
 * Move everything out of a shadow tree into the place the agent meant, so the
 * gate, `submit_work` and every other agent see one product instead of two.
 *
 * NON-DESTRUCTIVE ON PURPOSE. A file whose destination already exists is left
 * where it is rather than overwritten: the shadow copy is usually the newer
 * intent, but "usually" is not a good enough reason to destroy work at 4am with
 * nobody awake. The real tree wins, the orphan stays readable, and the run
 * reports both. Never throws.
 */
export function repairShadowTree(cwd: string): RepairedFile[] {
  const abs = path.resolve(cwd);
  const moved: RepairedFile[] = [];
  for (const root of shadowRoots(abs)) {
    for (const file of walkFiles(root)) {
      const rel = path.relative(root, file);
      const dest = path.join(abs, rel);
      if (existsSync(dest)) continue;
      try {
        mkdirSync(path.dirname(dest), { recursive: true });
        renameSync(file, dest);
        moved.push({ from: path.relative(abs, file), to: rel });
      } catch {
        // a move that fails leaves the shadow copy in place — still readable
      }
    }
  }
  return moved;
}

/** What the team is told when files were rescued, so the next `ls` is not a shock. */
export function repairNote(moved: readonly RepairedFile[]): string {
  if (moved.length === 0) return '';
  const lines = moved.slice(0, 8).map((m) => `  ${m.from}  ->  ${m.to}`);
  const more = moved.length > lines.length ? `\n  …and ${moved.length - lines.length} more` : '';
  return [
    `--- FILES MOVED INTO PLACE ---`,
    `Some work was written to a path that repeated the workspace's own folders, so`,
    `it landed in a nested copy of the workspace where nothing could run it. It has`,
    `been moved to where it belongs:`,
    ...lines,
    more,
    `Use BARE relative paths — \`cli.py\`, \`src/cli.py\`. Never paste the workspace's`,
    `own directory path into a file tool; you are already inside it.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}
