/**
 * `submit_work` — the engineer's ONLY way to finish, and it runs the proof.
 *
 * THE PROBLEM IT SOLVES. Across four live runs the engineers built genuinely
 * working code and then verified it BY HAND: round-tripping real files through
 * the CLI in `bash`, eyeballing the output, and reporting "done". The
 * verification happened and then evaporated — nothing runnable was left behind,
 * so the product gate found nothing to run and the next person had no way to
 * know anything worked. Telling them to leave a test did not fix it: the
 * manager's brief is the instruction in front of them, and when it said the
 * success criterion was a manual command, that is what they did.
 *
 * So finishing is no longer something an engineer can assert. It is a tool call
 * that takes the exact command proving the work, RUNS it, and refuses the
 * submission if it fails. A rejected submission comes back with the real output,
 * which is the most useful thing a small model can be handed.
 *
 * This is the same shape as the product gate, one level down: the conversation is
 * free, but done is decided by an exit code. It also gives a 4B model one obvious
 * terminal action, instead of leaving "when am I finished?" to its judgement —
 * the least reliable thing to ask of it.
 *
 * Node child_process only. Never throws: a tool that explodes would strand the
 * agent, so every failure becomes a readable rejection.
 */

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { runProductGate } from './product-gate';
import { productFingerprint } from './workspace-paths';

/** The name the prompts and the allowlist must agree on. */
export const SUBMIT_WORK_TOOL = 'submit_work';

/** What one accepted submission recorded. */
export interface SubmittedWork {
  readonly summary: string;
  readonly command: string;
  readonly output: string;
}

export interface SubmitWorkOptions {
  /** Where the proof command runs — the product workspace. */
  readonly cwd: string;
  /** Max time the proof may take. Default 5 minutes. */
  readonly timeoutMs?: number;
  /** Called when a submission is ACCEPTED (its command exited 0). */
  readonly onAccepted?: (work: SubmittedWork) => void;
  /** Override the product check (tests supply one; production uses the real gate). */
  readonly checkProduct?: () => Promise<ProductCheck | undefined>;
  /** Called when one is refused, with the failing output. */
  readonly onRejected?: (command: string, output: string) => void;
}

const MAX_OUTPUT = 4000;

/** Run the engineer's proof command in the workspace. Never throws. */
export async function runProof(
  command: string,
  opts: SubmitWorkOptions,
): Promise<{ ok: boolean; output: string; exitCode: number | null }> {
  return await new Promise((resolve) => {
    // Through a shell on purpose: engineers submit real command lines, pipes and
    // `&&` included, and rewriting them would reject valid proofs.
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.slice(-MAX_OUTPUT);
        const exit = error === null ? 0 : ((error as { code?: number | null }).code ?? null);
        resolve({
          ok: error === null,
          output: output.trim() === '' ? '(no output)' : output,
          exitCode: typeof exit === 'number' ? exit : null,
        });
      },
    );
    child.on('error', (err) =>
      resolve({ ok: false, output: `could not run it: ${err.message}`, exitCode: null }),
    );
  });
}

/**
 * Does this command prove nothing even if it exits 0?
 *
 * Run 7's second engineer submitted `python3 convert.py --help && ./convert.sh
 * --help && echo "CLI interfaces working"`. It passed, because printing usage
 * text is exactly the thing a program does when it has not been asked to do
 * anything. The submission was accepted, the run recorded a proof, and not one
 * byte had been converted.
 *
 * So a command whose EVERY segment is a smoke check is refused before it runs.
 * Only "every" — a real check that happens to start with `--help` on one line is
 * still a real check, and the point is to catch proof-by-nothing, not to police
 * command style.
 */
