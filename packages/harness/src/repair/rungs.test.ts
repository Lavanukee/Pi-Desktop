import { repairToolCallArguments } from '@pi-desktop/provider-llamacpp';
import { describe, expect, it, vi } from 'vitest';
import { createHarnessExtraRungs, type HarnessRepairDeps } from './rungs.js';
import type { ToolSchemaLike } from './types.js';

const SCHEMA: ToolSchemaLike = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};

/** Deps backed by a shared per-tool failure counter, with spies on every seam. */
function makeDeps(
  overrides: Partial<HarnessRepairDeps> = {},
): Required<
  Pick<
    HarnessRepairDeps,
    | 'onRung'
    | 'recordFailureShownToModel'
    | 'bumpFailureCount'
    | 'getFailureCount'
    | 'confirmRelax'
    | 'relaxSchema'
    | 'abort'
  >
> &
  HarnessRepairDeps {
  const counts = new Map<string, number>();
  return {
    onRung: vi.fn(),
    recordFailureShownToModel: vi.fn(),
    bumpFailureCount: vi.fn((t: string) => {
      const n = (counts.get(t) ?? 0) + 1;
      counts.set(t, n);
      return n;
    }),
    getFailureCount: (t: string) => counts.get(t) ?? 0,
    confirmRelax: vi.fn(async () => true),
    relaxSchema: vi.fn(),
    abort: vi.fn(),
    ...overrides,
  };
}

describe('createHarnessExtraRungs — shape', () => {
  it('returns exactly three ordered rungs (3, 4, 5)', () => {
    expect(createHarnessExtraRungs().length).toBe(3);
  });
});

describe('repair ladder escalation (through the provider real repairToolCallArguments)', () => {
  it('rung 4: relaxes schema on a parseable-but-invalid call after user approval', async () => {
    const deps = makeDeps();
    const result = await repairToolCallArguments('{"wrong":1}', {
      toolName: 'read',
      schema: SCHEMA,
      extraRungs: createHarnessExtraRungs(deps),
    });

    expect(result.ok).toBe(true);
    expect(result.rung).toBe(4);
    expect(result.value).toEqual({ wrong: 1 });
    // Rung 3 recorded the "shown to model" boundary...
    expect(deps.recordFailureShownToModel).toHaveBeenCalledWith('read');
    // ...rung 4 counted, confirmed, and relaxed.
    expect(deps.bumpFailureCount).toHaveBeenCalledWith('read');
    expect(deps.confirmRelax).toHaveBeenCalledOnce();
    expect(deps.relaxSchema).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'read', current: { wrong: 1 } }),
    );
    expect(deps.abort).not.toHaveBeenCalled();
    // onRung fired for rungs 3 and 4 (not 5 — resolved before it).
    const rungsSeen = vi.mocked(deps.onRung).mock.calls.map((c) => (c[0] as { rung: number }).rung);
    expect(rungsSeen).toContain(3);
    expect(rungsSeen).toContain(4);
    expect(rungsSeen).not.toContain(5);
  });

  it('rung 5: aborts an unparseable call once the failure threshold is hit', async () => {
    const deps = makeDeps({ abortThreshold: 1 });
    const result = await repairToolCallArguments('total garbage {{{', {
      toolName: 'bash',
      schema: SCHEMA,
      extraRungs: createHarnessExtraRungs(deps),
    });

    expect(result.ok).toBe(false);
    // Nothing to relax → confirm/relax skipped, rung 5 aborts.
    expect(deps.confirmRelax).not.toHaveBeenCalled();
    expect(deps.relaxSchema).not.toHaveBeenCalled();
    expect(deps.abort).toHaveBeenCalledWith({ toolName: 'bash', count: 1 });
  });

  it('rung 4 decline → falls to rung 5 but does not abort below threshold', async () => {
    const deps = makeDeps({ confirmRelax: vi.fn(async () => false), abortThreshold: 3 });
    const result = await repairToolCallArguments('{"wrong":1}', {
      toolName: 'read',
      schema: SCHEMA,
      extraRungs: createHarnessExtraRungs(deps),
    });

    expect(result.ok).toBe(false);
    expect(deps.confirmRelax).toHaveBeenCalledOnce();
    expect(deps.relaxSchema).not.toHaveBeenCalled();
    expect(deps.abort).not.toHaveBeenCalled();
  });

  it('does not reach the harness rungs when rung 1/2 already succeed', async () => {
    const deps = makeDeps();
    const result = await repairToolCallArguments('{"path":"/etc/hosts"}', {
      toolName: 'read',
      schema: SCHEMA,
      extraRungs: createHarnessExtraRungs(deps),
    });
    expect(result.ok).toBe(true);
    expect(result.rung).toBe(2);
    expect(deps.onRung).not.toHaveBeenCalled();
  });
});
