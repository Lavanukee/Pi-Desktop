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
import { SUBMIT_WORK_TOOL, cannotFailReply, createSubmitWorkTool, productStillRedNote, proofCannotFail, proofLooksHollow, proofIsEphemeral, runProof, submissionReply, type SubmitWorkOptions, type SubmittedWork, unchangedReply } from './submit-work';

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

describe('resubmitting into an unchanged tree', () => {
  // Run 13's last twenty minutes: 1200 seconds, ZERO file writes, three
  // submissions of a command already refused. Run 12: three byte-identical
  // rejections. The rejection carries the real traceback and ends "Fix it and
  // call submit_work again" — and the model reads the second half.
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(path.join(os.tmpdir(), 'pd-again-'));
    writeFileSync(path.join(ws, 'verify.py'), 'raise SystemExit("6 failed, 11 passed")\n');
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const submit = async (tool: ReturnType<typeof createSubmitWorkTool>): Promise<string> => {
    const res = (await tool.execute(undefined, {
      command: 'python3 verify.py',
      summary: 'converter',
    })) as { content: Array<{ text: string }> };
    return res.content[0]?.text ?? '';
  };

  it('runs the first failure, then refuses the identical retry without running it', async () => {
    const tool = createSubmitWorkTool({ cwd: ws, timeoutMs: 60_000 });
    const first = await submit(tool);
    expect(first).toContain('NOT ACCEPTED');
    expect(first).toContain('6 failed, 11 passed');

    const second = await submit(tool);
    expect(second).toContain('NOT RUN');
    expect(second).toContain('NOTHING in the');
  });

  it('names what to change, including that the TEST may be the wrong thing', async () => {
    const reply = unchangedReply('python3 -m pytest -q');
    expect(reply).toContain('python3 -m pytest -q');
    expect(reply).toContain('cannot be done at all');
    expect(reply).toContain('talk_to the manager');
  });

  it('lets the same command through once the product actually changes', async () => {
    const tool = createSubmitWorkTool({ cwd: ws, timeoutMs: 60_000 });
    expect(await submit(tool)).toContain('NOT ACCEPTED');
    // The engineer fixes something — the tree is different, so the command runs.
    writeFileSync(path.join(ws, 'verify.py'), 'print("17 passed")\n');
    const third = await submit(tool);
    expect(third).not.toContain('NOT RUN');
    expect(third).toContain('ACCEPTED');
  });

  it('a NEW command is always run, even over an unchanged tree', async () => {
    const tool = createSubmitWorkTool({ cwd: ws, timeoutMs: 60_000 });
    expect(await submit(tool)).toContain('NOT ACCEPTED');
    const res = (await tool.execute(undefined, {
      command: 'python3 verify.py --verbose',
      summary: 'converter',
    })) as { content: Array<{ text: string }> };
    expect(res.content[0]?.text ?? '').not.toContain('NOT RUN');
  });
});

describe('a proof must outlive the conversation, but need not fix the whole product', () => {
  // Run 8's engineer proved its work with a heredoc and left a broken test file
  // behind. Requiring the WHOLE product to pass fixed that and built something
  // worse: with four engineers on four pieces, whoever finishes first is refused
  // for the three pieces nobody has written yet, so nobody can ever be first.
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(path.join(os.tmpdir(), 'pd-proof-'));
    writeFileSync(path.join(ws, 'check_gui.py'), 'print("gui ok")\n');
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const submit = async (command: string, extra = {}): Promise<string> => {
    const tool = createSubmitWorkTool({ cwd: ws, timeoutMs: 60_000, ...extra } as SubmitWorkOptions);
    const res = (await tool.execute(undefined, { command, summary: 'gui' })) as {
      content: Array<{ text: string }>;
    };
    return res.content[0]?.text ?? '';
  };

  it('refuses a heredoc — it runs nothing that will still exist', async () => {
    const text = await submit("python3 << 'EOF'\nassert 1 == 1\nEOF");
    expect(text).toContain('NOT ACCEPTED');
    expect(text).toContain('does not run anything that exists');
  });

  it('accepts a command that runs a real file in the workspace', async () => {
    expect(await submit('python3 check_gui.py')).toContain('ACCEPTED');
  });

  it('asks only whether someone else could run it tomorrow — no stack knowledge', () => {
    // Anything repeatable passes, whatever the ecosystem, with nothing listed.
    for (const ok of [
      'make test',
      'swift build && swift test',
      'cargo test',
      './check',
      'node run.js',
      'dotnet test',
      'python3 check_gui.py',
    ]) {
      expect(proofIsEphemeral(ok)).toBe(false);
    }
    // Only what vanishes with the conversation is refused.
    for (const gone of ['python3 -c "assert True"', "node -e 'process.exit(0)'", "sh << 'EOF'\nexit 0\nEOF"]) {
      expect(proofIsEphemeral(gone)).toBe(true);
    }
  });

  it('ACCEPTS a piece whose own check passes while the product is still red', async () => {
    // The whole point: engineer:1 must be able to finish before engineers 2-4 exist.
    const accepted: string[] = [];
    const text = await submit('python3 check_gui.py', {
      onAccepted: (w: SubmittedWork) => accepted.push(w.command),
      checkProduct: async () => ({
        ran: true,
        ok: false,
        command: 'python3 -m pytest -q',
        output: 'ModuleNotFoundError: no module named converter_engine',
        how: 'pytest',
      }),
    });
    expect(text).toContain('ACCEPTED');
    expect(accepted).toEqual(['python3 check_gui.py']);
    // ...and it is TOLD, so it knows the product is red without being blocked by it.
    expect(text).toContain('does not pass yet');
    expect(text).toContain('converter_engine');
  });

  it('tells them to route a failure in someone else’s file', () => {
    const note = productStillRedNote({
      ran: true,
      ok: false,
      command: 'python3 -m pytest -q',
      output: 'boom',
      how: 'pytest',
    });
    expect(note).toContain('tell the manager');
    expect(note).toContain('do not go and edit around it');
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
