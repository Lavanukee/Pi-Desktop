/**
 * Effort-gated REAL verify (harness fix #4).
 *
 * The reviewer pass (review/review.ts) is LLM self-critique only, and is skipped
 * entirely with no utility model — so high/max effort could ship untested code.
 * This module adds a BOUNDED, best-effort REAL verify for coding/file-ops turns:
 * after the model signals completion, run the project's OWN checks (test /
 * typecheck / lint) in the working dir via a bash seam, with a timeout; on
 * failure, feed the output back to the model as a fix steer, bounded to a small
 * effort-scaled iteration count. With no check infra, fall back to a lighter
 * syntax/does-it-parse sanity check on the files the turn touched.
 *
 * Everything that touches the outside world (running commands, reading the
 * project) is injected, so detection + the bounded loop are unit-testable with a
 * fake bash runner. The wiring (index.ts) owns the per-turn fix budget + gating;
 * this module owns detection and the single check run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A resolved check the verify pass can run. */
export interface ProjectCheck {
  /** Full shell command line, run via the bash seam (`sh -c`). */
  readonly command: string;
  readonly kind: 'test' | 'typecheck' | 'lint' | 'build' | 'syntax';
  /** Short human label for telemetry / notifications. */
  readonly label: string;
}

/** Outcome of running one check. */
export interface CheckOutcome {
  /** pass = exit 0; fail = ran to completion non-zero; inconclusive = timeout / runner error. */
  readonly status: 'pass' | 'fail' | 'inconclusive';
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Combined stdout+stderr, tail-truncated. */
  readonly output: string;
  readonly command: string;
  readonly kind: ProjectCheck['kind'];
}

/** The bash seam. Returns raw process results; never throws for a non-zero exit. */
export type VerifyBashRunner = (
  command: string,
  opts: { readonly cwd: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}>;

/** Read-only project probe used by detection (repo-relative paths). */
export interface ProjectProbe {
  /** Read a repo-relative text file, or undefined if absent/unreadable. */
  readonly readText: (relPath: string) => string | undefined;
  /** True if a repo-relative path exists. */
  readonly exists: (relPath: string) => boolean;
}

/** Build a {@link ProjectProbe} rooted at a working dir, backed by node:fs. */
export function makeFsProbe(cwd: string): ProjectProbe {
  return {
    readText: (rel) => {
      try {
        return readFileSync(join(cwd, rel), 'utf8');
      } catch {
        return undefined;
      }
    },
    exists: (rel) => {
      try {
        return existsSync(join(cwd, rel));
      } catch {
        return false;
      }
    },
  };
}

/** Detect the package manager from a lockfile (defaults to npm). All support `run`. */
export function detectPackageManager(probe: ProjectProbe): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (probe.exists('pnpm-lock.yaml')) return 'pnpm';
  if (probe.exists('yarn.lock')) return 'yarn';
  if (probe.exists('bun.lockb')) return 'bun';
  return 'npm';
}

// package.json script preference: a real test first, then a typecheck, then lint,
// then build. First present wins.
const SCRIPT_PREFERENCE: readonly { script: string; kind: ProjectCheck['kind'] }[] = [
  { script: 'test', kind: 'test' },
  { script: 'typecheck', kind: 'typecheck' },
  { script: 'type-check', kind: 'typecheck' },
  { script: 'tsc', kind: 'typecheck' },
  { script: 'lint', kind: 'lint' },
  { script: 'build', kind: 'build' },
];

const MAKE_PREFERENCE: readonly { target: string; kind: ProjectCheck['kind'] }[] = [
  { target: 'test', kind: 'test' },
  { target: 'check', kind: 'typecheck' },
  { target: 'lint', kind: 'lint' },
];

function packageJsonCheck(probe: ProjectProbe): ProjectCheck | null {
  const raw = probe.readText('package.json');
  if (raw === undefined) return null;
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    return null;
  }
  const pm = detectPackageManager(probe);
  for (const { script, kind } of SCRIPT_PREFERENCE) {
    if (typeof scripts[script] === 'string' && (scripts[script] as string).length > 0) {
      return { command: `${pm} run ${script}`, kind, label: `${pm} run ${script}` };
    }
  }
  return null;
}

function makefileCheck(probe: ProjectProbe): ProjectCheck | null {
  const raw = probe.readText('Makefile') ?? probe.readText('makefile');
  if (raw === undefined) return null;
  for (const { target, kind } of MAKE_PREFERENCE) {
    // A target definition is `name:` at the start of a line.
    if (new RegExp(`^${target}\\s*:`, 'm').test(raw)) {
      return { command: `make ${target}`, kind, label: `make ${target}` };
    }
  }
  return null;
}

