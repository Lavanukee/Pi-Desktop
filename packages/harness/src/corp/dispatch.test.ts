import { describe, expect, it } from 'vitest';
import { edgesFromContracts } from './dag.js';
import {
  type ContractDispatchResult,
  dispatchContracts,
  type EngineerRequest,
  type RunEngineer,
  withSubmissionReview,
} from './dispatch.js';
import type { Contract, OrgChart } from './org-chart.js';
import type { WorkspaceFs } from './workspace.js';

// --- fixtures ----------------------------------------------------------------

function contract(id: string, slot: string, dependsOn: readonly string[] = []): Contract {
  return {
    id,
    title: `Contract ${id}`,
    ownerNodeId: `${id}-eng`,
    input: `input ${id}`,
    output: `output ${id}`,
    slot,
    available: { tools: ['read', 'write'], imports: [] },
    reviewRubric: `rubric ${id}`,
    dependsOn,
    status: 'queued',
  };
}

function chartOf(
  contracts: readonly Contract[],
  architecture?: OrgChart['architecture'],
): OrgChart {
  return {
    projectId: 'test',
    nodes: [],
    contracts,
    queue: edgesFromContracts(contracts),
    branches: [],
    status: 'running',
    nodeStatus: {},
    ...(architecture !== undefined ? { architecture } : {}),
  };
}

/** In-memory workspace fs — path → content. */
function memFs(): { fs: WorkspaceFs; files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, fs: { writeFile: (p, c) => void files.set(p, c) } };
}

/** A mock engineer that records every request and returns a per-contract file. */
function recordingEngineer(): { run: RunEngineer; calls: EngineerRequest[] } {
  const calls: EngineerRequest[] = [];
  const run: RunEngineer = (request) => {
    calls.push(request);
    const tag = request.review !== undefined ? ':reviewed' : '';
    return `FILE(${request.contract.id})${tag}`;
  };
  return { run, calls };
}

function byId(results: readonly ContractDispatchResult[], id: string): ContractDispatchResult {
  const r = results.find((x) => x.contractId === id);
  if (r === undefined) throw new Error(`no result for ${id}`);
  return r;
}

// --- ordering ----------------------------------------------------------------

describe('dispatchContracts — DAG ordering', () => {
  it('dispatches a dependency before its dependent, passing the real produced file forward', async () => {
    // a → b, a → c (b and c both depend on a). a must run first, and b/c must
    // receive a's ACTUAL produced content in their depContext.
    const contracts = [
      contract('a', 'src/a.ts'),
      contract('b', 'src/b.ts', ['a']),
      contract('c', 'src/c.ts', ['a']),
    ];
    const { run, calls } = recordingEngineer();
    const { fs, files } = memFs();
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      fs,
      workspace: '/ws',
    });

    expect(report.done).toEqual(['a', 'b', 'c']);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(files.size).toBe(3);

    // Ordering: a's turn precedes b's and c's.
    const firstCall = (id: string) => calls.findIndex((r) => r.contract.id === id);
    expect(firstCall('a')).toBeLessThan(firstCall('b'));
    expect(firstCall('a')).toBeLessThan(firstCall('c'));

    // b's depContext carries a's real produced file, not merely its description.
    const bCall = calls.find((r) => r.contract.id === 'b');
    expect(bCall?.depContext).toHaveLength(1);
    expect(bCall?.depContext[0]?.contractId).toBe('a');
    expect(bCall?.depContext[0]?.content).toBe('FILE(a)');
    expect(bCall?.depContext[0]?.output).toBe('output a');
  });

  it('supplies the module region from the shared architecture', async () => {
    const contracts = [contract('a', 'src/ui/app.tsx')];
    const architecture = {
      moduleMap: [{ path: 'src/ui/', owner: 'Frontend', purpose: 'the UI shell' }],
      interfaces: [],
    };
    const { run, calls } = recordingEngineer();
    const { fs } = memFs();
    await dispatchContracts({
      orgChart: chartOf(contracts, architecture),
      runEngineer: run,
      fs,
      workspace: '/ws',
    });
    expect(calls[0]?.architectureRegion).toContain('src/ui/ (owner Frontend): the UI shell');
  });
});

