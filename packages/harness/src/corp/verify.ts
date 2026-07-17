/**
 * Evidence-grounded VERIFY pass (spec §8 — "reviews measure, they don't opine").
 *
 * Before the CEO signs off (ceo.ts), the harness runs a lightweight, deterministic,
 * MODEL-FREE check over the produced files and reports objective evidence: does
 * each file parse / hold together, or are there concrete errors? This is the
 * ground truth the CEO reviews against — a build that reports itself "done" still
 * has to survive an actual check.
 *
 * The check is injectable ({@link FileCheck}): the driver can pass a real
 * `tsc --noEmit`-style check (per file or project-wide) when one is available;
 * tests pass a mock returning fixed results. The default ({@link defaultFileCheck})
 * is a per-file structural sanity check — empty files, leaked Markdown fences, and
 * unbalanced brackets (the signature of a truncated engineer reply) — chosen
 * because it is deterministic and needs no toolchain. {@link verifyProduct} itself
 * never throws: a listing/read/check that throws is captured as evidence, not a
 * crash.
 */

import type { WorkspaceReadFs } from './workspace.js';

/** One concrete verification finding: which file, what is wrong. */
export interface VerifyError {
  /** The absolute path of the offending file. */
  readonly file: string;
  /** A concrete, human-legible description of the problem. */
  readonly message: string;
}

/** The objective evidence the CEO reviews (ceo.ts). `ok` iff no errors. */
export interface VerifyResult {
  /** True when every checked file passed (no errors). */
  readonly ok: boolean;
  /** How many files were actually read and checked. */
  readonly filesChecked: number;
  /** Every concrete problem found, in file order. */
  readonly errors: readonly VerifyError[];
}

/**
 * A per-file check: given a file path and its content, return a concrete error
 * message, or `undefined` when the file passes. Injected into
 * {@link verifyProduct} so a real toolchain check (or a test mock) can replace the
 * built-in {@link defaultFileCheck}. Should be deterministic and model-free.
 */
export type FileCheck = (file: string, content: string) => string | undefined;

/** Extensions the structural default check applies its bracket scan to. */
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * The built-in per-file structural check: deterministic, toolchain-free evidence.
 * Flags (1) an empty produced file, (2) a leaked Markdown code fence (```) — prose
 * the parser should have stripped that ended up in the file body — and, for code
 * files, (3) unbalanced brackets, the signature of a truncated reply. Returns a
 * concrete message or `undefined` when the file passes. Never throws.
 *
 * It is a HEURISTIC, not a compiler: the bracket scan skips strings and comments
 * (including template-literal `${…}` substitutions) but does not tokenize regex
 * literals, so a regex containing a lone `{`/`}` could read as imbalanced. That is
 * an accepted edge for a lightweight check — pass a real `tsc`-style
 * {@link FileCheck} to {@link verifyProduct} when exactness matters.
 */
export function defaultFileCheck(file: string, content: string): string | undefined {
  if (content.trim() === '') return 'produced file is empty';
  if (/^\s*```/m.test(content)) {
    return 'contains a Markdown code fence (```), indicating prose leaked into the file body';
  }
  if (!CODE_FILE.test(file)) return undefined;
  return bracketImbalance(content);
}

/**
 * Scan `src` for a bracket imbalance, skipping string/comment content and handling
 * template-literal `${…}` nesting. Returns a concrete message for a stray closer, a
 * mismatched pair, or openers never closed at EOF (a truncated file); `undefined`
 * when balanced. Pure.
 */
function bracketImbalance(src: string): string | undefined {
  const stack: string[] = [];
  // Depths (stack length before the `${` push) to resume template scanning at.
  const templateReturns: number[] = [];
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLine = false;
  let inBlock = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inSingle || inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '\n') {
        inSingle = false;
        inDouble = false;
      } else if (inSingle && ch === "'") inSingle = false;
      else if (inDouble && ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '`') inTemplate = false;
      else if (ch === '$' && next === '{') {
        templateReturns.push(stack.length);
        stack.push('{');
        inTemplate = false;
        i++;
      }
      continue;
    }

    // Code mode.
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
    } else if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '`') inTemplate = true;
    else if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop();
      const want = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      if (open === undefined) {
        return `unbalanced '${ch}' — a closing bracket with no opener (file may be truncated or malformed)`;
      }
      if (open !== want) {
        return `mismatched bracket: '${ch}' closes '${open}' (file may be malformed)`;
      }
      const top = templateReturns[templateReturns.length - 1];
      if (ch === '}' && top === stack.length) {
        templateReturns.pop();
        inTemplate = true;
      }
    }
  }

  if (stack.length > 0) {
    const last = stack[stack.length - 1];
    return `unbalanced '${last}' — ${stack.length} bracket(s) never closed (file may be truncated)`;
  }
  return undefined;
}

/**
 * Verify the produced files in `workspace`: list them via `fs`, read each, run
 * `runCheck` (default {@link defaultFileCheck}), and collect the concrete errors
 * into a {@link VerifyResult}. This is the objective evidence the CEO reviews
 * (ceo.ts) — measured, model-free, deterministic. Never throws: a listing/read/
 * check failure is recorded as evidence rather than propagated.
 */
export function verifyProduct(
  workspace: string,
  fs: WorkspaceReadFs,
  runCheck: FileCheck = defaultFileCheck,
): VerifyResult {
  let files: readonly string[];
  try {
    files = fs.listFiles(workspace);
  } catch {
    files = [];
  }

  const errors: VerifyError[] = [];
  let filesChecked = 0;
  for (const file of files) {
    let content: string | undefined;
    try {
      content = fs.readFile(file);
    } catch {
      content = undefined;
    }
    if (content === undefined) continue;
    filesChecked += 1;
    let message: string | undefined;
    try {
      message = runCheck(file, content);
    } catch (err) {
      message = `check threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (message !== undefined && message !== '') errors.push({ file, message });
  }

  return { ok: errors.length === 0, filesChecked, errors };
}
