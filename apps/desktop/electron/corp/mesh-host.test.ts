/**
 * The parts of the mesh host that can be checked without a model.
 *
 * The bug these exist for is not a crash. `onSubmitted` was declared on the run
 * options AND on the host config, and forwarded between them by nothing — so run
 * 7's one accepted `submit_work`, the first any run had ever produced, left no
 * record at all and the run looked like the tool had never fired. A dropped
 * observer is silent, and silence is what makes it expensive: you go looking for
 * a wiring bug that isn't there.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STEPS_PER_MESSAGE,
  hostPassthrough,
  PASSTHROUGH_KEYS,
  productStatusNote,
} from './mesh-host';

describe('what a run hands through to its host', () => {
  it('carries every passthrough setting that was supplied', () => {
    const onActivity = (): void => {};
    const onSubmitted = (): void => {};
    const out = hostPassthrough({
      maxTokens: 2048,
      maxLiveAgents: 3,
      maxStepsPerMessage: 12,
      onActivity,
      onSubmitted,
      // Not passthrough — the run handles these itself.
      task: 'build a thing',
      cwd: '/tmp/x',
    });
    expect(out).toEqual({
      maxTokens: 2048,
      maxLiveAgents: 3,
      maxStepsPerMessage: 12,
      onActivity,
      onSubmitted,
    });
  });

  it('carries the submission observer — the one that was silently dropped', () => {
    const onSubmitted = (): void => {};
    expect(hostPassthrough({ onSubmitted })).toEqual({ onSubmitted });
  });

  it('omits what was not supplied, so the host keeps its own defaults', () => {
    // Under exactOptionalPropertyTypes, setting a key to `undefined` is NOT the
    // same as leaving it out: `{maxStepsPerMessage: undefined}` would override the
    // default with nothing and take the budget away again.
    const out = hostPassthrough({ maxTokens: 100, maxLiveAgents: undefined });
    expect(out).toEqual({ maxTokens: 100 });
    expect('maxLiveAgents' in out).toBe(false);
  });

  it('passes nothing through when nothing was given', () => {
    expect(hostPassthrough({})).toEqual({});
  });

  it('carries the acceptance-check observer too', () => {
    const onChecked = (): void => {};
    expect(hostPassthrough({ onChecked })).toEqual({ onChecked });
  });

  it('lists the keys once, where they can be read', () => {
    expect([...PASSTHROUGH_KEYS]).toEqual([
      'maxTokens',
      'maxLiveAgents',
      'maxStepsPerMessage',
      'onActivity',
      'onSubmitted',
      'onChecked',
      'onRepaired',
    ]);
  });
});

describe('what the manager is told about the product, every time', () => {
  // Run 10's manager measured once at 920s and then sent the same engineer the
  // same diagnosis four times — "cli.py is truncated at line 101" — long after
  // the file had been repaired. It was reasoning from memory about a mutable
  // world, so the current verdict is stapled to every message it receives.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pd-status-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('says PASSES when the product passes', async () => {
    writeFileSync(path.join(dir, 'run_tests.py'), 'print("all three formats round-tripped")\n');
    const note = await productStatusNote(dir);
    expect(note).toContain('measured just now');
    expect(note).toContain('PASSES');
  });

  it('carries the real failing output, so the manager forwards evidence not opinion', async () => {
    writeFileSync(
      path.join(dir, 'run_tests.py'),
      'raise SystemExit("cli.py line 101: SyntaxError: unexpected EOF while parsing")\n',
    );
    const note = await productStatusNote(dir);
    expect(note).toContain('FAILS');
    expect(note).toContain('unexpected EOF');
    expect(note).toContain('RIGHT NOW');
  });

  it('says so plainly when there is nothing to run yet', async () => {
    const note = await productStatusNote(dir);
    expect(note).toContain('NOTHING RUNNABLE YET');
  });

  it('never throws — a broken probe must not stop a message', async () => {
    await expect(productStatusNote('/definitely/not/a/directory')).resolves.toBeTypeOf('string');
  });
});

describe('the per-message work budget', () => {
  it('is generous enough for real work and finite enough to end', () => {
    // Real work is a dozen reads, a few writes and several test runs. Run 7's
    // engineer passed forty-eight calls in ONE message and had not stopped.
    expect(DEFAULT_STEPS_PER_MESSAGE).toBeGreaterThanOrEqual(12);
    expect(DEFAULT_STEPS_PER_MESSAGE).toBeLessThan(48);
  });
});
