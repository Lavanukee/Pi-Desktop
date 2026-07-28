/**
 * Handing work back is a REPORT, not a gate.
 *
 * The refusal ladder these tests used to pin — hollow proofs, `; true`, heredocs,
 * resubmission over an unchanged tree, the whole product having to pass — is gone
 * on purpose. It made a coding agent honest, and it made the harness able to
 * accept only work it knew how to execute, which is the opposite of the
 * requirement: this has to run a project that is a film or a document just as
 * well. What is pinned now is that the evidence reaching the manager is REAL, and
 * that nothing here decides whether the work is good.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSubmitWorkTool,
  runEvidence,
  SUBMIT_WORK_TOOL,
  type SubmittedWork,
  submissionNote,
  submissionReply,
} from './submit-work';

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'pd-submit-'));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const submit = async (
  params: Record<string, string>,
  onSubmitted?: (w: SubmittedWork) => void,
): Promise<string> => {
  const tool = createSubmitWorkTool({
    cwd: ws,
    timeoutMs: 60_000,
    ...(onSubmitted !== undefined ? { onSubmitted } : {}),
  });
  await tool.execute(undefined, params); // first call = the last-look prompt
  const res = (await tool.execute(undefined, params)) as { content: Array<{ text: string }> };
  return res.content[0]?.text ?? '';
};

describe('any form of verification is acceptable', () => {
  it('takes work with no command at all — a screenshot, a log, an account', async () => {
    // The case the old gate could not express: nothing here is runnable.
    const seen: SubmittedWork[] = [];
    const text = await submit(
      {
        summary: 'Cut the 40s opening sequence, in edit/opening.fcpxml',
        verification:
          'Exported it and watched it end to end. Saved a still of the title card at ' +
          '.scratch/title-card.png. Audio peaks at -3dB, no clipping.',
      },
      (w) => seen.push(w),
    );
    expect(text).toContain('Recorded');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verification).toContain('title-card.png');
    expect(seen[0]?.command).toBeUndefined();
  });

  it('runs a command when one is offered, and reports what it REALLY printed', async () => {
    writeFileSync(path.join(ws, 'demo.sh'), 'echo "converted 3 of 3"\n');
    const seen: SubmittedWork[] = [];
    const text = await submit(
      { summary: 'the converter', verification: 'ran it on three files', command: 'sh demo.sh' },
      (w) => seen.push(w),
    );
    expect(seen[0]?.ok).toBe(true);
    expect(seen[0]?.output).toContain('converted 3 of 3');
    expect(text).toContain('converted 3 of 3');
  });

  it('ACCEPTS the work even when the offered command fails, and says so plainly', async () => {
    // The point of the change: nothing here holds up the work. The engineer is
    // told, the manager sees it, and the manager decides.
    const seen: SubmittedWork[] = [];
    const text = await submit(
      { summary: 'the parser', verification: 'mostly works', command: 'exit 3' },
      (w) => seen.push(w),
    );
    expect(seen).toHaveLength(1); // recorded, not refused
    expect(seen[0]?.ok).toBe(false);
    expect(text).toContain('Recorded');
    expect(text).toContain('exited non-zero');
    expect(text).not.toContain('NOT ACCEPTED');
  });

  it('never refuses anything, however thin the evidence', async () => {
    const thin: Array<Record<string, string>> = [
      { summary: 'x', verification: 'it works' },
      { summary: 'x', verification: 'checked', command: 'echo done' },
      { summary: 'x', verification: 'checked', command: 'true' },
      { summary: 'x', verification: 'checked', command: 'ls' },
    ];
    for (const params of thin) {
      expect(await submit(params)).toContain('Recorded');
    }
  });

  it('survives a command that cannot run at all', async () => {
    const seen: SubmittedWork[] = [];
    await submit({ summary: 'x', verification: 'y', command: 'definitely-not-a-real-binary' }, (w) =>
      seen.push(w),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ok).toBe(false);
  });
});

describe('the first call is a last look, the second hands it over', () => {
  // jedd's shape. It puts one deliberate pause between "I think I am done" and
  // the manager's time, and it gives the tool a terminal state again — which it
  // lost when the refusals went, after which run 21's engineer submitted the same
  // summary eleven times because "Recorded" reads as an acknowledgement.
  const raw = async (
    tool: ReturnType<typeof createSubmitWorkTool>,
    params: Record<string, string>,
  ): Promise<string> => {
    const res = (await tool.execute(undefined, params)) as { content: Array<{ text: string }> };
    return res.content[0]?.text ?? '';
  };

  it('asks for a last look first, and submits nothing yet', async () => {
    const seen: SubmittedWork[] = [];
    const tool = createSubmitWorkTool({ cwd: ws, onSubmitted: (w) => seen.push(w) });
    const first = await raw(tool, { summary: 'the converter', verification: 'ran it' });
    expect(first).toContain('one last look');
    expect(first).toContain('LOOK at it');
    expect(seen).toHaveLength(0); // nothing has reached the manager
  });

  it('hands it over on the second call, whatever it says', async () => {
    const seen: SubmittedWork[] = [];
    const tool = createSubmitWorkTool({ cwd: ws, onSubmitted: (w) => seen.push(w) });
    await raw(tool, { summary: 'x', verification: 'y' });
    const second = await raw(tool, { summary: 'the converter', verification: 'looked again, fine' });
    expect(second).toContain('Recorded');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verification).toBe('looked again, fine');
  });

  it('lets the engineer change its mind between the two calls', async () => {
    // The point of the pause: what it submits second can differ from the first.
    const seen: SubmittedWork[] = [];
    const tool = createSubmitWorkTool({ cwd: ws, onSubmitted: (w) => seen.push(w) });
    await raw(tool, { summary: 'done', verification: 'it works' });
    await raw(tool, { summary: 'done, after fixing the empty-input crash', verification: 'retried' });
    expect(seen[0]?.summary).toContain('empty-input crash');
  });

  it('a NEW turn starts the pause again — the tool is rebuilt per message', async () => {
    const seen: SubmittedWork[] = [];
    const next = createSubmitWorkTool({ cwd: ws, onSubmitted: (w) => seen.push(w) });
    expect(await raw(next, { summary: 'x', verification: 'y' })).toContain('one last look');
    expect(seen).toHaveLength(0);
  });
});

describe('what the manager is handed', () => {
  it('carries the summary, the claimed check, and the REAL output', () => {
    const note = submissionNote('engineer:2', {
      summary: 'the format registry',
      verification: 'ran it against every format',
      command: 'sh check.sh',
      output: 'all 9 families detected',
      ok: true,
    });
    expect(note).toContain('engineer:2 SUBMITTED WORK');
    expect(note).toContain('the format registry');
    expect(note).toContain('How they say they checked it');
    expect(note).toContain('all 9 families detected');
    expect(note).toContain('exit 0');
  });

  it('flags an out-of-jurisdiction problem for the manager to route', () => {
    const note = submissionNote('engineer:1', {
      summary: 'the GUI',
      verification: 'opened it',
      noticed: 'src/engine returns a list where the GUI expects a record — engineer:2 owns it',
    });
    expect(note).toContain('NOTICED SOMETHING OUTSIDE THEIR OWN FILES');
    expect(note).toContain('engineer:2 owns it');
  });

  it('says a failing command failed, so the manager is not misled', () => {
    const note = submissionNote('engineer:3', {
      summary: 'the installer',
      verification: 'ran it',
      command: 'sh install.sh',
      output: 'permission denied',
      ok: false,
    });
    expect(note).toContain('non-zero');
    expect(note).toContain('permission denied');
  });
});

describe('the plumbing', () => {
  it('is the name the prompts and the allowlist use', () => {
    expect(SUBMIT_WORK_TOOL).toBe('submit_work');
  });

  it('requires only what every kind of work has: what you did and how you checked', () => {
    const t = createSubmitWorkTool({ cwd: ws }) as { parameters: { required: string[] } };
    expect(t.parameters.required).toEqual(['summary', 'verification']);
  });

  it('runEvidence never throws, whatever it is given', async () => {
    await expect(runEvidence('exit 1', { cwd: ws })).resolves.toMatchObject({ ok: false });
    await expect(runEvidence('', { cwd: ws })).resolves.toBeDefined();
  });

  it('tells the engineer the manager will now go looking for problems', () => {
    const reply = submissionReply({ summary: 'x', verification: 'y' });
    expect(reply).toContain('look for what is wrong');
    expect(reply).toContain('not a judgement');
  });
});
