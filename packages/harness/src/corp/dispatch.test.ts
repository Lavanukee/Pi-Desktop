import { describe, expect, it } from 'vitest';
import { edgesFromContracts } from './dag.js';
import {
  type ContractDispatchResult,
  dispatchContracts,
  type EngineerRequest,
  type RunEngineer,
  type WrittenFile,
  withSubmissionReview,
} from './dispatch.js';
import type { Contract, OrgChart } from './org-chart.js';
import { slotPath, type WorkspaceReadFs } from './workspace.js';

// --- fixtures ----------------------------------------------------------------

const WS = '/ws';

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

/**
 * In-memory workspace — the engineer SEAM writes files here; dispatch reads them
 * back (the write moved out of dispatch). `writeSlotFile` is the seam's write for
 * mocks: it places `<WS>/<slot>` and returns the {@link WrittenFile} the seam
 * reports.
 */
function memWorkspace(): {
  readFs: WorkspaceReadFs;
  files: Map<string, string>;
  writeSlotFile: (slot: string, content: string) => WrittenFile;
  readSlot: (request: EngineerRequest) => string | undefined;
} {
  const files = new Map<string, string>();
  const readFs: WorkspaceReadFs = {
    readFile: (p) => files.get(p),
    listFiles: (root) => [...files.keys()].filter((p) => p === root || p.startsWith(`${root}/`)),
  };
  return {
    files,
    readFs,
    writeSlotFile: (slot, content) => {
      const path = slotPath(WS, slot);
      files.set(path, content);
      return { path, bytes: new TextEncoder().encode(content).length };
    },
    readSlot: (request) => readFs.readFile(slotPath(WS, request.contract.slot)),
  };
}

/** A mock engineer that WRITES `FILE(<id>)` to its slot, records every request,
 * and returns the written file(s) — the shape the real seam conforms to. */
function recordingEngineer(writeSlotFile: (slot: string, content: string) => WrittenFile): {
  run: RunEngineer;
  calls: EngineerRequest[];
} {
  const calls: EngineerRequest[] = [];
  const run: RunEngineer = (request) => {
    calls.push(request);
    const tag = request.review !== undefined ? ':reviewed' : '';
    return [writeSlotFile(request.contract.slot, `FILE(${request.contract.id})${tag}`)];
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
    // receive a's ACTUAL produced content (read back from the workspace).
    const contracts = [
      contract('a', 'src/a.ts'),
      contract('b', 'src/b.ts', ['a']),
      contract('c', 'src/c.ts', ['a']),
    ];
    const { readFs, files, writeSlotFile } = memWorkspace();
    const { run, calls } = recordingEngineer(writeSlotFile);
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
    });

    expect(report.done).toEqual(['a', 'b', 'c']);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(files.size).toBe(3);

    // Ordering: a's turn precedes b's and c's.
    const firstCall = (id: string) => calls.findIndex((r) => r.contract.id === id);
    expect(firstCall('a')).toBeLessThan(firstCall('b'));
    expect(firstCall('a')).toBeLessThan(firstCall('c'));

    // b's depContext carries a's real produced file (read back), not its description.
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
    const { readFs, writeSlotFile } = memWorkspace();
    const { run, calls } = recordingEngineer(writeSlotFile);
    await dispatchContracts({
      orgChart: chartOf(contracts, architecture),
      runEngineer: run,
      readFs,
      workspace: WS,
    });
    expect(calls[0]?.architectureRegion).toContain('src/ui/ (owner Frontend): the UI shell');
  });

  it('threads the owning node prompt id + extension onto the request', async () => {
    const contracts = [contract('a', 'src/a.ts')];
    // The contract's ownerNodeId matches a real node carrying a promptId + extension.
    const chart: OrgChart = {
      ...chartOf(contracts),
      nodes: [
        {
          id: 'a-eng',
          role: 'engineer',
          name: 'Eng A',
          promptId: 'frontend-dev',
          promptExtension: 'extra flavor',
        },
      ],
    };
    const { readFs, writeSlotFile } = memWorkspace();
    const { run, calls } = recordingEngineer(writeSlotFile);
    await dispatchContracts({ orgChart: chart, runEngineer: run, readFs, workspace: WS });
    expect(calls[0]?.promptId).toBe('frontend-dev');
    expect(calls[0]?.promptExtension).toBe('extra flavor');
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
    const { readFs, files, writeSlotFile } = memWorkspace();
    const { run } = recordingEngineer(writeSlotFile);
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
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
    const { readFs, writeSlotFile } = memWorkspace();
    const { run, calls } = recordingEngineer(writeSlotFile);
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
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
    const { readFs, files, writeSlotFile } = memWorkspace();
    const run: RunEngineer = (request) => {
      if (request.contract.id === 'b') throw new Error('boom');
      return [writeSlotFile(request.contract.slot, `FILE(${request.contract.id})`)];
    };
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
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

  it('marks a contract FAILED when the seam wrote no slot file', async () => {
    // The seam returns without writing the slot (a runaway that produced nothing).
    const contracts = [contract('a', 'src/a.ts')];
    const { readFs } = memWorkspace();
    const run: RunEngineer = () => []; // wrote nothing
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
    });
    expect(report.failed).toEqual(['a']);
    expect(byId(report.results, 'a').error).toContain('did not write the slot file');
  });

  it('never mutates the input chart', async () => {
    const contracts = [contract('a', 'src/a.ts')];
    const input = chartOf(contracts);
    const { readFs, writeSlotFile } = memWorkspace();
    const { run } = recordingEngineer(writeSlotFile);
    await dispatchContracts({ orgChart: input, runEngineer: run, readFs, workspace: WS });
    expect(input.contracts[0]?.status).toBe('queued');
  });
});