// --- all independent ---------------------------------------------------------

describe('dispatchContracts — all-independent contracts', () => {
  it('runs every contract when none depend on another', async () => {
    const contracts = [
      contract('a', 'src/a.ts'),
      contract('b', 'src/b.ts'),
      contract('c', 'src/c.ts'),
    ];
    const { run } = recordingEngineer();
    const { fs, files } = memFs();
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      fs,
      workspace: '/ws',
    });
    expect(new Set(report.done)).toEqual(new Set(['a', 'b', 'c']));
    expect(report.filesWritten).toHaveLength(3);
    expect(files.size).toBe(3);
  });

  it('honors a limit N — dispatches only the first N engineers', async () => {
    const contracts = [
      contract('a', 'src/a.ts'),
      contract('b', 'src/b.ts'),
      contract('c', 'src/c.ts'),
    ];
    const { run, calls } = recordingEngineer();
    const { fs } = memFs();
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      fs,
      workspace: '/ws',
      limit: 2,
    });
    expect(report.done).toHaveLength(2);
    expect(calls.map((c) => c.contract.id)).toEqual(['a', 'b']); // c never reached
  });
});

// --- mid-graph failure -------------------------------------------------------

describe('dispatchContracts — failure isolation', () => {
  it('a failed engineer skips only its dependents; independent work still runs', async () => {
    // a → b → d ; c independent. b's engineer throws.
    const contracts = [
      contract('a', 'src/a.ts'),
      contract('b', 'src/b.ts', ['a']),
      contract('d', 'src/d.ts', ['b']),
      contract('c', 'src/c.ts'),
    ];
    const run: RunEngineer = (request) => {
      if (request.contract.id === 'b') throw new Error('boom');
      return `FILE(${request.contract.id})`;
    };
    const { fs, files } = memFs();
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      fs,
      workspace: '/ws',
    });

    expect(new Set(report.done)).toEqual(new Set(['a', 'c'])); // a and c produced
    expect(report.failed).toEqual(['b']);
    expect(report.skipped).toEqual(['d']); // only b's dependent, transitively
    expect(byId(report.results, 'b').error).toContain('boom');
    expect(byId(report.results, 'd').skippedBecause).toEqual(['b']);
    // Only the two successful files landed on disk.
    expect(files.size).toBe(2);
    // The chart reflects the outcome (done → in-review, failed → unfulfillable).
    const status = (id: string) => report.chart.contracts.find((x) => x.id === id)?.status;
    expect(status('a')).toBe('in-review');
    expect(status('b')).toBe('unfulfillable');
    expect(status('c')).toBe('in-review');
    expect(status('d')).toBe('queued'); // skipped stays queued
  });

  it('never mutates the input chart', async () => {
    const contracts = [contract('a', 'src/a.ts')];
    const input = chartOf(contracts);
    const { run } = recordingEngineer();
    const { fs } = memFs();
    await dispatchContracts({ orgChart: input, runEngineer: run, fs, workspace: '/ws' });
    expect(input.contracts[0]?.status).toBe('queued');
  });
});

// --- submission interceptor --------------------------------------------------

