/**
 * `submit_work` — how an engineer hands finished work back, with its evidence.
 *
 * WHAT THIS USED TO BE, AND WHY IT CHANGED. It was a gate: the engineer named a
 * shell command, the harness RAN it, and the submission was refused unless it
 * exited 0 — plus a ladder of refusals for commands that could not really fail
 * (`--help`, a trailing `; true`, a heredoc that vanishes, a resubmission over an
 * unchanged tree). Each was written against a real observed dodge, and as a way
 * of making a coding agent honest it worked.
 *
 * It was also the wrong shape for this system. jedd's correction: the harness has
 * to be able to run a project that is a film, a document, a dataset, a piece of
 * music — things with no test suite, no exit code, and nothing for an automated
 * check to be right or wrong about. Worse, an automated check that is WRONG holds
 * up a product that is fine, and there is nobody to appeal to. A harness that can
 * only accept work it knows how to execute is a harness that only does software.
 *
 * So verification is now whatever actually fits the work — the output of a run, a
 * screenshot of the thing on screen, a log, an account of what was tried and what
 * happened — and the manager may ASK for a particular kind in the contract, as a
 * request rather than a rule. Nothing here refuses. What it does is make the
 * evidence real where it can: if the engineer offers a command, the harness runs
 * it and puts the ACTUAL output in front of the manager, rather than the
 * engineer's account of the output.
 *
 * The verification that decides anything is the hierarchy: the manager uses the
 * product and looks for what is broken, an auditor traces it, and the CEO asks
 * whether it is what was asked for. This tool exists so those people are looking
 * at something real.
 *
 * Node child_process only. Never throws.
 */

import { execFile } from 'node:child_process';

/** The name the prompts and the allowlist must agree on. */
export const SUBMIT_WORK_TOOL = 'submit_work';

/** One piece of finished work, as the manager receives it. */
export interface SubmittedWork {
  /** What the engineer built. */
  readonly summary: string;
  /** How it says it checked — free-form, whatever suits this work. */
  readonly verification: string;
  /** The command it offered as evidence, if any. */
  readonly command?: string;
  /** What that command actually printed when the harness ran it. */
  readonly output?: string;
  /** Whether it exited 0 — reported, never enforced. */
  readonly ok?: boolean;
  /** Something wrong the engineer saw OUTSIDE its own files, for the manager to
   * route. Engineers report rather than reach in: two people editing one file is
   * how a build breaks, and the owner has context the finder does not. */
  readonly noticed?: string;
}

export interface SubmitWorkOptions {
  /** Where an offered command runs — the product workspace. */
  readonly cwd: string;
  /** Max time a command may take. Default 5 minutes. */
  readonly timeoutMs?: number;
  /** Called on every submission, with whatever evidence came with it. */
  readonly onSubmitted?: (work: SubmittedWork) => void;
}

const MAX_OUTPUT = 4000;

/** Run whatever the engineer offered as evidence. Never throws: a command that
 * cannot run is a fact about the evidence, not a reason to lose the work. */
export async function runEvidence(
  command: string,
  opts: SubmitWorkOptions,
): Promise<{ ok: boolean; output: string; exitCode: number | null }> {
  return await new Promise((resolve) => {
    // Through a shell on purpose: engineers offer real command lines, pipes and
    // `&&` included, and rewriting them would break valid evidence.
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
 * What the engineer is told back. Always an acceptance — the manager decides
 * whether the work is good, not this tool — but an honest one: if the evidence
 * command failed, it is shown that, and asked to think again before handing over.
 */
export function submissionReply(work: SubmittedWork): string {
  const lines = [`Recorded. Your work and its evidence have gone to the manager.`];
  if (work.command !== undefined) {
    lines.push(
      ``,
      `I ran \`${work.command}\` myself, so the manager sees what it really printed:`,
      ``,
      work.output ?? '(no output)',
    );
    if (work.ok === false) {
      lines.push(
        ``,
        `NOTE: that exited non-zero. Nothing is stopping you handing this over — you may`,
        `have a good reason — but if it was meant to pass, fix it and submit again before`,
        `the manager starts testing against it.`,
      );
    }
  }
  lines.push(
    ``,
    `The manager will now use what you built and look for what is wrong with it. Expect`,
    `it to come back if something does not work; that is the process, not a judgement.`,
  );
  return lines.join('\n');
}

/** The submitted work, rendered for the manager's message. */
export function submissionNote(agentId: string, work: SubmittedWork): string {
  const lines = [
    `[${agentId} SUBMITTED WORK]`,
    work.summary,
    ``,
    `How they say they checked it:`,
    work.verification,
  ];
  if (work.command !== undefined) {
    lines.push(
      ``,
      `They offered a command as evidence, and I ran it — exit ${work.ok === true ? '0' : 'non-zero'}:`,
      `  ${work.command}`,
      (work.output ?? '').slice(-1200),
    );
  }
  if (work.noticed !== undefined) {
    lines.push(``, `THEY NOTICED SOMETHING OUTSIDE THEIR OWN FILES — route this:`, work.noticed);
  }
  return lines.join('\n');
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

/** Build the `submit_work` tool for one engineer. */
export function createSubmitWorkTool(opts: SubmitWorkOptions): ToolLike {
  return {
    name: SUBMIT_WORK_TOOL,
    label: SUBMIT_WORK_TOOL,
    description:
      'Hand your finished piece back to the manager, with evidence that it works. Evidence is ' +
      'whatever actually suits what you built — the output of running it, a screenshot of it on ' +
      'screen, a log, what you tried and what happened. If your manager asked for a particular ' +
      'kind of evidence, give that. Nothing here refuses your work; the manager will use what ' +
      'you built and tell you if something is wrong.',
    promptSnippet: 'Hand finished work to the manager, with evidence.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'What you built, and which files it lives in.',
        },
        verification: {
          type: 'string',
          description:
            'How you know it works. Whatever fits this work: what you ran and what it printed, ' +
            'a screenshot you saved and where, the cases you tried by hand and what happened. ' +
            'Be specific — "it works" tells the manager nothing it can act on.',
        },
        command: {
          type: 'string',
          description:
            'OPTIONAL. A command that demonstrates it, if one makes sense here. I run it and ' +
            'show the manager the real output rather than your account of it. Leave it out ' +
            'when there is nothing sensible to run.',
        },
        noticed: {
          type: 'string',
          description:
            'OPTIONAL. Anything wrong you saw OUTSIDE the files you own — do not fix those ' +
            'yourself. Say what is wrong, which file, and the fix you would make if it were ' +
            'yours. The manager routes it to whoever owns it.',
        },
      },
      required: ['summary', 'verification'],
    },
    execute: async (_id: unknown, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
      const verification = typeof p.verification === 'string' ? p.verification.trim() : '';
      const command = typeof p.command === 'string' ? p.command.trim() : '';
      const noticed = typeof p.noticed === 'string' ? p.noticed.trim() : '';

      const ran = command !== '' ? await runEvidence(command, opts) : undefined;
      const work: SubmittedWork = {
        summary,
        verification,
        ...(command !== '' ? { command } : {}),
        ...(ran !== undefined ? { output: ran.output, ok: ran.ok } : {}),
        ...(noticed !== '' ? { noticed } : {}),
      };
      opts.onSubmitted?.(work);
      return { content: [{ type: 'text', text: submissionReply(work) }], details: undefined };
    },
  };
}
