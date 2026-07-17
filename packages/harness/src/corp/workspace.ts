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

import { mkdirSync, writeFileSync } from 'node:fs';
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