describe('withSubmissionReview (model-free submission interceptor)', () => {
  it('bounces the first submission once, accepts the second, and fires once per contract', async () => {
    const calls: { id: string; review: boolean; prompt?: string }[] = [];
    const inner: RunEngineer = (request) => {
      calls.push({
        id: request.contract.id,
        review: request.review !== undefined,
        prompt: request.review?.prompt,
      });
      return request.review !== undefined ? 'final' : 'draft';
    };
    const wrapped = withSubmissionReview(inner);
    const c = contract('x', 'src/x.ts');

    const out = await wrapped({ contract: c, depContext: [] });
    // First submit → review bounce → the reviewed result is accepted.
    expect(out).toBe('final');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: 'x', review: false });
    expect(calls[1]?.review).toBe(true);
    // The bounce prompt is the auto-generated (model-free) self-review.
    expect(calls[1]?.prompt).toContain('src/x.ts');
    expect(calls[1]?.prompt?.toLowerCase()).toContain('review');

    // Dispatching the SAME contract again is accepted directly — no second bounce.
    const out2 = await wrapped({ contract: c, depContext: [] });
    expect(out2).toBe('draft');
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ id: 'x', review: false });
  });

  it('fires exactly once per contract across a dispatch run', async () => {
    const contracts = [contract('a', 'src/a.ts'), contract('b', 'src/b.ts', ['a'])];
    let reviewTurns = 0;
    const run: RunEngineer = (request) => {
      if (request.review !== undefined) reviewTurns += 1;
      return `FILE(${request.contract.id})${request.review !== undefined ? ':reviewed' : ''}`;
    };
    const { fs, files } = memFs();
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      fs,
      workspace: '/ws',
      interceptor: withSubmissionReview,
    });

    expect(report.done).toEqual(['a', 'b']);
    expect(reviewTurns).toBe(2); // exactly one review per contract
    // The REVIEWED file is what lands, and what propagates forward as depContext.
    expect(files.get('/ws/src/a.ts')).toBe('FILE(a):reviewed');
  });
});

// --- Fix 3: measure the interceptor (draft vs reviewed capture) --------------

describe('dispatchContracts — captureReviews (draft vs reviewed)', () => {
  it('records draft/reviewed sizes + changed per contract and counts changes', async () => {
    // a's reviewed file differs from its draft; b's reviewed file is identical.
    const contracts = [contract('a', 'src/a.ts'), contract('b', 'src/b.ts')];
    const run: RunEngineer = (request) => {
      const reviewed = request.review !== undefined;
      if (request.contract.id === 'a') return reviewed ? 'FILE(a) revised longer' : 'FILE(a)';
      return 'FILE(b)'; // unchanged by review
    };
    const { fs } = memFs();
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      fs,
      workspace: '/ws',
      captureReviews: true,
    });

    expect(report.reviews).toHaveLength(2);
    const a = report.reviews.find((r) => r.contractId === 'a');
    const b = report.reviews.find((r) => r.contractId === 'b');
    expect(a?.changed).toBe(true);
    expect(a?.reviewedBytes).toBeGreaterThan(a?.draftBytes ?? 0);
    expect(b?.changed).toBe(false);
    expect(b?.draftBytes).toBe(b?.reviewedBytes);
    // Bodies are omitted by default (sizes only).
    expect(a?.draft).toBeUndefined();
    expect(a?.reviewed).toBeUndefined();
    expect(report.interceptorChangedCount).toBe(1);
    // The reviewed file is still what lands on disk.
    expect(report.filesWritten).toHaveLength(2);
  });

  it('keeps draft + reviewed bodies when includeReviewBodies is set', async () => {
    const contracts = [contract('a', 'src/a.ts')];
    const run: RunEngineer = (request) =>
      request.review !== undefined ? 'reviewed-body' : 'draft-body';
    const { fs } = memFs();
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      fs,
      workspace: '/ws',
      captureReviews: true,
      includeReviewBodies: true,
    });

    expect(report.reviews[0]?.draft).toBe('draft-body');
    expect(report.reviews[0]?.reviewed).toBe('reviewed-body');
    expect(report.reviews[0]?.changed).toBe(true);
  });

  it('leaves reviews empty and changed-count 0 when capture is off', async () => {
    const contracts = [contract('a', 'src/a.ts')];
    const { run } = recordingEngineer();
    const { fs } = memFs();
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      fs,
      workspace: '/ws',
    });
    expect(report.reviews).toEqual([]);
    expect(report.interceptorChangedCount).toBe(0);
  });
});