// --- submission interceptor --------------------------------------------------

describe('withSubmissionReview (model-free submission interceptor)', () => {
  it('bounces the first submission once, accepts the second, and fires once per contract', async () => {
    const { writeSlotFile, readSlot, files } = memWorkspace();
    const calls: { id: string; review: boolean; prompt?: string }[] = [];
    const inner: RunEngineer = (request) => {
      calls.push({
        id: request.contract.id,
        review: request.review !== undefined,
        prompt: request.review?.prompt,
      });
      // The review turn writes the REVIEWED content over the slot.
      return [
        writeSlotFile(request.contract.slot, request.review !== undefined ? 'final' : 'draft'),
      ];
    };
    const wrapped = withSubmissionReview(inner, readSlot);
    const c = contract('x', 'src/x.ts');

    const out = await wrapped({ contract: c, depContext: [] });
    // First submit → review bounce → the reviewed file is what remains on disk.
    expect(files.get(slotPath(WS, 'src/x.ts'))).toBe('final');
    expect(out.map((f) => f.path)).toEqual([slotPath(WS, 'src/x.ts')]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: 'x', review: false });
    expect(calls[1]?.review).toBe(true);
    // The bounce prompt is the auto-generated (model-free) self-review.
    expect(calls[1]?.prompt).toContain('src/x.ts');
    expect(calls[1]?.prompt?.toLowerCase()).toContain('review');

    // Dispatching the SAME contract again is accepted directly — no second bounce.
    await wrapped({ contract: c, depContext: [] });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ id: 'x', review: false });
  });

  it('fires exactly once per contract across a dispatch run', async () => {
    const contracts = [contract('a', 'src/a.ts'), contract('b', 'src/b.ts', ['a'])];
    const { readFs, files, writeSlotFile } = memWorkspace();
    let reviewTurns = 0;
    const run: RunEngineer = (request) => {
      if (request.review !== undefined) reviewTurns += 1;
      const tag = request.review !== undefined ? ':reviewed' : '';
      return [writeSlotFile(request.contract.slot, `FILE(${request.contract.id})${tag}`)];
    };
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
      captureReviews: true,
    });

    expect(report.done).toEqual(['a', 'b']);
    expect(reviewTurns).toBe(2); // exactly one review per contract
    // The REVIEWED file is what lands, and what propagates forward as depContext.
    expect(files.get(slotPath(WS, 'src/a.ts'))).toBe('FILE(a):reviewed');
  });
});

