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

import { execFile, execFileSync } from 'node:child_process';
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

/** Is pytest actually importable? Cached — this is called during discovery, which
 * runs on every gate attempt. */
let pytestAvailable: boolean | undefined;
function hasPytest(): boolean {
  if (pytestAvailable !== undefined) return pytestAvailable;
  try {
    execFileSync('python3', ['-c', 'import pytest'], { stdio: 'ignore', timeout: 15_000 });
    pytestAvailable = true;
  } catch {
    pytestAvailable = false;
  }
  return pytestAvailable;
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

  const entries = listShallow(root);

  // 3. A standalone runner, run DIRECTLY — checked before pytest on purpose. A
  //    small model reaches for `if __name__ == '__main__'` far more often than
  //    for a test framework, and running the file needs nothing installed.
  const selfTest = entries.find((f) => /^(test|tests|run_tests|check)\.py$/.test(f));
  if (selfTest !== undefined) {
    return { how: 'python test script', command: 'python3', args: [selfTest] };
  }

  // 4. test_*.py files. WHICH RUNNER MATTERS: on a machine without pytest,
  //    `-m pytest` fails with "No module named pytest" — which reads as a BROKEN
  //    PRODUCT when the truth is a missing checker, and costs a whole round of the
  //    team "fixing" code that was never wrong. So probe rather than assume: pytest
  //    only if it actually imports, else unittest, which is stdlib and always there.
  //    (Never bare `pytest` — the module is importable here while the console
  //    script is not on PATH, and that combination is common.)
  const pyTests = entries.filter((f) => /^test_.*\.py$|^.*_test\.py$/.test(f));
  if (pyTests.length > 0 || existsSync(path.join(root, 'tests'))) {
    return hasPytest()
      ? { how: 'pytest', command: 'python3', args: ['-m', 'pytest', '-q'] }
      : {
          how: 'unittest discover',
          command: 'python3',
          args: ['-m', 'unittest', 'discover', '-v'],
        };
  }

  // 4. A Godot project — open it headless and see if it loads without erroring.
  /*
   * A SWIFT PACKAGE. Added because the gate was blind to it: on a macOS GUI task
   * the discovery list (run_tests.py, package.json, Makefile, test_*.py, godot)
   * matches nothing a Swift app contains, so the engineer building the GUI has no
   * way to be graded — and the tempting fix, from its side, is to plant a
   * `run_tests.py` at the root and silently become the acceptance check for all
   * four engineers. `swift build` is a real check: it fails on any type error in
   * the package.
   */
  if (existsSync(path.join(root, 'Package.swift'))) {
    return { how: 'swift build', command: 'swift', args: ['build'] };
  }
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
        /*
         * A CHECK THAT CHECKED NOTHING IS NOT A PASS.
         *
         * `python3 -m unittest discover` in a tree with an empty `tests/` prints
         * "Ran 0 tests ... OK" and EXITS 0 — a green light for a product nobody
         * tested. MEASURED on a live run whose real work had landed one directory
         * deeper, leaving an empty tests/ at the top. Exit code alone would have
         * called that success, which is exactly the narrative sign-off this gate
         * exists to end.
         */
        const ranNothing = /\bRan 0 tests\b|\bno tests ran\b|collected 0 items/i.test(output);
        /*
         * A CHECK THAT REPORTED FAILURE IS NOT A PASS, WHATEVER IT EXITED.
         *
         * Run 11's `run_tests.py` printed `FAIL JSON->CSV: No module named
         * mesh_converter.main` and EXITED 0 — a hand-rolled runner that collects
         * results, prints them, and forgets to make the exit code depend on them.
         * That is the most dangerous shape the gate can meet: not a red run, a
         * FALSE GREEN. Every other lesson here is about refusing to bless work
         * that was never checked; this one blesses work that was checked and
         * FAILED.
         *
         * Deliberately narrow, because a false positive here would refuse a
         * genuinely passing product: a traceback (an exception that reached the
         * top and was swallowed), or a line that STARTS with FAIL/FAILED/ERROR,
         * which is what a runner prints per failing case. A test whose name
         * merely contains "fail" does not match.
         */
        const saidItFailed =
          /^(FAIL(ED)?|ERROR)\b/m.test(output) || /^Traceback \(most recent call last\)/m.test(output);
        const falseGreen = error === null && saidItFailed;
        resolve({
          ran: true,
          ok: error === null && !ranNothing && !falseGreen,
          command,
          how: candidate.how,
          output: ranNothing
            ? `${output}\n\n(This ran ZERO tests. An empty test run is not a passing one — there is nothing here that checks the product.)`
            : falseGreen
              ? `${output}\n\n(This printed a FAILURE and then exited 0. The check is not reporting its own result — make the exit code depend on whether the tests passed, e.g. \`sys.exit(1)\` when any of them fail. Until then nothing here can be trusted as a pass.)`
              : output.trim() === ''
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
      `READ THE TRACEBACK BEFORE YOU CHANGE ANYTHING. The bug is not always in the`,
      `product — a failing check can mean the TEST is wrong. Look at which file and`,
      `line each error points at. If the error is inside the test, fix the test. If`,
      `it is inside the product, fix the product. Do not rewrite working code to`,
      `satisfy a test that is itself broken.`,
      ``,
      `Two test bugs worth ruling out first, because both look exactly like product`,
      `bugs from the outside:`,
      `  - the test converts an input file it never created. Read it top to bottom and`,
      `    check that every file it opens is one it actually wrote.`,
      `  - the test asks for something the format cannot do — a value keeping its type`,
      `    through CSV, which has none. Narrow it to what is actually possible.`,
      ``,
      `Then make the check pass. Do not report the work as finished until this exact`,
      `command exits 0.`,
    ].join('\n');
  }
  return [
    `The product cannot be verified: ${result.output}`,
    ``,
    `Add a test or a runnable entry point that proves the product works, and make it`,
    `pass. Work that cannot be checked does not count as delivered.`,
  ].join('\n');
}
