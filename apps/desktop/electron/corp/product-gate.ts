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
 * DISCOVERY is one rule: the team leaves an executable check at the root, and it
 * is run. The harness never decides what testing looks like — no framework, no
 * ecosystem, no language. No model in the loop, no heuristics over prose.
 *
 * Node child_process + fs only (electron-main). Never throws: a gate that cannot
 * run reports `ran: false`, which is NOT a pass — an unverifiable product is an
 * unfinished one.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';

/** What the gate found and what happened when it ran it. */
export interface GateResult {
  /** Did we find something to run at all? False → the product is unverifiable. */
  readonly ran: boolean;
  /** True only when a real check ran AND exited 0. */
  readonly ok: boolean;
  /** The command we ran, for the record and for telling the team what failed. */
  readonly command: string;
  /** Why we chose it — which declared check was found. */
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




/** The names a team may leave its check under. First one that exists wins. */
export const DECLARED_CHECKS = ['check', 'check.sh', 'verify.sh', 'run_checks.sh'] as const;

/**
 * Find the check the TEAM declared. That is the only thing this looks for.
 *
 * It used to guess: a package.json test script, a Makefile test target, a
 * run_tests.py, test_*.py through pytest or unittest, a Swift package, a Godot
 * project. Every one of those is the harness deciding what testing looks like,
 * and jedd's objection is the right one — this has to work for any project, and
 * a list of remembered ecosystems never will. Worse, the guessing had teeth: a
 * project the list did not recognise was ungradable, and an engineer that cannot
 * be graded will invent a check the list DOES recognise and quietly become the
 * acceptance criterion for everyone else.
 *
 * So the harness enforces no testing mechanism at all. It asks for one thing: an
 * executable check at the root that exits 0 when the product works. Shell,
 * python, a compiler invocation, a binary — the team decides what proving it
 * means, in whatever language they built it in. If they leave none, the product
 * is unverifiable, which is not a pass; that is honest, and the team is told
 * plainly what to leave.
 *
 * Pure apart from reading the tree — exported so the choice is inspectable.
 */
export function findGate(root: string): GateCandidate | undefined {
  for (const name of DECLARED_CHECKS) {
    const declared = path.join(root, name);
    if (!existsSync(declared)) continue;
    /*
     * RUN IT THE WAY THE TEAM WROTE IT. If the file is executable we exec it
     * directly, so its own shebang decides the interpreter — the check may be
     * python, node, a compiled binary, anything. Only when it is NOT executable
     * do we fall back to `sh`, which is the common case of someone writing a
     * shell script and forgetting `chmod +x`. Assuming `sh` unconditionally would
     * break every check that is not shell, which is most of them.
     */
    let executable = false;
    try {
      accessSync(declared, fsConstants.X_OK);
      executable = true;
    } catch {
      executable = false;
    }
    return executable
      ? { how: `declared check (${name})`, command: declared, args: [] }
      : { how: `declared check (${name})`, command: '/bin/sh', args: [declared] };
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
         * A runner over an empty suite prints "Ran 0 tests ... OK" and EXITS 0 — a
         * green light for a product nobody tested. MEASURED on a live run whose
         * real work had landed one directory deeper, leaving nothing for the check
         * to find. Exit code alone would have called that success, which is exactly
         * the narrative sign-off this gate exists to end.
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
      // The check itself could not be executed at all — that is a CAPABILITY
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
      `  - the test demands something that is not actually possible for what was built.`,
      `    Narrow it to what can be guaranteed, and say that you did.`,
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
