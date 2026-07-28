/**
 * THE PRODUCT GATE — "does the thing actually run?", decided by running it.
 *
 * This is the ledger half of the design: the mesh conversation is free, but what
 * counts as DONE is never a conversation outcome. A corp run previously ended
 * when the CEO said it was finished, and an earlier overnight run proved exactly
 * what that is worth — it signed off "production-ready" on a page that threw on
 * load, because every check in the chain was narrative. `preflight.ts` fixed one
 * instance of that (a static import walk, web only). This is the general form:
 * find the product's own check, EXECUTE it, and let the exit code decide.
 *
 * It is also the only reliable way a 4B model can know it is finished. Asking it
 * to judge its own work is the least robust thing you can ask; handing it a
 * failing command and its output is the most.
 *
 * DISCOVERY is deliberately dumb and ordered — the first check that exists wins.
 * A project that declares its own test is believed; otherwise we look for the
 * obvious runnable thing. No model in the loop, no heuristics over prose.
 *
 * Node child_process + fs only (electron-main). Never throws: a gate that cannot
 * run reports `ran: false`, which is NOT a pass — an unverifiable product is an
 * unfinished one.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** What the gate found and what happened when it ran it. */
export interface GateResult {
  /** Did we find something to run at all? False → the product is unverifiable. */
  readonly ran: boolean;
  /** True only when a real check ran AND exited 0. */
  readonly ok: boolean;
  /** The command we ran, for the record and for telling the team what failed. */
  readonly command: string;
  /** Why we chose it (`package.json test script`, `pytest`, …). */
  readonly how: string;
  /** Combined stdout+stderr, truncated — this is what gets handed back to the team. */
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** How a product declares it can be checked. Ordered: first match wins. */
export interface GateCandidate {
  readonly how: string;
  readonly command: string;
  readonly args: readonly string[];
}

const MAX_OUTPUT = 6000;

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function listShallow(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Find the product's own check, in preference order. Pure apart from reading the
 * tree — exported so the choice is inspectable and unit-testable without running
 * anything.
 */
export function findGate(root: string): GateCandidate | undefined {
  // 1. The project SAYS how to test itself. Always believe it first.
  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  if (typeof scripts.test === 'string' && scripts.test.trim() !== '') {
    return { how: 'package.json test script', command: 'npm', args: ['test', '--silent'] };
  }

  // 2. A Makefile with a `test` target.
  const makefile = path.join(root, 'Makefile');
  if (existsSync(makefile)) {
    try {
      if (/^test:/m.test(readFileSync(makefile, 'utf8'))) {
        return { how: 'Makefile test target', command: 'make', args: ['test'] };
      }
    } catch {
      /* unreadable → fall through */
    }
  }

  // 3. Python tests — the shape the converter task produces.
  const entries = listShallow(root);
  const pyTests = entries.filter((f) => /^test_.*\.py$|^.*_test\.py$/.test(f));
  if (pyTests.length > 0 || existsSync(path.join(root, 'tests'))) {
    return { how: 'python tests', command: 'python3', args: ['-m', 'pytest', '-q'] };
  }
  // A single self-running test script, run directly (no pytest needed).
  const selfTest = entries.find((f) => /^(test|tests|run_tests)\.py$/.test(f));
  if (selfTest !== undefined) {
    return { how: 'python test script', command: 'python3', args: [selfTest] };
  }

  // 4. A Godot project — open it headless and see if it loads without erroring.
  if (existsSync(path.join(root, 'project.godot'))) {
    return {
      how: 'godot headless import',
      command: 'godot',
      args: ['--headless', '--quit-after', '2', '--path', root],
    };
  }

  return undefined;
}

/**
 * Run the product's check. `ran: false` when there is nothing to run — which is
 * NOT a pass: a product nobody can verify has not been shown to work.
 */
export async function runProductGate(
  root: string,
  opts: { readonly timeoutMs?: number } = {},
): Promise<GateResult> {
  const candidate = findGate(root);
  if (candidate === undefined) {
    return {
      ran: false,
      ok: false,
      command: '',
      how: 'nothing runnable found',
      output:
        'No test, no build, no runnable entry point was found in the product. ' +
        'A product that cannot be checked has not been shown to work.',
      exitCode: null,
      timedOut: false,
    };
  }
  const command = `${candidate.command} ${candidate.args.join(' ')}`;
  return await new Promise<GateResult>((resolve) => {
    const child = execFile(
      candidate.command,
      [...candidate.args],
      { cwd: root, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.slice(-MAX_OUTPUT);
        const timedOut = (error as { killed?: boolean } | null)?.killed === true;
        const exitCode = error === null ? 0 : ((error as { code?: number | null }).code ?? null);
        resolve({
          ran: true,
          ok: error === null,
          command,
          how: candidate.how,
          output:
            output.trim() === ''
              ? error === null
                ? '(passed, no output)'
                : `(no output; ${String(error?.message ?? 'failed')})`
              : output,
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          timedOut,
        });
      },
    );
    child.on('error', () => {
      // The tool itself is missing (no python3, no godot) — that is a CAPABILITY
      // gap, not a product failure, and it must be reported as such rather than
      // silently passing.
      resolve({
        ran: false,
        ok: false,
        command,
        how: `${candidate.how} (unavailable)`,
        output: `Could not run \`${command}\` — the tool is not installed on this machine.`,
        exitCode: null,
        timedOut: false,
      });
    });
  });
}

/** The message handed BACK to the team when the gate fails: the command, and what
 * it actually printed. Concrete failure output is the single most useful thing a
 * small model can be given — far better than "please improve the code". */
export function gateFeedback(result: GateResult): string {
  if (result.ran) {
    return [
      `The product does NOT pass its own check yet.`,
      ``,
      `I ran: ${result.command}   (${result.how})`,
      `Exit code: ${result.exitCode ?? 'killed'}${result.timedOut ? ' (timed out)' : ''}`,
      ``,
      `Output:`,
      result.output,
      ``,
      `Fix the cause of this failure and make the check pass. Do not report the work`,
      `as finished until this exact command exits 0.`,
    ].join('\n');
  }
  return [
    `The product cannot be verified: ${result.output}`,
    ``,
    `Add a test or a runnable entry point that proves the product works, and make it`,
    `pass. Work that cannot be checked does not count as delivered.`,
  ].join('\n');
}
