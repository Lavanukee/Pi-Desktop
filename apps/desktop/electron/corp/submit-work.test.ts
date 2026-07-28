/**
 * Finishing is the thing a small model is worst at judging, so it is not asked
 * to. What these tests pin is that a submission cannot succeed on assertion
 * alone: the command runs, the exit code decides, and a rejection carries back
 * the output that makes the next attempt informed rather than a guess.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUBMIT_WORK_TOOL, cannotFailReply, createSubmitWorkTool, proofCannotFail, proofLooksHollow, runProof, submissionReply } from './submit-work';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pd-submit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const textOf = (result: unknown): string => {
  const r = result as { content?: Array<{ text?: string }> };
  return r.content?.[0]?.text ?? '';
};

describe('the proof is run, not taken on trust', () => {
  it('accepts a command that passes', async () => {
    writeFileSync(path.join(dir, 'run_tests.py'), 'print("3 conversions ok")\n');
    const accepted: string[] = [];
    const tool = createSubmitWorkTool({ cwd: dir, onAccepted: (w) => accepted.push(w.command) });
    const reply = textOf(
      await tool.execute(null, { command: 'python3 run_tests.py', summary: 'the converter' }),
    );
    expect(reply).toContain('ACCEPTED');
    expect(reply).toContain('3 conversions ok');
    expect(accepted).toEqual(['python3 run_tests.py']);
  });

  it('refuses a command that fails, and hands back the real output', async () => {
    writeFileSync(
      path.join(dir, 'run_tests.py'),
      'raise SystemExit("csv->yaml lost the second row")\n',
    );
    const rejected: string[] = [];
    const tool = createSubmitWorkTool({ cwd: dir, onRejected: (c) => rejected.push(c) });
    const reply = textOf(
      await tool.execute(null, { command: 'python3 run_tests.py', summary: 'done!' }),
    );
    expect(reply).toContain('NOT ACCEPTED');
    expect(reply).toContain('lost the second row');
    expect(reply).toContain('not finished until this passes');
    expect(rejected).toHaveLength(1);
  });

  it('refuses a submission with no command at all', async () => {
    const tool = createSubmitWorkTool({ cwd: dir });
    const reply = textOf(await tool.execute(null, { summary: 'all done' }));
    expect(reply).toContain('NOT ACCEPTED');
    expect(reply).toContain('no command');
  });

  it('runs through a shell, so real command lines work', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    const result = await runProof('cat a.txt && echo " world"', { cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('a command that cannot run at all is a rejection, never a pass', async () => {
    const result = await runProof('definitely-not-a-real-binary-xyz', { cwd: dir });
    expect(result.ok).toBe(false);
  });

  it('never throws, whatever the command does', async () => {
    const tool = createSubmitWorkTool({ cwd: dir });
    await expect(tool.execute(null, { command: 'exit 7', summary: 'x' })).resolves.toBeDefined();
    await expect(tool.execute(null, undefined)).resolves.toBeDefined();
  });
});

describe('a proof that cannot fail is refused before it runs', () => {
  // Run 8's engineer:1, verbatim and ACCEPTED. The Python underneath was real —
  // it converted files and asserted on the results. `; true` runs last, so the
  // command exits 0 either way. Everything before the final four characters looks
  // exactly like diligence, which is what makes it worse than `--help`.
  const RUN_8 = `python3 << 'EOF' && rm -f *.json *.csv *.yaml 2>/dev/null; true`;

  it('refuses run 8\u2019s accepted submission', () => {
    expect(proofCannotFail(RUN_8)).toBe(true);
  });

  it.each([
    'python3 run_tests.py; true',
    'python3 run_tests.py ; true',
    'make test || true',
    'python3 run_tests.py || :',
    './check.sh; exit 0',
    'npm test || exit 0',
    'python3 run_tests.py || echo "tests failed"',
    'pytest -q && echo done; true',
  ])('refuses %s', (cmd) => {
    expect(proofCannotFail(cmd)).toBe(true);
  });

  it.each([
    'python3 run_tests.py',
    'make test',
    'npm test',
    './check.sh',
    'python3 -m pytest -q',
    // Hides OUTPUT, not the exit code — still a real verdict.
    'python3 run_tests.py 2>/dev/null',
    // Ends non-zero on failure: the verdict survives.
    'python3 run_tests.py || exit 1',
    // `true` appears, but not as the thing that decides the exit code.
    'python3 -c "assert True"',
    'python3 convert.py in.json out.csv && python3 verify.py out.csv',
  ])('still accepts %s', (cmd) => {
    expect(proofCannotFail(cmd)).toBe(false);
  });

  it('tells the engineer what to remove, and where cleanup belongs', () => {
    const reply = cannotFailReply(RUN_8);
    expect(reply).toContain('NOT ACCEPTED');
    expect(reply).toContain('exits 0 whether your work is right or wrong');
    expect(reply).toContain('INSIDE your script');
  });
});

describe('a proof that proves nothing is refused before it runs', () => {
  // Run 7, engineer:2, verbatim. It exited 0 and nothing had been converted.
  const RUN_7 = 'python3 convert.py --help && ./convert.sh --help && echo "CLI interfaces working"';

  it('catches the run-7 submission', () => {
    expect(proofLooksHollow(RUN_7)).toBe(true);
  });

  it('catches the other shapes of proof-by-nothing', () => {
    for (const c of [
      'echo done',
      'ls -la src/',
      'true',
      'python3 convert.py --version',
      'cat src/converter.py | head -20',
      'which python3 && echo ok',
    ]) {
      expect(proofLooksHollow(c), c).toBe(true);
    }
  });

  it('leaves real proofs alone, including ones that mention --help in passing', () => {
    for (const c of [
      'python3 run_tests.py',
      'make test',
      'python3 convert.py --help && python3 run_tests.py',
      'python3 -c "import converter; assert converter.to_csv({}) == \'\'"',
      'npm test',
      './check.sh',
    ]) {
      expect(proofLooksHollow(c), c).toBe(false);
    }
  });

  it('refuses without running, and says what a proof has to do', async () => {
    // No file is created — if this ran anything at all it would have to fail.
    const rejected: string[] = [];
    const tool = createSubmitWorkTool({ cwd: dir, onRejected: (c) => rejected.push(c) });
    const reply = textOf(await tool.execute(null, { command: RUN_7, summary: 'CLI done' }));
    expect(reply).toContain('NOT ACCEPTED');
    expect(reply).toContain('would pass without your work doing anything');
    expect(reply).toContain('compare the output');
    expect(rejected).toEqual([RUN_7]);
  });

  it('an empty command is hollow too', () => {
    expect(proofLooksHollow('   ')).toBe(true);
  });
});

describe('what the engineer is told', () => {
  it('a rejection points at WHICH FILE the error is in', () => {
    // The lesson from run 4: an engineer spent 45 turns rewriting working code to
    // satisfy its own broken test, because a failure reads as "the product is
    // wrong" unless something says otherwise.
    const reply = submissionReply('python3 run_tests.py', {
      ok: false,
      output: 'NameError: yaml_module is not defined',
      exitCode: 1,
    });
    expect(reply).toContain('WHICH FILE');
    expect(reply).toContain('if it is your test, the test is what is wrong');
    expect(reply).toContain('Do not rewrite working code');
  });

  it('an acceptance tells it to quote the command onward', () => {
    const reply = submissionReply('make test', { ok: true, output: 'ok', exitCode: 0 });
    expect(reply).toContain('ACCEPTED');
    expect(reply).toContain('quoting this command');
  });

  it('the tool is named the same everywhere', () => {
    expect(SUBMIT_WORK_TOOL).toBe('submit_work');
    expect(createSubmitWorkTool({ cwd: dir }).name).toBe(SUBMIT_WORK_TOOL);
  });
});