function pythonPytestConfigured(probe: ProjectProbe): boolean {
  if (probe.exists('pytest.ini') || probe.exists('tox.ini')) return true;
  const pyproject = probe.readText('pyproject.toml');
  if (pyproject !== undefined && /\[tool\.pytest/.test(pyproject)) return true;
  const setupCfg = probe.readText('setup.cfg');
  if (setupCfg !== undefined && /\[tool:pytest\]/.test(setupCfg)) return true;
  return false;
}

/**
 * Detect the best available PROJECT check for the working dir, or null when no
 * check infrastructure is present. Ordered: JS/TS scripts → Makefile → Rust → Go
 * → Python(pytest). Pure over the injected {@link ProjectProbe}.
 */
export function detectProjectCheck(probe: ProjectProbe): ProjectCheck | null {
  return (
    packageJsonCheck(probe) ??
    makefileCheck(probe) ??
    (probe.exists('Cargo.toml')
      ? { command: 'cargo check', kind: 'typecheck', label: 'cargo check' }
      : null) ??
    (probe.exists('go.mod')
      ? { command: 'go build ./...', kind: 'build', label: 'go build ./...' }
      : null) ??
    (pythonPytestConfigured(probe)
      ? { command: 'python3 -m pytest -q', kind: 'test', label: 'pytest' }
      : null)
  );
}

/** Single-quote a path for `sh -c` (escapes embedded quotes). */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * A lighter "does it parse" sanity check over the files a turn touched, used when
 * no project check infra exists. Handles Python (py_compile) and plain Node JS
 * (node --check); returns null for anything a bare parser can't sanity-check
 * (e.g. TS/JSX — those rely on the project's own typecheck, handled above).
 */
export function syntaxCheckCommand(touchedFiles: readonly string[]): ProjectCheck | null {
  const py = touchedFiles.filter((f) => /\.py$/i.test(f));
  if (py.length > 0) {
    return {
      command: `python3 -m py_compile ${py.map(shQuote).join(' ')}`,
      kind: 'syntax',
      label: `py_compile (${py.length} file${py.length === 1 ? '' : 's'})`,
    };
  }
  const js = touchedFiles.find((f) => /\.(c|m)?js$/i.test(f));
  if (js !== undefined) {
    return { command: `node --check ${shQuote(js)}`, kind: 'syntax', label: `node --check` };
  }
  return null;
}

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…(${text.length - maxChars} chars elided)…\n${text.slice(text.length - maxChars)}`;
}

/** Default verify timeout: generous enough for a real check, bounded so it can't wedge. */
export const VERIFY_TIMEOUT_MS = 60_000;

/** Run a single resolved check. Fail-open: a timeout or runner error is inconclusive. */
export async function runCheck(
  runBash: VerifyBashRunner,
  check: ProjectCheck,
  opts: {
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly maxOutputChars?: number;
  },
): Promise<CheckOutcome> {
  const maxOutputChars = opts.maxOutputChars ?? 4000;
  let res: Awaited<ReturnType<VerifyBashRunner>>;
  try {
    res = await runBash(check.command, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? VERIFY_TIMEOUT_MS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    return {
      status: 'inconclusive',
      exitCode: null,
      timedOut: false,
      output: truncateTail(`verify runner error: ${String(err)}`, maxOutputChars),
      command: check.command,
      kind: check.kind,
    };
  }
  const timedOut = res.timedOut === true;
  const output = truncateTail(`${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim(), maxOutputChars);
  const status: CheckOutcome['status'] = timedOut
    ? 'inconclusive'
    : res.exitCode === 0
      ? 'pass'
      : 'fail';
  return {
    status,
    exitCode: res.exitCode,
    timedOut,
    output,
    command: check.command,
    kind: check.kind,
  };
}

/** Inputs to one verify pass (detect + run). */
export interface VerifyPassDeps {
  readonly cwd: string;
  readonly runBash: VerifyBashRunner;
  /** Detect the project check for a working dir (injected so tests can stub it). */
  readonly detectCheck: (cwd: string) => ProjectCheck | null;
  /** Files the turn wrote/edited, used for the syntax fallback when no infra exists. */
  readonly touchedFiles?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputChars?: number;
}

/** Result of one verify pass. `check` is null when there was nothing to run. */
export interface VerifyPassResult {
  readonly check: ProjectCheck | null;
  readonly outcome: CheckOutcome | null;
}

/**
 * Run one verify pass: pick a project check (or a syntax fallback over the touched
 * files), run it, and return the outcome. No steering / budget logic here — the
 * caller decides what to do with a `fail`.
 */
export async function runVerifyPass(deps: VerifyPassDeps): Promise<VerifyPassResult> {
  const check = deps.detectCheck(deps.cwd) ?? syntaxCheckCommand(deps.touchedFiles ?? []);
  if (check === null) return { check: null, outcome: null };
  const outcome = await runCheck(deps.runBash, check, {
    cwd: deps.cwd,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.maxOutputChars !== undefined ? { maxOutputChars: deps.maxOutputChars } : {}),
  });
  return { check, outcome };
}

/** Minimal `pi.exec`-shaped seam (command + argv + options → result). */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/** Build a {@link VerifyBashRunner} that runs a command string via `sh -c` through pi.exec. */
export function makeExecBashRunner(exec: ExecLike): VerifyBashRunner {
  return async (command, opts) => {
    const res = await exec('/bin/sh', ['-c', command], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return {
      exitCode: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      // pi.exec reports killed=true on timeout/abort → inconclusive, not a real fail.
      timedOut: res.killed,
    };
  };
}
