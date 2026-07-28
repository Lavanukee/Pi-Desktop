/**
 * `check_product` — the acceptance check, handed to the team instead of sprung on them.
 *
 * THE PROBLEM IT SOLVES. The product gate is the harness's verdict: it finds the
 * product's own check and runs it, and whatever that command says is what the run
 * DELIVERED means. Until now it fired exactly once, at the end, and the team had
 * no way to run it. So the gate was a hidden oracle — the team built toward its
 * guess of what "working" meant, and found out at minute thirty.
 *
 * Run 7 is the whole argument. The engineers wrote `tests/test_converter.py`, and
 * the gate ran `python3 -m pytest -q` over it and got:
 *
 *     AttributeError: 'TestRoundTripJSONCSV' object has no attribute '_compare_dicts'
 *
 * — a helper called from three tests and defined inside a different class at the
 * bottom of the file. Not a hard bug. A bug that dies the first time anyone runs
 * the file whole. Nobody ever did: the engineers checked their work by converting
 * a file by hand in bash, and the one thing that would have run those tests as
 * written was the gate they could not reach. Thirty minutes of work failed on
 * something a five-second command would have shown at minute five.
 *
 * So the gate becomes a tool. Same function, same tree, same verdict — available
 * whenever they want it. `submit_work` proves ONE engineer's piece; this answers
 * the only question that decides the run: does the product pass the check that
 * will judge it? A 4B model cannot reliably imagine that answer. It can read it.
 *
 * This is "give it eyes" pointed at acceptance. Never throws.
 */

import { gateFeedback, runProductGate } from './product-gate';

/** The name the prompts and the allowlist must agree on. */
export const CHECK_PRODUCT_TOOL = 'check_product';

export interface CheckProductOptions {
  /** The shared product workspace — the same tree the final gate will judge. */
  readonly cwd: string;
  /** Max time the check may take. Default 5 minutes. */
  readonly timeoutMs?: number;
  /** Observe every check, so a run's transcript shows the team converging (or not). */
  readonly onChecked?: (result: { ok: boolean; ran: boolean; command: string }) => void;
}

/**
 * What the team is told. A pass says so in one line — there is nothing to think
 * about. A failure reuses the gate's own feedback, which carries the command and
 * the real output, because concrete failure text is the single most useful thing
 * a small model can be handed.
 */
export function checkReply(result: {
  ran: boolean;
  ok: boolean;
  command: string;
  how: string;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}): string {
  if (result.ok) {
    return [
      `PASSES. I ran \`${result.command}\` (${result.how}) in the product directory and it exited 0.`,
      ``,
      `This is the exact check that decides whether this run delivered. If your`,
      `piece is done, submit it.`,
      ``,
      result.output.slice(0, 1500),
    ].join('\n');
  }
  return gateFeedback(result);
}

/** Build the tool. Zero parameters on purpose: there is only one thing to check,
 * and a call a small model cannot get wrong is one it will actually make. */
export function createCheckProductTool(opts: CheckProductOptions): unknown {
  return {
    name: CHECK_PRODUCT_TOOL,
    label: CHECK_PRODUCT_TOOL,
    description:
      'Run the check that decides whether this product is accepted, and see exactly what it prints. ' +
      'It finds the product\'s own test/build/run command and runs it in the product directory — the same ' +
      'command, the same tree, the same verdict used at the end of the run. Use it whenever you want to ' +
      'know where the product really stands: after a change, before you submit, before you report done. ' +
      'It takes no arguments and changes nothing.',
    promptSnippet: 'Run the real acceptance check and read its output.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (): Promise<{
      content: Array<{ type: 'text'; text: string }>;
      details: undefined;
    }> => {
      const result = await runProductGate(
        opts.cwd,
        opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
      );
      opts.onChecked?.({ ok: result.ok, ran: result.ran, command: result.command });
      return { content: [{ type: 'text', text: checkReply(result) }], details: undefined };
    },
  };
}
