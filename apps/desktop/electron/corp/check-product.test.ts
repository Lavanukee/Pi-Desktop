/**
 * What the team sees when it checks itself.
 *
 * The bug this closes is run 7's: a test file whose helper was defined in the
 * wrong class, which failed the instant anything ran it whole — and the only
 * thing that ran it whole was the gate, thirty minutes later, once. So these
 * pin the two properties that make the tool worth having: it runs the SAME check
 * the gate runs, and it hands back the real output either way.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECK_PRODUCT_TOOL, checkReply, createCheckProductTool } from './check-product';
import { runProductGate } from './product-gate';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pd-check-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, body: string): void => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};

/** Call the tool the way the SDK does. */
const runTool = async (
  tool: unknown,
): Promise<{ text: string }> => {
  const t = tool as { execute: () => Promise<{ content: Array<{ text: string }> }> };
  const res = await t.execute();
  return { text: res.content[0]?.text ?? '' };
};

describe('the reply the team reads', () => {
  it('says PASSES and names the command, so there is nothing left to interpret', () => {
    const text = checkReply({
      ran: true,
      ok: true,
      command: 'python3 -m pytest -q',
      how: 'pytest',
      output: '5 passed',
      exitCode: 0,
      timedOut: false,
    });
    expect(text).toContain('PASSES');
    expect(text).toContain('python3 -m pytest -q');
    expect(text).toContain('5 passed');
  });

  it('hands back the REAL failure, not a summary of it', () => {
    const text = checkReply({
      ran: true,
      ok: false,
      command: 'python3 -m pytest -q',
      how: 'pytest',
      output: "AttributeError: 'TestRoundTripJSONCSV' object has no attribute '_compare_dicts'",
      exitCode: 1,
      timedOut: false,
    });
    // Run 7's actual error. A small model fixes this from the traceback and
    // cannot fix it from "the tests are failing".
    expect(text).toContain('_compare_dicts');
    expect(text).toContain('python3 -m pytest -q');
    expect(text).not.toContain('PASSES');
  });

  it('an unverifiable product is reported as unverifiable, never as fine', () => {
    const text = checkReply({
      ran: false,
      ok: false,
      command: '',
      how: 'nothing runnable found',
      output: 'No test, no build, no runnable entry point was found in the product.',
      exitCode: null,
      timedOut: false,
    });
    expect(text).toContain('cannot be verified');
    expect(text).not.toContain('PASSES');
  });
});

describe('the tool itself', () => {
  it('is the name the prompts and the allowlist use', () => {
    expect(CHECK_PRODUCT_TOOL).toBe('check_product');
  });

  it('takes no arguments — a call a small model cannot get wrong', () => {
    const t = createCheckProductTool({ cwd: dir }) as {
      parameters: { properties: Record<string, unknown>; required: string[] };
    };
    expect(Object.keys(t.parameters.properties)).toEqual([]);
    expect(t.parameters.required).toEqual([]);
  });

  it('runs the product’s real check and reports a pass', async () => {
    write('check', 'echo "all cases passed"\nexit 0\n');
    const seen: Array<{ ok: boolean; command: string }> = [];
    const tool = createCheckProductTool({
      cwd: dir,
      timeoutMs: 60_000,
      onChecked: (r) => seen.push({ ok: r.ok, command: r.command }),
    });
    const { text } = await runTool(tool);
    expect(text).toContain('PASSES');
    expect(text).toContain('all cases passed');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ok).toBe(true);
  });

  it('reports a failure with its output, and tells the observer', async () => {
    write('check', 'echo "the widget came back empty" >&2\nexit 1\n');
    const seen: boolean[] = [];
    const tool = createCheckProductTool({
      cwd: dir,
      timeoutMs: 60_000,
      onChecked: (r) => seen.push(r.ok),
    });
    const { text } = await runTool(tool);
    expect(text).toContain('the widget came back empty');
    expect(seen).toEqual([false]);
  });

  it('agrees with the gate — same tree, same verdict', async () => {
    // The whole point. If these could ever disagree, the tool would be teaching
    // the team to build toward the wrong target.
    write('check', 'exit 3\n');
    const gate = await runProductGate(dir, { timeoutMs: 60_000 });
    const { text } = await runTool(createCheckProductTool({ cwd: dir, timeoutMs: 60_000 }));
    expect(gate.ok).toBe(false);
    expect(text).toContain(gate.command);
    expect(text).toBe(checkReply(gate));
  });
});