// --- Fix 3: measure the interceptor (draft vs reviewed capture) --------------

describe('dispatchContracts — captureReviews (draft vs reviewed)', () => {
  it('records draft/reviewed sizes + changed per contract and counts changes', async () => {
    // a's reviewed file differs from its draft; b's reviewed file is identical.
    const contracts = [contract('a', 'src/a.ts'), contract('b', 'src/b.ts')];
    const { readFs, writeSlotFile } = memWorkspace();
    const run: RunEngineer = (request) => {
      const reviewed = request.review !== undefined;
      const body =
        request.contract.id === 'a' ? (reviewed ? 'FILE(a) revised longer' : 'FILE(a)') : 'FILE(b)'; // unchanged by review
      return [writeSlotFile(request.contract.slot, body)];
    };
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
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
    const { readFs, writeSlotFile } = memWorkspace();
    const run: RunEngineer = (request) => [
      writeSlotFile(
        request.contract.slot,
        request.review !== undefined ? 'reviewed-body' : 'draft-body',
      ),
    ];
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
      captureReviews: true,
      includeReviewBodies: true,
    });

    expect(report.reviews[0]?.draft).toBe('draft-body');
    expect(report.reviews[0]?.reviewed).toBe('reviewed-body');
    expect(report.reviews[0]?.changed).toBe(true);
  });

  it('leaves reviews empty and changed-count 0 when capture is off', async () => {
    const contracts = [contract('a', 'src/a.ts')];
    const { readFs, writeSlotFile } = memWorkspace();
    const { run } = recordingEngineer(writeSlotFile);
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
    });
    expect(report.reviews).toEqual([]);
    expect(report.interceptorChangedCount).toBe(0);
  });
});

// --- multiple files per contract (agent path) --------------------------------

describe('dispatchContracts — records every file the seam wrote', () => {
  it('collects the slot file plus supporting files, deduped, primary guaranteed', async () => {
    const contracts = [contract('a', 'src/a.ts')];
    const { readFs, writeSlotFile } = memWorkspace();
    // The agent writes the slot + a small supporting file within its region.
    const run: RunEngineer = (request) => {
      const slotFile = writeSlotFile(request.contract.slot, 'FILE(a)');
      const helper = writeSlotFile('src/a.helper.ts', 'HELPER');
      return [slotFile, helper];
    };
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
    });
    expect(report.done).toEqual(['a']);
    expect(new Set(report.filesWritten.map((f) => f.path))).toEqual(
      new Set([slotPath(WS, 'src/a.ts'), slotPath(WS, 'src/a.helper.ts')]),
    );
    // The per-contract result points at the primary slot file.
    expect(byId(report.results, 'a').path).toBe(slotPath(WS, 'src/a.ts'));
  });
});

// --- bounded concurrency -----------------------------------------------------
// The concurrent path is proved DETERMINISTICALLY (no real time): engineer mocks
// are gated by manual-resolve deferreds and/or a live in-flight counter, and
// `flush` drains the microtask queue via a single macrotask tick.

