/**
 * The gate is the whole "ledger is the truth" half of the design, so what these
 * tests pin is the thing that is easy to get wrong under pressure: an
 * unverifiable product must NOT pass. A corp run that talks well and ships
 * nothing runnable has to come out red.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('finding the check the TEAM declared', () => {
  it('runs an executable `check` at the root, whatever the project is', () => {
    write('check', '#!/bin/sh\nexit 0\n');
    expect(findGate(dir)?.how).toBe('declared check (check)');
  });

  it('accepts the other spellings', () => {
    write('verify.sh', '#!/bin/sh\nexit 0\n');
    expect(findGate(dir)?.how).toBe('declared check (verify.sh)');
  });

  it('enforces NO testing mechanism of its own', () => {
    // Everything here used to be auto-discovered, which meant the harness was
    // deciding what testing looks like — and a project in a stack nobody listed
    // was ungradable. The team declares its check or the product is unverifiable.
    write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    write('Makefile', 'test:\n\techo ok\n');
    write('run_tests.py', 'assert True');
    write('test_thing.py', 'assert True');
    write('Package.swift', '// swift-tools-version:5.9');
    write('project.godot', '[application]');
    expect(findGate(dir)).toBeUndefined();
  });

  it('finds nothing in an empty or prose-only product', () => {
    expect(findGate(dir)).toBeUndefined();
    write('README.md', '# we built it, trust us');
    expect(findGate(dir)).toBeUndefined();
  });
});

describe('running it decides, not the team', () => {
  it('a passing check passes', async () => {
    write('check', 'echo "everything converted"\nexit 0\n');
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.how).toBe('declared check (check)');
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('everything converted');
  });

  it('runs an EXECUTABLE check through its own shebang, not through sh', async () => {
    // The check may be written in anything. Assuming `sh` would break every
    // declared check that is not a shell script, which is most of them.
    const file = path.join(dir, 'check');
    writeFileSync(file, '#!/usr/bin/env python3\nprint("python check ran")\n');
    chmodSync(file, 0o755);
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('python check ran');
  });

  it('a FAILING check fails, and the output is carried back', async () => {
    write('check', 'echo "the output had the wrong number of rows" >&2\nexit 1\n');
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('wrong number of rows');
    const feedback = gateFeedback(result);
    expect(feedback).toContain(result.command);
    expect(feedback).toContain('wrong number of rows');
    expect(feedback).toContain('exits 0');
  });

  it('a check that ran ZERO tests is NOT a pass', async () => {
    // "Ran 0 tests ... OK" and exit 0 is a green light for a product nobody
    // tested — the narrative sign-off this gate exists to end.
    write('check', 'echo "Ran 0 tests in 0.000s"\necho OK\nexit 0\n');
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('ZERO tests');
  });

  it('a check that PRINTS a failure and exits 0 is not a pass', async () => {
    // The only shape that produces a FALSE GREEN — work that was checked and
    // FAILED, then blessed. Everything else here refuses work never checked.
    write('check', 'echo "FAIL: the widget never came back"\nexit 0\n');
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('exited 0');
  });

  it('a swallowed traceback is not a pass either', async () => {
    write('check', 'printf "Traceback (most recent call last)\\n  ValueError\\n"\nexit 0\n');
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(false);
  });

  it('does NOT refuse a passing run that merely mentions failure', async () => {
    // Narrowness matters: a case named for what it guards against, and a summary
    // line reading "0 failed", must both still pass.
    write('check', 'echo "case_fails_on_bad_input: ok"\necho "7 passed, 0 failed"\nexit 0\n');
    const result = await runProductGate(dir, { timeoutMs: 60_000 });
    expect(result.ok).toBe(true);
  });

  it('an unverifiable product is NOT a pass', async () => {
    write('README.md', '# It is production ready, trust us.');
    write('src/thing.py', 'print("hi")');
    const result = await runProductGate(dir);
    expect(result.ran).toBe(false);
    expect(result.ok).toBe(false); // the point: prose is not delivery
    expect(gateFeedback(result)).toContain('cannot be verified');
  });

  it('a check that cannot be executed reports a capability gap, never a pass', async () => {
    const file = path.join(dir, 'check');
    writeFileSync(file, '#!/usr/bin/env definitely-not-a-real-interpreter\n');
    chmodSync(file, 0o755);
    const result = await runProductGate(dir, { timeoutMs: 20_000 });
    expect(result.ok).toBe(false);
  });
});
