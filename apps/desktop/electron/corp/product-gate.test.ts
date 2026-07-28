/**
 * The gate is the whole "ledger is the truth" half of the design, so what these
 * tests pin is the thing that is easy to get wrong under pressure: an
 * unverifiable product must NOT pass. A corp run that talks well and ships
 * nothing runnable has to come out red.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findGate, gateFeedback, runProductGate } from './product-gate';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pd-gate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, body: string) => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};

describe('finding the product’s own check', () => {
  it('believes a declared `check` above everything — the stack-agnostic path', () => {
    // The point: a project in a language nobody put in the discovery list is
    // still gradable, because the TEAM says what proving it means.
    write('check', '#!/bin/sh\nexit 0\n');
    write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    write('Package.swift', '// swift-tools-version:5.9');
    expect(findGate(dir)?.how).toBe('declared check (check)');
  });

  it('accepts the other declared spellings', () => {
    write('verify.sh', '#!/bin/sh\nexit 0\n');
    expect(findGate(dir)?.how).toBe('declared check (verify.sh)');
  });

  it('believes a declared test script first', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    write('test_x.py', 'assert True');
    expect(findGate(dir)?.how).toBe('package.json test script');
  });

  it('falls through package.json without a test script', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    write('test_convert.py', 'assert True');
    // pytest OR unittest depending on what is installed — never `-m pytest` on a
    // machine without it, which would read as a broken product.
    expect(['pytest', 'unittest discover']).toContain(findGate(dir)?.how);
  });

  it('finds a Makefile test target, a python test, and a godot project', () => {
    write('Makefile', 'build:\n\techo hi\ntest:\n\techo ok\n');
    expect(findGate(dir)?.how).toBe('Makefile test target');
    rmSync(path.join(dir, 'Makefile'));

    write('tests/test_a.py', 'assert True');
    expect(['pytest', 'unittest discover']).toContain(findGate(dir)?.how);
    rmSync(path.join(dir, 'tests'), { recursive: true });

    write('project.godot', '[application]');
    expect(findGate(dir)?.how).toBe('godot headless import');
  });

  it('finds a Swift package — the gate was blind to macOS GUI work', () => {
    // Discovery matched nothing a Swift app contains, so the GUI engineer could
    // not be graded, and its tempting fix was to plant a run_tests.py at the root
    // and become everyone else's acceptance check.
    write('Package.swift', '// swift-tools-version:5.9');
    expect(findGate(dir)?.how).toBe('swift build');
  });

  it('finds nothing in an empty or prose-only product', () => {
    expect(findGate(dir)).toBeUndefined();
    write('README.md', '# we built it, trust us');
    expect(findGate(dir)).toBeUndefined();
  });
});

describe('running it decides, not the team', () => {
  it('a passing check passes', async () => {
    // A standalone runner needs nothing installed, so this must genuinely pass.
    write('run_tests.py', 'assert 1 + 1 == 2\nprint("converted fine")\n');
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.how).toBe('python test script');
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('converted fine');
  });

  it('prefers a standalone runner over a test framework that may not exist', () => {
    write('run_tests.py', 'print("ok")');
    write('test_a.py', 'assert True');
    expect(findGate(dir)?.how).toBe('python test script');
  });

  it('a FAILING check fails, and the output is carried back', async () => {
    write('run_tests.py', 'raise SystemExit("conversion produced the wrong number of rows")\n');
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.ran).toBe(true);
    {
      expect(result.ok).toBe(false);
      expect(result.output).toContain('wrong number of rows');
      // The feedback must hand the team the COMMAND and the real output — that is
      // the difference between a small model fixing it and guessing.
      const feedback = gateFeedback(result);
      expect(feedback).toContain(result.command);
      expect(feedback).toContain('wrong number of rows');
      expect(feedback).toContain('exits 0');
    }
  });

  it('a check that ran ZERO tests is NOT a pass', async () => {
    // `unittest discover` over an empty tests/ prints "Ran 0 tests ... OK" and
    // EXITS 0. Trusting the exit code alone would green-light a product nobody
    // tested — the exact narrative sign-off this gate exists to end.
    //
    // Which runner answers depends on whether pytest is importable on the machine
    // running these tests, and the two disagree about the exit code (unittest says
    // 0, pytest says 5). So this pins the BEHAVIOUR — an empty run never counts —
    // rather than a number that says more about the box than about the gate.
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('ZERO tests');
  });

  it('a check that PRINTS a failure and exits 0 is not a pass', async () => {
    // Run 11's run_tests.py, exactly: a hand-rolled runner that collects results,
    // prints them, and forgets to make the exit code depend on them. This is the
    // only shape that produces a FALSE GREEN — work that was checked and FAILED,
    // blessed. Everything else here refuses work that was never checked at all.
    write(
      'run_tests.py',
      'print("FAIL JSON->CSV: No module named mesh_converter.main")\n',
    );
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.ran).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('exited 0');
  });

  it('a swallowed traceback is not a pass either', async () => {
    write(
      'run_tests.py',
      'import traceback\ntry:\n    raise ValueError("csv rows lost")\nexcept Exception:\n    traceback.print_exc()\n',
    );
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(false);
  });

  it('does NOT refuse a passing run that merely mentions failure', async () => {
    // The narrowness matters: a test named for what it guards against, or a
    // summary line reading "0 failed", must still pass.
    write(
      'run_tests.py',
      'print("test_fails_on_bad_input: ok")\nprint("7 passed, 0 failed")\n',
    );
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.ok).toBe(true);
  });

  it('an unverifiable product is NOT a pass', async () => {
    write('README.md', '# The converter is production ready.');
    write('notes.txt', 'everything works');
    const result = await runProductGate(dir);
    expect(result.ran).toBe(false);
    expect(result.ok).toBe(false); // the point: prose is not delivery
    expect(gateFeedback(result)).toContain('cannot be verified');
  });

  it('a missing toolchain reports a capability gap, it does not pass', async () => {
    // A godot project on a machine with no godot: honest "could not run", never ok.
    write('project.godot', '[application]\nconfig/name="Flight"');
    const result = await runProductGate(dir, { timeoutMs: 20_000 });
    expect(result.ok).toBe(false);
    if (!result.ran) expect(result.output).toContain('not installed');
  });
});