/** A promise whose settlement the test controls. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drain all currently-pending microtasks (job continuations + pool re-walks). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

describe('dispatchContracts — bounded concurrency (parallel dispatch)', () => {
  it('runs up to `concurrency` jobs at once and never more', async () => {
    // Six INDEPENDENT contracts, width 3 → at most three engineers ever in flight.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const contracts = ids.map((id) => contract(id, `src/${id}.ts`));
    const gates = new Map(ids.map((id) => [id, deferred()] as const));
    let live = 0;
    let peak = 0;
    const started: string[] = [];
    const { readFs, files, writeSlotFile } = memWorkspace();
    const run: RunEngineer = async (req) => {
      const id = req.contract.id;
      started.push(id);
      const file = writeSlotFile(req.contract.slot, `FILE(${id})`);
      live += 1;
      peak = Math.max(peak, live);
      await gates.get(id)?.promise;
      live -= 1;
      return [file];
    };
    const done = dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
      concurrency: 3,
    });

    await flush();
    // Exactly three started (in topological order); the other three wait behind
    // the bound — the live counter peaks at 3, never 4.
    expect(started).toEqual(['a', 'b', 'c']);
    expect(live).toBe(3);
    expect(peak).toBe(3);

    // Finish one → the fourth starts, the pool is still full at 3, never 4.
    gates.get('a')?.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    expect(live).toBe(3);
    expect(peak).toBe(3);

    // Drain the rest; the peak held at exactly the bound throughout.
    for (const g of gates.values()) g.resolve();
    const report = await done;
    expect(peak).toBe(3);
    expect(new Set(report.done)).toEqual(new Set(ids));
    expect(files.size).toBe(6);
  });

  it('never starts a dependent before its dependency has finished, even with spare width', async () => {
    // A a→b→c chain with width 3: the DAG, not the width, gates each start.
    const ids = ['a', 'b', 'c'];
    const contracts = [
      contract('a', 'src/a.ts'),
      contract('b', 'src/b.ts', ['a']),
      contract('c', 'src/c.ts', ['b']),
    ];
    const gates = new Map(ids.map((id) => [id, deferred()] as const));
    const events: string[] = [];
    const { readFs, writeSlotFile } = memWorkspace();
    const run: RunEngineer = async (req) => {
      const id = req.contract.id;
      events.push(`start:${id}`);
      const file = writeSlotFile(req.contract.slot, `FILE(${id})`);
      await gates.get(id)?.promise;
      events.push(`finish:${id}`);
      return [file];
    };
    const done = dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
      concurrency: 3,
    });

    await flush();
    expect(events).toEqual(['start:a']); // only a may start — b/c wait on the DAG
    gates.get('a')?.resolve();
    await flush();
    expect(events).toEqual(['start:a', 'finish:a', 'start:b']);
    gates.get('b')?.resolve();
    await flush();
    expect(events).toEqual(['start:a', 'finish:a', 'start:b', 'finish:b', 'start:c']);
    gates.get('c')?.resolve();
    const report = await done;

    expect(report.done).toEqual(['a', 'b', 'c']);
    // Each dependent's START strictly follows its dependency's FINISH.
    expect(events.indexOf('start:b')).toBeGreaterThan(events.indexOf('finish:a'));
    expect(events.indexOf('start:c')).toBeGreaterThan(events.indexOf('finish:b'));
  });

  it('cascades skips to transitive dependents when a contract fails, under concurrency', async () => {
    // a → b → c (a fails); e independent still runs. Width 3.
    const contracts = [
      contract('a', 'src/a.ts'),
      contract('b', 'src/b.ts', ['a']),
      contract('c', 'src/c.ts', ['b']),
      contract('e', 'src/e.ts'),
    ];
    const { readFs, files, writeSlotFile } = memWorkspace();
    const run: RunEngineer = (req) => {
      if (req.contract.id === 'a') throw new Error('boom-a');
      return [writeSlotFile(req.contract.slot, `FILE(${req.contract.id})`)];
    };
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
      concurrency: 3,
    });

    expect(report.failed).toEqual(['a']);
    expect(report.skipped).toEqual(['b', 'c']); // b directly, c transitively
    expect(new Set(report.done)).toEqual(new Set(['e']));
    expect(byId(report.results, 'b').skippedBecause).toEqual(['a']);
    expect(byId(report.results, 'c').skippedBecause).toEqual(['b']);
    expect(files.size).toBe(1); // only e's file landed
  });

  it('emits an identical report for concurrency 1, 3, and 5 (topological, schedule-independent)', async () => {
    // A mixed DAG with a mid-graph failure so done/skip/cascade are all exercised.
    const contracts = [
      contract('a', 'src/a.ts'),
      contract('b', 'src/b.ts', ['a']),
      contract('c', 'src/c.ts', ['a']),
      contract('d', 'src/d.ts', ['b', 'c']),
      contract('x', 'src/x.ts'),
      contract('y', 'src/y.ts', ['x']),
      contract('z', 'src/z.ts', ['y']),
    ];
    const runOnce = (concurrency: number) => {
      const { readFs, writeSlotFile } = memWorkspace();
      const run: RunEngineer = (req) => {
        if (req.contract.id === 'y') throw new Error('boom-y');
        return [writeSlotFile(req.contract.slot, `FILE(${req.contract.id})`)];
      };
      return dispatchContracts({
        orgChart: chartOf(contracts),
        runEngineer: run,
        readFs,
        workspace: WS,
        concurrency,
      });
    };

    const r1 = await runOnce(1);
    const r3 = await runOnce(3);
    const r5 = await runOnce(5);
    // Byte-for-byte identical report across scheduling widths.
    expect(r3).toEqual(r1);
    expect(r5).toEqual(r1);
    // And the content is the expected topological outcome (cascade from y → z).
    expect(r1.done).toEqual(['a', 'b', 'c', 'd', 'x']);
    expect(r1.failed).toEqual(['y']);
    expect(r1.skipped).toEqual(['z']);
    expect(r1.results.map((r) => r.contractId)).toEqual(['a', 'b', 'c', 'd', 'x', 'y', 'z']);
    expect(r1.filesWritten.map((f) => f.path)).toEqual([
      slotPath(WS, 'src/a.ts'),
      slotPath(WS, 'src/b.ts'),
      slotPath(WS, 'src/c.ts'),
      slotPath(WS, 'src/d.ts'),
      slotPath(WS, 'src/x.ts'),
    ]);
  });

  it('is byte-for-byte the serial behavior when concurrency is 1 (and when unset)', async () => {
    // The existing failure-isolation fixture: a → b → d ; c independent; b fails.
    const contracts = [
      contract('a', 'src/a.ts'),
      contract('b', 'src/b.ts', ['a']),
      contract('d', 'src/d.ts', ['b']),
      contract('c', 'src/c.ts'),
    ];
    const runWith = (opts: { concurrency?: number }) => {
      const { readFs, writeSlotFile } = memWorkspace();
      const run: RunEngineer = (req) => {
        if (req.contract.id === 'b') throw new Error('boom');
        return [writeSlotFile(req.contract.slot, `FILE(${req.contract.id})`)];
      };
      return dispatchContracts({
        orgChart: chartOf(contracts),
        runEngineer: run,
        readFs,
        workspace: WS,
        ...opts,
      });
    };

    const unset = await runWith({});
    const one = await runWith({ concurrency: 1 });
    expect(one).toEqual(unset);
    // The exact serial expectations the rest of the suite relies on.
    expect(new Set(unset.done)).toEqual(new Set(['a', 'c']));
    expect(unset.failed).toEqual(['b']);
    expect(unset.skipped).toEqual(['d']);
    expect(byId(unset.results, 'd').skippedBecause).toEqual(['b']);
    expect(unset.results.map((r) => r.contractId)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('never starts more than `limit` jobs, regardless of concurrency width', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const contracts = ids.map((id) => contract(id, `src/${id}.ts`)); // independent
    let starts = 0;
    const { readFs, files, writeSlotFile } = memWorkspace();
    const run: RunEngineer = (req) => {
      starts += 1;
      return [writeSlotFile(req.contract.slot, `FILE(${req.contract.id})`)];
    };
    const report = await dispatchContracts({
      orgChart: chartOf(contracts),
      runEngineer: run,
      readFs,
      workspace: WS,
      limit: 2,
      concurrency: 5,
    });

    expect(starts).toBe(2); // at most `limit` engineers ever begin
    expect(report.done).toEqual(['a', 'b']); // the first two in topological order
    expect(files.size).toBe(2);
  });
});
