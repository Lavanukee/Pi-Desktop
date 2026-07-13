/**
 * Sandbox-fenced file tools (blind-test round-2 #2 — the FILE-SPILL root cause).
 *
 * ROOT CAUSE. Round-1 rooted the pi child's *process* cwd at the per-conversation
 * sandbox (`~/.pi/desktop/sandbox/<id>/`), verified with lsof. That is NOT enough:
 * pi's built-in `write`/`edit`/`read`/`ls` tools each bake in a `cwd` at
 * construction (`createXToolDefinition(cwd)`), then resolve a RELATIVE path
 * argument with `resolveToCwd(path, cwd)` — and in the desktop's RPC/`new_session`
 * flow that baked cwd can drift to the user's HOME, so a bare
 * `write {path:"file1.txt"}` lands in `/Users/<you>/file1.txt` instead of the
 * sandbox. Re-pointing the process cwd cannot fix a cwd that was captured
 * elsewhere.
 *
 * FIX. We register OUR OWN `write`/`edit`/`read`/`ls` tools with the SAME names.
 * pi's agent-session merges extension-registered tools OVER the built-ins by name
 * (`_refreshToolRegistry`: built-ins first, then extension tools `set()` on top),
 * so ours win. Each wrapper:
 *   1. resolves a relative path against a WORKSPACE ROOT we control — the
 *      env hint the desktop publishes at spawn, else pi's per-session `ctx.cwd`,
 *      else `process.cwd()` — and NEVER the bare HOME dir (a HOME candidate is
 *      skipped and, if nothing else is valid, a dedicated fallback sandbox dir is
 *      used), and
 *   2. for the MUTATING tools (`write`, `edit`) applies a write fence: the
 *      resolved absolute path must sit inside an allowed root (the workspace root
 *      or the sandbox base) — a `~/…`, `/etc/…`, or `../../…` escape is refused
 *      with an actionable error the model can recover from.
 * `read`/`ls` are only re-rooted (a read never spills a file), so the model can
 * still read an absolute path it was handed.
 *
 * The heavy lifting (actual fs writes, edit hunk matching, read truncation, ls
 * formatting + rendering) is delegated to pi's own tool `execute`, constructed
 * with our resolved root and handed an already-absolute path — so behavior +
 * UI stay identical to the built-ins, we only correct WHERE relative paths land
 * and fence escapes.
 *
 * Gated on `PI_DESKTOP_FS_FENCE=1` (the desktop sets it on every spawn) so a
 * plain CLI `pi` user of this extension keeps the unfenced built-ins.
 *
 * Electron-free (node fs/os/path only) so it stays unit-testable in the harness
 * package.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type { Static, TSchema } from '@sinclair/typebox';

/** Env gate: the desktop sets this on every pi spawn (pi-main buildPiEnv). */
export const FS_FENCE_ENV = 'PI_DESKTOP_FS_FENCE';
/** Env hint carrying the resolved sandbox/project cwd the desktop spawned pi at. */
export const WORKSPACE_ROOT_ENV = 'PI_DESKTOP_WORKSPACE_ROOT';

/** Root under which every conversation's private sandbox lives (mirrors
 * electron/sandbox.ts `sandboxBaseDir`; kept local so this stays electron-free). */
export function sandboxBaseDir(home: string = os.homedir()): string {
  return path.join(home, '.pi', 'desktop', 'sandbox');
}

/** Strip a trailing separator so root/prefix comparisons are exact. */
function normalizeRoot(p: string): string {
  const abs = path.resolve(p.trim());
  return abs.length > 1 && abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Expand a raw path argument the way pi's `resolveToCwd`/`expandPath` do — drop a
 * leading `@`, expand `~`/`~/…` to HOME — WITHOUT joining to a cwd yet, so the
 * caller can decide the base. Returns an absolute path unchanged.
 */
function expandUserPath(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('@')) s = s.slice(1);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/**
 * Resolve `raw` against `root`: absolute (or `~`-expanded to absolute) paths pass
 * through (still normalized so `..` segments collapse); a relative path is joined
 * to the workspace root — NEVER to HOME. This is the load-bearing fix for the
 * reported bug: `resolveWorkspacePath("file1.txt", sandbox)` → `<sandbox>/file1.txt`.
 */
export function resolveWorkspacePath(raw: string, root: string): string {
  const expanded = expandUserPath(raw);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

/** True when `abs` is `root` itself or nested under it. Roots must be normalized. */
export function isInsideRoots(abs: string, roots: readonly string[]): boolean {
  const target = normalizeRoot(abs);
  return roots.some((root) => target === root || target.startsWith(root + path.sep));
}

/**
 * Choose the workspace root a projectless/absolute-free file op resolves against.
 * Priority: the explicit env hint the desktop publishes, then pi's per-session
 * `ctx.cwd`, then the process cwd — each accepted only when it is an existing dir
 * that is NOT the bare HOME dir. When everything collapses to HOME (or nothing is
 * valid) a dedicated fallback sandbox dir is used, so a bare `write foo.txt` can
 * never land in HOME even if pi handed us a HOME cwd.
 */
export function resolveWorkspaceRoot(
  ctxCwd: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const homeRoot = normalizeRoot(home);
  const candidates = [env[WORKSPACE_ROOT_ENV], ctxCwd, process.cwd()];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const normalized = normalizeRoot(candidate);
    if (normalized === homeRoot) continue; // never root file ops at bare HOME
    if (isDir(normalized)) return normalized;
  }
  const fallback = path.join(sandboxBaseDir(home), '_fallback');
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
    // Best effort — if even this fails the caller still gets a non-HOME path.
  }
  return normalizeRoot(fallback);
}

