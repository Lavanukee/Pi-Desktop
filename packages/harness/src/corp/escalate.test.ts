import { describe, expect, it, vi } from 'vitest';
import {
  buildManagerRescopeContractPrompt,
  buildManagerRescopePrompt,
  type EscalationRecord,
  escalateContract,
  rescopedContractFrom,
  resolveEscalation,
  runBoundedEscalation,
} from './escalate.js';
import type { Contract, OrgChart } from './org-chart.js';

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'fe-3',
    title: 'Physics integration',
    ownerNodeId: 'fe-eng-3',
    input: 'collision spec',
    output: 'a physics step function',
    slot: 'src/engine/physics.ts',
    available: { tools: [], imports: [] },
    reviewRubric: 'stable at 60fps',
    dependsOn: [],
    status: 'unfulfillable',
    ...overrides,
  };
}

function chart(overrides: Partial<OrgChart> = {}): OrgChart {
  return {
    projectId: 'p',
    nodes: [
      { id: 'ceo', role: 'ceo', name: 'CEO' },
      { id: 'manager', role: 'manager', name: 'Manager block', parentId: 'ceo' },
      { id: 'division-eng', role: 'division', name: 'Engine', parentId: 'manager' },
    ],
    contracts: [contract()],
    queue: [],
    branches: [],
    status: 'running',
    nodeStatus: {},
    ...overrides,
  };
}

describe('escalateContract (routes ONE level up to the manager)', () => {
  it('produces a record routed to the manager block, with a status-derived reason', () => {
    const record = escalateContract(chart(), 'fe-3');
    expect(record.contractId).toBe('fe-3');
    expect(record.ownerManager).toBe('manager');
    expect(record.reason).toContain('unfulfillable');
  });

  it('walks up parentId to the nearest manager when the owner IS a chart node', () => {
    // owner is the division node → its manager parent is the target.
    const record = escalateContract(
      chart({ contracts: [contract({ ownerNodeId: 'division-eng' })] }),
      'fe-3',
    );
    expect(record.ownerManager).toBe('manager');
  });

  it('prefers a caller-supplied reason (the concrete because-X from the engineer)', () => {
    const record = escalateContract(chart(), 'fe-3', '  no collision primitive is available  ');
    expect(record.reason).toBe('no collision primitive is available');
  });

  it('never leaves the caller without a target: unknown contract still routes to the manager', () => {
    const record = escalateContract(chart(), 'does-not-exist');
    expect(record.ownerManager).toBe('manager');
    expect(record.reason).toContain('not found');
  });

  it('falls back to the CEO when there is no manager', () => {
    const noManager = chart({ nodes: [{ id: 'ceo', role: 'ceo', name: 'CEO' }] });
    expect(escalateContract(noManager, 'fe-3').ownerManager).toBe('ceo');
  });
});

describe('buildManagerRescopePrompt', () => {
  it('carries the stuck contract + reason and offers the three adaptations', () => {
    const prompt = buildManagerRescopePrompt(contract(), 'no collision primitive is available');
    expect(prompt).toContain('Physics integration');
    expect(prompt).toContain('src/engine/physics.ts');
    expect(prompt).toContain('no collision primitive is available');
    expect(prompt).toContain('RE-CONTRACT');
    expect(prompt).toContain('REORDER');
    expect(prompt).toContain('ACCEPT THE GAP');
  });
});

describe('buildManagerRescopeContractPrompt (re-scope INTO a re-dispatchable contract)', () => {
  it('asks for ONE narrower JSON contract on the SAME slot, or [] to accept the gap', () => {
    const prompt = buildManagerRescopeContractPrompt(
      contract(),
      'no collision primitive is available',
    );
    expect(prompt).toContain('Physics integration');
    expect(prompt).toContain('no collision primitive is available');
    // It requests a structured contract (so parseManagerContracts can parse it) and
    // pins the slot so the re-dispatched output lands where the original was meant to.
    expect(prompt).toContain('JSON array');
    expect(prompt).toContain('src/engine/physics.ts');
    // The bounded escape hatch: an empty array accepts the gap (never a deadlock).
    expect(prompt).toContain('EMPTY array [] to accept the gap');
  });
});

describe('rescopedContractFrom (normalize a re-scope into a ready-to-dispatch contract)', () => {
  it('keeps the original id + slot, self-contains it, and targets the shared tree', () => {
    const original = contract({ id: 'fe-3', slot: 'src/engine/physics.ts', dependsOn: ['fe-2'] });
    const rescoped = contract({
      id: 'r1',
      slot: 'src/somewhere-else.ts',
      dependsOn: ['x', 'y'],
      input: 'a narrower spec',
      output: 'a smaller step function',
      status: 'queued',
    });
    const out = rescopedContractFrom(rescoped, original);
    // Original identity + slot are preserved (so the SAME contract is recovered and
    // the output lands in the same place).
    expect(out.id).toBe('fe-3');
    expect(out.slot).toBe('src/engine/physics.ts');
    expect(out.ownerNodeId).toBe(original.ownerNodeId);
    // The re-attempt is self-contained (immediately ready) and runs in the shared
    // tree (so it can read anything already produced).
    expect(out.dependsOn).toEqual([]);
    expect(out.workspace).toBe('shared');
    expect(out.status).toBe('queued');
    // The narrowed spec comes from the re-scope.
    expect(out.input).toBe('a narrower spec');
    expect(out.output).toBe('a smaller step function');
  });
});

describe('resolveEscalation (bounded — one attempt)', () => {
  const record: EscalationRecord = { contractId: 'fe-3', ownerManager: 'manager', reason: 'stuck' };

  it('marks a successful re-scope as resolved (not a gap)', () => {
    expect(resolveEscalation(record, true)).toEqual({
      record,
      attempts: 1,
      resolved: true,
      acceptedGap: false,
    });
  });

  it('marks a still-failing contract as an ACCEPTED GAP after exactly one attempt', () => {
    expect(resolveEscalation(record, false)).toEqual({
      record,
      attempts: 1,
      resolved: false,
      acceptedGap: true,
    });
  });
});

describe('runBoundedEscalation (never deadlocks)', () => {
  const record: EscalationRecord = { contractId: 'fe-3', ownerManager: 'manager', reason: 'stuck' };

  it('invokes the re-scope seam EXACTLY once and resolves on success', async () => {
    const attemptRescope = vi.fn().mockResolvedValue(true);
    const outcome = await runBoundedEscalation({ record, attemptRescope });
    expect(attemptRescope).toHaveBeenCalledTimes(1);
    expect(outcome.resolved).toBe(true);
    expect(outcome.acceptedGap).toBe(false);
    expect(outcome.attempts).toBe(1);
  });

  it('accepts the gap after ONE failed attempt — no retry storm', async () => {
    const attemptRescope = vi.fn().mockResolvedValue(false);
    const outcome = await runBoundedEscalation({ record, attemptRescope });
    expect(attemptRescope).toHaveBeenCalledTimes(1);
    expect(outcome.acceptedGap).toBe(true);
    expect(outcome.attempts).toBe(1);
  });

  it('treats a non-true return as unresolved (accepted gap)', async () => {
    const outcome = await runBoundedEscalation({
      record,
      attemptRescope: () => undefined as never,
    });
    expect(outcome.acceptedGap).toBe(true);
  });
});