export function proofLooksHollow(command: string): boolean {
  const segments = command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (segments.length === 0) return true;
  return segments.every((segment) => {
    // Prints its own usage/version — says nothing about behaviour.
    if (/(^|\s)(--help|-h|--version|-V|--usage)(\s|$)/.test(segment)) return true;
    // Commands that only ever report on the shell or the filesystem.
    const head = segment.split(/\s+/)[0] ?? '';
    const base = head.replace(/^.*\//, '');
    return /^(echo|true|:|ls|pwd|cd|which|type|printf|whoami|date|stat|file|head|tail|cat|wc)$/.test(
      base,
    );
  });
}

/**
 * Does this command throw its own verdict away?
 *
 * Run 8's first engineer submitted, and had ACCEPTED:
 *
 *     python3 << 'EOF' && rm -f *.json *.csv *.yaml 2>/dev/null; true
 *
 * The Python underneath was real — it converted files and asserted on the
 * results. It did not matter. `; true` runs last, so the command exits 0 whether
 * the assertions held or blew up. A proof that cannot fail is not a proof, and
 * this one was more dangerous than run 7's `--help`, because everything before
 * the last four characters looks exactly like diligence.
 *
 * The shapes that force success: a trailing `true`, `:` or `exit 0`, and any
 * `|| true` / `|| : ` / `|| exit 0` / `|| echo ...` that swallows a failure
 * mid-command. NOT flagged: `2>/dev/null` (hides output, not the exit code),
 * `|| exit 1`, or any `||` that still ends non-zero — those keep the verdict.
 */
export function proofCannotFail(command: string): boolean {
  const trimmed = command.trim().replace(/[;\s]+$/, '');
  // A last word of `true` / `:` / `exit 0` reached by `;` or `&&`.
  if (/(^|[;&])\s*(true|:|exit\s+0)$/.test(trimmed)) return true;
  // `|| <something that succeeds>` — the classic failure-swallower.
  if (/\|\|\s*(true|:|exit\s+0|echo\b|printf\b)/.test(trimmed)) return true;
  return false;
}

/** What an engineer is told when it resubmits into an unchanged tree. */
export function unchangedReply(command: string): string {
  return [
    `NOT RUN — you already submitted \`${command}\` and it failed, and NOTHING in the`,
    `product has changed since. It will fail identically, so there is no point running`,
    `it again.`,
    ``,
    `Change something first. Look at the error you were given and decide which file is`,
    `actually wrong:`,
    `  - the PRODUCT, if it does not do what the test asks — fix the product;`,
    `  - the TEST, if it asks for something that cannot be done. A flat CSV cannot`,
    `    hold a nested value, so a round-trip through it will never return one. That`,
    `    is a broken test, not a broken converter: narrow it to what the format can`,
    `    actually carry, and say in your reply that you did.`,
    ``,
    `If you genuinely cannot tell, talk_to the manager with the error rather than`,
    `submitting again.`,
  ].join('\n');
}

/** What an engineer is told when its proof would have passed regardless. */
export function cannotFailReply(command: string): string {
  return [
    `NOT ACCEPTED — \`${command}\` exits 0 whether your work is right or wrong.`,
    ``,
    `A trailing \`; true\`, \`|| true\` or \`|| echo ...\` throws away the exit code you`,
    `just earned. Whatever ran before it, the command reports success — so it proves`,
    `nothing, and I cannot tell your working code apart from broken code.`,
    ``,
    `Remove it and submit the command again. If it passes on its own, you are done;`,
    `if it fails, you get the real output back and you will know what to fix. Clean up`,
    `temp files INSIDE your script, before it exits with the verdict.`,
  ].join('\n');
}

/** What an engineer is told when its proof would not have proved anything. */
export function hollowProofReply(command: string): string {
  return [
    `NOT ACCEPTED — \`${command}\` would pass without your work doing anything.`,
    ``,
    `Printing usage text, echoing a message or listing a directory succeeds whether or`,
    `not the product works. That is not proof, it is a program starting up.`,
    ``,
    `Submit something that USES it on real input and CHECKS the result: make a small`,
    `input file, run the product on it, and compare the output to what it should be —`,
    `exiting non-zero when it is wrong. Then submit the command that runs that.`,
  ].join('\n');
}

/** The reply an engineer gets back from a submission. Pure, so the wording is
 * testable without running anything. */
export function submissionReply(
  command: string,
  result: { ok: boolean; output: string; exitCode: number | null },
): string {
  if (result.ok) {
    return [
      `ACCEPTED. I ran \`${command}\` and it passed.`,
      ``,
      result.output,
      ``,
      `Your work is recorded as finished. Reply to whoever asked you, quoting this command.`,
    ].join('\n');
  }
  return [
    `NOT ACCEPTED — \`${command}\` exited ${result.exitCode ?? 'abnormally'}.`,
    ``,
    result.output,
    ``,
    `This is what your work actually does right now. Read the output and see WHICH FILE`,
    `the error is in: if it is your test, the test is what is wrong; if it is the`,
    `product, fix the product. Do not rewrite working code to satisfy a broken test.`,
    ``,
    `Fix it and call ${SUBMIT_WORK_TOOL} again. You are not finished until this passes.`,
  ].join('\n');
}

/** What the product's own check said. Structural, so tests can supply one. */
export interface ProductCheck {
  readonly ran: boolean;
  readonly ok: boolean;
  readonly command: string;
  readonly output: string;
  /** How the gate decided to check — `pytest`, `nothing runnable found`,
   * `godot headless import (unavailable)`. The last shape is a CAPABILITY gap. */
  readonly how: string;
}

/** Run the product gate for a submission, unless the caller supplied its own.
 * Returns `undefined` when there is nothing to check — an engineer submitting the
 * very first file of a run must not be blocked by a product that does not exist
 * yet. `ran: false` is a different thing and IS reported: it means the run's own
 * gate looked and found nothing runnable, which is the failure to catch early. */
async function runGate(opts: SubmitWorkOptions): Promise<ProductCheck | undefined> {
  if (opts.checkProduct !== undefined) return await opts.checkProduct();
  const gate = await runProductGate(opts.cwd, { timeoutMs: opts.timeoutMs ?? 300_000 });
  return {
    ran: gate.ran,
    ok: gate.ok,
    command: gate.command,
    output: gate.output,
    how: gate.how,
  };
}

/**
 * The rejection an engineer gets when its own proof passed but the product's does
 * not. Deliberately not accusatory — the broken file is often somebody else's, and
 * the useful move then is a message, not a fix. Either way the error is right here
 * rather than in a verdict nobody sees until minute thirty.
 */
export function productCheckReply(command: string, gate: ProductCheck): string {
  if (!gate.ran) {
    return [
      `NOT ACCEPTED — \`${command}\` passed, but it is the only thing that proves this`,
      `product works, and it does not live in the product.`,
      ``,
      `The check that judges this run looked for something runnable — a test file, a`,
      `test script, a build target — and found nothing. When your command scrolls out`,
      `of this conversation, nothing is left that anyone can run.`,
      ``,
      `Save your check as a file in the workspace (\`run_tests.py\`, \`test_*.py\`, a`,
      `\`test\` target), run that file, and submit the command that runs it.`,
    ].join('\n');
  }
  return [
    `NOT ACCEPTED — your command passed, but the PRODUCT does not pass its own check.`,
    ``,
    `I ran: ${gate.command}`,
    ``,
    gate.output,
    ``,
    `Your proof and the product's check are different things, and only the second one`,
    `decides whether this run delivered. A test file that has never been run is not`,
    `evidence — it is an untested file that happens to contain the word "test".`,
    ``,
    `If the error is in a file you own, fix it and submit again. If it is in someone`,
    `else's file, ${'`talk_to`'} the manager with this output — do not edit around it.`,
  ].join('\n');
}

/**
 * The workspace file this proof actually runs, or `undefined` if it runs nothing
 * that will still exist tomorrow.
 *
 * Run 8's engineer proved its work with a `python3 << 'EOF'` heredoc: real code,
 * really executed, and gone the moment the conversation moved on, while the
 * `test_converter.py` it had left behind carried a SyntaxError nobody had ever
 * triggered. A proof has to be repeatable by somebody who is not in the room.
 */
export function proofRunsAFile(command: string, cwd: string): string | undefined {
  // `make test`, `npm test`, `pytest`, `cargo test`, `swift build` — a build tool
  // reading its own manifest is a real, repeatable check even with no path in it.
  if (/\b(make|npm|yarn|pnpm|pytest|cargo|swift|xcodebuild|go|gradle|mvn)\b/.test(command)) {
    return command.trim();
  }
  // Otherwise SOME token has to name a file that is really there.
  for (const raw of command.split(/[\s;|&()]+/)) {
    const token = raw.replace(/^['"]|['"]$/g, '');
    if (token === '' || token.startsWith('-')) continue;
    if (!/[./]/.test(token)) continue;
    const abs = path.isAbsolute(token) ? token : path.join(cwd, token);
    try {
      if (statSync(abs).isFile()) return token;
    } catch {
      // not a file — keep looking
    }
  }
  return undefined;
}

/** What an engineer is told when its proof leaves nothing behind. */
export function ephemeralProofReply(command: string): string {
  return [
    `NOT ACCEPTED — \`${command}\` does not run anything that exists in the workspace.`,
    ``,
    `A heredoc, or a command typed inline, disappears the moment this conversation`,
    `moves on. The next person cannot re-run it, and neither can the check that`,
    `decides this product ships.`,
    ``,
    `Put the same code in a FILE next to your work — \`tests/test_gui.py\`,`,
    `\`scripts/check_engine.sh\` — run that file, and submit the command that runs it.`,
  ].join('\n');
}

/** Appended to an ACCEPTED submission when the product as a whole is still red.
 * Information, not a refusal: the other pieces may simply not exist yet. */
export function productStillRedNote(gate: ProductCheck): string {
  return [
    `Note — your piece is accepted, but the PRODUCT as a whole does not pass yet:`,
    ``,
    `  ${gate.command}`,
    gate.output.slice(-800),
    ``,
    `If that failure is in a file you own, it is yours to fix. If it names someone`,
    `else's file, or a piece nobody has built yet, tell the manager what you see —`,
    `do not go and edit around it.`,
  ].join('\n');
}

/** A pi `ToolDefinition` shape — kept structural so this module needs no SDK import. */
interface ToolLike {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: unknown;
  execute: (id: unknown, params: unknown) => Promise<unknown>;
}

/**
 * Build the `submit_work` tool for one engineer. The returned object is the pi
 * custom-tool shape; the caller casts it into its `ToolDefinition[]`.
 */
export function createSubmitWorkTool(opts: SubmitWorkOptions): ToolLike {
  /*
   * THE SAME COMMAND, OVER AN UNCHANGED TREE, FAILS THE SAME WAY.
   *
   * Run 13's last twenty minutes: 1200 seconds, zero file writes, three
   * submissions of a command already refused. Run 12: three byte-identical
   * rejections. The rejection carries the real traceback and ends "Fix it and
   * call submit_work again" — and the model reads the second half.
   *
   * So a resubmission is refused WITHOUT running anything when the command is
   * identical and nothing in the product has changed since. Not a penalty: it is
   * the only honest answer, because the result is already known.
   */
  let lastFailure: { command: string; fingerprint: string } | undefined;
  return {
    name: SUBMIT_WORK_TOOL,
    label: SUBMIT_WORK_TOOL,
    description:
      'Finish your piece of work. You MUST give the exact shell command that proves it works — ' +
      'a test, a script, a build. The command IS RUN in the workspace, and your submission is ' +
      'refused with the real output if it fails. The product\'s own check is then run too, and ' +
      'the submission is refused if THAT fails — so make sure the test files in the workspace ' +
      'actually run, not just your own command. This is the only way to finish.',
    promptSnippet: 'Finish your work by giving the command that proves it (it gets run).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The exact shell command that proves the work, run from the workspace root — ' +
            'e.g. `python3 run_tests.py`. It must USE the product on real input and exit ' +
            'non-zero when the result is wrong. `--help` and `echo` prove nothing and are refused, ' +
            'and so is anything ending `; true` or `|| true` — that throws away the exit code and ' +
            'reports success either way. Clean up temp files inside your script, not after it.',
        },
        summary: {
          type: 'string',
          description: 'One line: what you built.',
        },
      },
      required: ['command', 'summary'],
    },
    execute: async (_id: unknown, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const command = typeof p.command === 'string' ? p.command.trim() : '';
      const summary = typeof p.summary === 'string' ? p.summary : '';
      if (command === '') {
        return {
          content: [
            {
              type: 'text',
              text:
                `NOT ACCEPTED — you gave no command. Work is finished when something RUNS and ` +
                `passes. Write that something, then submit it as \`command\`.`,
            },
          ],
          details: undefined,
        };
      }
      if (lastFailure !== undefined && lastFailure.command === command) {
        const now = productFingerprint(opts.cwd);
        if (now === lastFailure.fingerprint) {
          opts.onRejected?.(command, 'resubmitted unchanged — nothing in the product changed');
          return {
            content: [{ type: 'text', text: unchangedReply(command) }],
            details: undefined,
          };
        }
      }
      // Refuse a proof-by-nothing BEFORE running it: a command that would pass
      // regardless is worse than no command, because it records a false success.
      if (proofLooksHollow(command)) {
        opts.onRejected?.(command, 'hollow proof — the command exercises nothing');
        return { content: [{ type: 'text', text: hollowProofReply(command) }], details: undefined };
      }
      if (proofCannotFail(command)) {
        opts.onRejected?.(command, 'proof cannot fail — the exit code is forced to 0');
        return { content: [{ type: 'text', text: cannotFailReply(command) }], details: undefined };
      }
      const result = await runProof(command, opts);
      if (!result.ok) {
        lastFailure = { command, fingerprint: productFingerprint(opts.cwd) };
        opts.onRejected?.(command, result.output);
        return {
          content: [{ type: 'text', text: submissionReply(command, result) }],
          details: undefined,
        };
      }

      /*
       * AND THE PRODUCT'S OWN CHECK HAS TO PASS TOO.
       *
       * Run 8, measured: engineer:1 made FORTY-ONE bash calls and not one of them
       * ran `test_converter.py` — the test file it had itself written, which had
       * carried a SyntaxError on line 94 for ten minutes. It verified with a
       * throwaway heredoc, submitted the heredoc, and was accepted. The artifact
       * the run is judged on had never been executed by anyone.
       *
       * That is the evaporation problem in its final form. `submit_work` fixed
       * "verification is never written down"; it did not fix "what was written
       * down is not what was verified". So finishing now requires BOTH: the
       * engineer's own proof, and the check that actually judges the product.
       */
      /*
       * THE PROOF MUST LIVE IN THE WORKSPACE — but the WHOLE product need not
       * pass yet.
       *
       * Requiring the product gate here was right when the product was one file
       * and one engineer. On jedd's real task the manager splits the work four
       * ways, and then engineer:1 finishing the GUI is refused because the
       * converter engine, the format library and the test suite do not exist yet
       * — work that belongs to three other people who are ALSO blocked, by each
       * other. Nobody can ever be first. That is L18's deadlock rebuilt: two
       * correct rules whose intersection has no legal move.
       *
       * What actually stopped run 8's evaporation was not "everything passes", it
       * was "the thing you proved has to be the thing you left behind". So that is
       * what is enforced: the proof must RUN A FILE that exists in the workspace,
       * not a heredoc that vanishes with the conversation. The product's state is
       * still measured and still reported — as information, in the acceptance —
       * because an engineer should know the product is red even when its own piece
       * is green. The whole-product verdict belongs to the run's gate and to the
       * manager, who are the only ones who can see all the pieces.
       */
      const proofFile = proofRunsAFile(command, opts.cwd);
      if (proofFile === undefined) {
        lastFailure = { command, fingerprint: productFingerprint(opts.cwd) };
        opts.onRejected?.(command, 'proof runs nothing that exists in the workspace');
        return { content: [{ type: 'text', text: ephemeralProofReply(command) }], details: undefined };
      }
      const gate = await runGate(opts);
      opts.onAccepted?.({ summary, command, output: result.output });
      if (gate !== undefined && gate.ran && !gate.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `${submissionReply(command, result)}\n\n${productStillRedNote(gate)}`,
            },
          ],
          details: undefined,
        };
      }
      return {
        content: [{ type: 'text', text: submissionReply(command, result) }],
        details: undefined,
      };
    },
  };
}
