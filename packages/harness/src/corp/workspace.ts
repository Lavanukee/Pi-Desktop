/**
 * Per-task WORKSPACE isolation (spec §7 execution, §9 isolated workspace) — the
 * fs seam engineers write their produced files through.
 *
 * Every dispatched engineer writes the file for its contract's `slot` to
 * `<workspace>/<slot>`. Slots are DISTINCT after the integrity sweep (sanitize.ts
 * de-collides them), so no two engineers ever target the same path — isolation is
 * structural, not enforced here. The workspace is a single per-task root directory
 * the whole run writes beneath.
 *
 * The seam ({@link WorkspaceFs}) is injected so dispatch is unit-testable with an
 * in-memory store; {@link makeNodeWorkspaceFs} is the real-disk impl (mkdir -p the
 * slot's parent, then write). `node:fs` is confined to THIS corp subpath — the
 * same discipline as persistence.ts, so the renderer barrel never pulls it into
 * the browser bundle.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The minimal fs surface dispatch needs to place a produced file. Injectable. */
export interface WorkspaceFs {
  /** Write `content` at an absolute `path`, creating any missing parent dirs. */
  readonly writeFile: (path: string, content: string) => void;
}

/** The default seam, backed by node:fs: mkdir -p the parent, then write utf8. */
export function makeNodeWorkspaceFs(): WorkspaceFs {
  return {
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    },
  };
}

/**
 * The READ side of the workspace seam (slice 5: assembly + verify). After dispatch
 * the workspace IS the integrated product, and the review pass has to READ it back:
 * {@link ./assemble.ts | buildProductManifest} reads each produced file to size it,
 * and {@link ./verify.ts | verifyProduct} lists + reads every file to check it.
 * Injected so both are unit-testable with an in-memory store; the same `node:fs`
 * confinement discipline as {@link WorkspaceFs} keeps disk access out of the
 * renderer bundle.
 */
export interface WorkspaceReadFs {
  /** Read the utf8 file at an absolute `path`; `undefined` if it does not exist. */
  readonly readFile: (path: string) => string | undefined;
  /** Every regular file beneath `root`, as absolute paths (recursive). */
  readonly listFiles: (root: string) => readonly string[];
}

/** The default read seam, backed by node:fs: a missing file reads as `undefined`
 * (never throws), and {@link WorkspaceReadFs.listFiles} walks `root` recursively. */
export function makeNodeWorkspaceReadFs(): WorkspaceReadFs {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    listFiles: (root) => walkFiles(root),
  };
}

/** Recursively collect the absolute paths of every regular file under `dir`.
 * Missing/unreadable directories contribute nothing (never throws). */
function walkFiles(dir: string): string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * The absolute path a contract slot resolves to inside a workspace root. The slot
 * is a project-relative injection point, so it is placed BENEATH `root` and can
 * never escape it: leading slashes, `.` and `..` segments are dropped before the
 * join (a malformed `../../etc/x` slot lands at `<root>/etc/x`, never outside).
 * Pure — no fs access.
 */
export function slotPath(root: string, slot: string): string {
  const parts = slot.split(/[/\\]+/).filter((p) => p !== '' && p !== '.' && p !== '..');
  return join(root, ...parts);
}

/**
 * Write a produced file for `slot` into the workspace `root` via the injected
 * `fs`, returning the absolute path written. Thin convenience the dispatcher uses;
 * the parent-directory creation is the seam's job (see {@link makeNodeWorkspaceFs}).
 */
export function writeSlot(root: string, slot: string, content: string, fs: WorkspaceFs): string {
  const path = slotPath(root, slot);
  fs.writeFile(path, content);
  return path;
}