/** The allowed write roots for a resolved workspace root: the root itself plus the
 * per-conversation sandbox base (so a sandbox write is always permitted). */
export function allowedWriteRoots(root: string, home: string = os.homedir()): string[] {
  return [normalizeRoot(root), normalizeRoot(sandboxBaseDir(home))];
}

/** A ToolDefinition with the default (widest) generics — what `registerTool`
 * accepts, and what pi's `createXToolDefinition` factories widen to. */
type AnyToolDef = ToolDefinition;

/** Read the `path` field off raw tool args (write/edit/read use `path`, ls omits). */
function argPath(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined;
  const value = (params as { path?: unknown }).path;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Wrap one pi tool definition so its relative paths resolve against the live
 * workspace root and (when `fence`) escapes are refused. `getRoot` is evaluated
 * per-call from `ctx` so a resumed/switched session's cwd is honored — the tool
 * is registered once but the root is never stale.
 *
 * Only the model-facing fields are carried over (name/description/schema +
 * execute); pi's TUI `renderCall`/`renderResult` are intentionally dropped — the
 * desktop renders tool rows itself and RPC mode never invokes them, and keeping
 * them would fight TypeBox generic variance for no runtime benefit.
 */
function fenceTool<S extends TSchema, D>(
  base: ToolDefinition<S, D>,
  fence: boolean,
  getRoot: (ctx: ExtensionContext) => string,
  home: string = os.homedir(),
): AnyToolDef {
  const wrapped: AnyToolDef = {
    name: base.name,
    label: base.label,
    description: base.description,
    ...(base.promptSnippet !== undefined ? { promptSnippet: base.promptSnippet } : {}),
    ...(base.promptGuidelines !== undefined ? { promptGuidelines: base.promptGuidelines } : {}),
    parameters: base.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const root = getRoot(ctx);
      const raw = argPath(params);
      // ls with no `path` → the built-in defaults to "."; make that "." resolve
      // against OUR root by passing the root explicitly.
      const abs = raw === undefined ? root : resolveWorkspacePath(raw, root);
      if (raw !== undefined && fence && !isInsideRoots(abs, allowedWriteRoots(root, home))) {
        throw new Error(
          `Refusing to ${base.name} outside the workspace: "${raw}" resolves to ${abs}. ` +
            `Write inside the working folder (${root}) — use a relative path like ` +
            `"${path.basename(abs) || 'file.txt'}" or an absolute path under it.`,
        );
      }
      // Hand pi an already-absolute path so its own resolveToCwd is a passthrough
      // and it writes/reads EXACTLY where we fenced.
      const next = { ...(params as Record<string, unknown>), path: abs } as unknown as Static<S>;
      return base.execute(toolCallId, next, signal, onUpdate as never, ctx);
    },
  };
  return wrapped;
}

export interface SandboxFsOptions {
  /** Override the workspace-root resolver (tests). Default: {@link resolveWorkspaceRoot}. */
  readonly getRoot?: (ctx: ExtensionContext) => string;
  /** Injected HOME (tests). */
  readonly home?: string;
}

/**
 * Build the four fenced tool definitions (`write`, `edit`, `read`, `ls`). `write`
 * and `edit` are fenced (mutations); `read` and `ls` are only re-rooted. Exposed
 * for unit tests, which pass a fixed `getRoot` + injected pi operations.
 */
export function createSandboxFileTools(options: SandboxFsOptions = {}): AnyToolDef[] {
  const home = options.home ?? os.homedir();
  const getRoot =
    options.getRoot ??
    ((ctx: ExtensionContext) => resolveWorkspaceRoot(ctx.cwd, process.env, home));
  // Each pi definition is constructed with a placeholder cwd — the wrapper always
  // passes an already-absolute path, so this cwd is never actually consulted.
  const placeholder = normalizeRoot(sandboxBaseDir(home));
  return [
    fenceTool(createWriteToolDefinition(placeholder), true, getRoot, home),
    fenceTool(createEditToolDefinition(placeholder), true, getRoot, home),
    fenceTool(createReadToolDefinition(placeholder), false, getRoot, home),
    fenceTool(createLsToolDefinition(placeholder), false, getRoot, home),
  ];
}

/**
 * Register the sandbox-fenced file tools, overriding pi's built-ins by name.
 * No-op unless `PI_DESKTOP_FS_FENCE=1` — a plain CLI `pi` user keeps the built-ins.
 * Returns true when the override was installed (for tests / telemetry).
 */
export function registerSandboxFileTools(
  pi: ExtensionAPI,
  options: SandboxFsOptions & { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = options.env ?? process.env;
  if (env[FS_FENCE_ENV] !== '1') return false;
  for (const tool of createSandboxFileTools(options)) {
    pi.registerTool(tool);
  }
  return true;
}
