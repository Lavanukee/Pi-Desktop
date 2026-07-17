/**
 * Contract dispatch — the execution core (spec §7 execution, §6 the dependency
 * DAG, §0.6 "robustness is external").
 *
 * Once planning (slice 2/3) has produced an acyclic {@link OrgChart} queue, this
 * module hands each contract to an engineer, IN DEPENDENCY ORDER, and lands the
 * produced file in the workspace. It is pure orchestration behind two injected
 * seams — {@link RunEngineer} (the engineer turn) and {@link WorkspaceFs} (the
 * file write) — so the whole loop is unit-testable with a mock engineer and an
 * in-memory fs, no model and no disk.
 *
 * Ordering + failure policy:
 *  - A contract is READY only when every id in its `dependsOn` is DONE. The loop
 *    walks the queue's topological order, so a dependency is always dispatched
 *    before its dependent, and the dependent's {@link DependencyContext} carries
 *    the dependency's ACTUAL produced file (build against real code, not a
 *    description).
 *  - An engineer that ERRORS marks its contract FAILED — it does NOT abort the
 *    run. Its dependents (transitively) are SKIPPED and recorded; independent
 *    work still runs. This is the "robustness is external" principle: one bad
 *    contract loses its subtree, never the whole corporation.
 *  - Sequential for now; parallel `-np` width is a later optimization (spec §6 —
 *    correctness never depends on parallelism, only speed does).
 *
 * The submission interceptor (spec §7, MODEL-FREE) is a thin wrapper
 * ({@link withSubmissionReview}) around the engineer seam, so the dispatch loop
 * itself stays clean and knows nothing about the self-review bounce.
 */

import { edgesFromContracts, topologicalOrder } from './dag.js';
import { buildSelfReviewPrompt, type DependencyContext } from './engineer.js';
import type { Contract, ContractStatus, OrgChart } from './org-chart.js';
import { type WorkspaceFs, writeSlot } from './workspace.js';

// --- The engineer seam -------------------------------------------------------

/**
 * The self-review bounce state carried on a review turn (spec §7). Present only
 * on the SECOND call the interceptor makes for a contract: the draft the engineer
 * just submitted plus the auto-generated self-review prompt. Absent on the first
 * (draft) turn.
 */
export interface EngineerReview {
  /** The file the engineer submitted on its first turn. */
  readonly priorSubmission: string;
  /** The model-free self-review prompt (engineer.ts `buildSelfReviewPrompt`). */
  readonly prompt: string;
}

/** One dispatch request handed to the engineer seam. */
export interface EngineerRequest {
  /** The contract being built. */
  readonly contract: Contract;
  /** Its resolved dependencies, each with the real produced file when available. */
  readonly depContext: readonly DependencyContext[];
  /** The module region this file lives in (from the shared architecture), if any. */
  readonly architectureRegion?: string;
  /** Set on the self-review bounce; absent on the first draft turn. */
  readonly review?: EngineerReview;
}

/**
 * The engineer turn as a seam: given a request, return the FILE CONTENT for the
 * contract's slot (raw text — the dispatcher writes it). Sync or async; a mock in
 * tests, the model-backed impl in the driver.
 */
export type RunEngineer = (request: EngineerRequest) => Promise<string> | string;

/** A transform over the engineer seam (e.g. {@link withSubmissionReview}). */
export type EngineerInterceptor = (run: RunEngineer) => RunEngineer;

/**
 * What the submission interceptor did to ONE contract's file (Fix 3 — measure the
 * interceptor). Records the DRAFT the engineer first submitted and the REVIEWED
 * (final) file the self-review bounce returned, so a run can report WHETHER and
 * HOW MUCH the model-free review changed each file. `draft`/`reviewed` bodies are
 * present only when the caller opted in (`includeReviewBodies`); the byte sizes +
 * `changed` flag are always recorded.
 */
export interface ReviewRecord {
  readonly contractId: string;
  /** UTF-8 byte length of the first-submit DRAFT. */
  readonly draftBytes: number;
  /** UTF-8 byte length of the REVIEWED (final) file. */
  readonly reviewedBytes: number;
  /** True when the reviewed file differs from the draft (the review changed it). */
  readonly changed: boolean;
  /** The draft body — present only when `includeReviewBodies` was set. */
  readonly draft?: string;
  /** The reviewed body — present only when `includeReviewBodies` was set. */
  readonly reviewed?: string;
}

/** Sink the review interceptor calls once per contract with its {@link ReviewRecord}. */
export type ReviewSink = (record: ReviewRecord) => void;

// --- Submission interceptor (spec §7, model-free) ----------------------------

/**
 * The submission interceptor (spec §7 quality gate — NO second model). The FIRST
 * time an engineer submits a file for a contract, bounce it back ONCE with an
 * auto-generated self-review prompt ("re-read your contract and the file you
 * wrote — does it fully meet the contract; anything to improve; return the final
 * file"), then accept the (possibly revised) result. Implemented as a wrapper so
 * the dispatch loop stays clean.
 *
 * A per-contract once-only flag makes it fire EXACTLY once per contract: a single
 * wrapped call runs the engineer twice (draft → review) and returns the reviewed
 * file; a later call for the SAME contract (a resume/retry) is accepted directly
 * with no further bounce. Cheap, deterministic, model-free.
 *
 * When a `capture` sink is supplied (Fix 3), each bounced contract also emits a
 * {@link ReviewRecord} — the draft vs reviewed byte sizes and a `changed` flag (and
 * both bodies when `includeBodies`) — so the run can MEASURE the interceptor's
 * quality delta instead of it being invisible. Capture never changes the returned
 * file; it only observes.
 */
export function withSubmissionReview(
  run: RunEngineer,
  capture?: ReviewSink,
  includeBodies = false,
): RunEngineer {
  const reviewed = new Set<string>();
  return async (request) => {
    const id = request.contract.id;
    // Already bounced once (or a pre-formed review turn) → accept without re-review.
    if (request.review !== undefined || reviewed.has(id)) return run(request);
    reviewed.add(id);
    const draft = await run(request); // first submit
    const finalFile = await run({
      ...request,
      review: { priorSubmission: draft, prompt: buildSelfReviewPrompt(request.contract) },
    });
    if (capture !== undefined) {
      capture({
        contractId: id,
        draftBytes: byteLength(draft),
        reviewedBytes: byteLength(finalFile),
        changed: draft !== finalFile,
        ...(includeBodies ? { draft, reviewed: finalFile } : {}),
      });
    }
    return finalFile;
  };
}

// --- Dispatch report ---------------------------------------------------------

/** Outcome of dispatching one contract. */
export type DispatchStatus = 'done' | 'failed' | 'skipped';

/** One file the dispatcher wrote to the workspace. */
export interface WrittenFile {
  /** Absolute path written. */
  readonly path: string;
  /** UTF-8 byte length of the produced file. */
  readonly bytes: number;
}

/** Per-contract dispatch result. */
export interface ContractDispatchResult {
  readonly contractId: string;
  readonly title: string;
  readonly slot: string;
  readonly status: DispatchStatus;
  /** Path written (present on `done`). */
  readonly path?: string;
  /** UTF-8 byte length written (present on `done`). */
  readonly bytes?: number;
  /** The engineer error (present on `failed`). */
  readonly error?: string;
  /** The failed/skipped dependency ids that blocked this one (present on `skipped`). */
  readonly skippedBecause?: readonly string[];
}

/** What a dispatch run did: per-contract status, files written, failures/skips. */
export interface DispatchReport {
  /** Per-contract results, in dispatch order. */
  readonly results: readonly ContractDispatchResult[];
  /** Ids of contracts whose file was produced and written. */
  readonly done: readonly string[];
  /** Ids of contracts whose engineer errored. */
  readonly failed: readonly string[];
  /** Ids of contracts skipped because a dependency failed/was skipped. */
  readonly skipped: readonly string[];
  /** Every file written to the workspace. */
  readonly filesWritten: readonly WrittenFile[];
  /** Per-contract draft-vs-reviewed records (Fix 3) — one per contract the
   * submission interceptor bounced, when `captureReviews` was set (else empty). */
  readonly reviews: readonly ReviewRecord[];
  /** How many reviewed files actually DIFFER from their draft — the interceptor's
   * measured quality delta (Fix 3). 0 when review capture was off. */
  readonly interceptorChangedCount: number;
  /** The chart with dispatched contracts' statuses updated (done → in-review,
   * failed → unfulfillable; skipped left as-is). Never mutates the input chart. */
  readonly chart: OrgChart;
}

/** Options for {@link dispatchContracts}. */
export interface DispatchOptions {
  /** The planned, acyclic chart (contracts + queue + optional architecture). */
  readonly orgChart: OrgChart;
  /** The engineer seam (mock in tests, model-backed in the driver). */
  readonly runEngineer: RunEngineer;
  /** The workspace fs seam (in-memory in tests, node:fs in the driver). */
  readonly fs: WorkspaceFs;
  /** The per-task workspace root; files land at `<workspace>/<slot>`. */
  readonly workspace: string;
  /** Optional engineer-seam transform (e.g. {@link withSubmissionReview}). */
  readonly interceptor?: EngineerInterceptor;
  /**
   * Measure the submission interceptor (Fix 3): when true, dispatch uses the
   * capturing {@link withSubmissionReview} itself (draft → review, recording a
   * {@link ReviewRecord} per contract into {@link DispatchReport.reviews}). It
   * REPLACES `interceptor` — the review bounce IS the interceptor, so pass this
   * instead of `interceptor: withSubmissionReview` when you want the measurement.
   */
  readonly captureReviews?: boolean;
  /** With `captureReviews`, also keep the draft + reviewed BODIES on each record
   * (default: sizes + `changed` only, to keep the report light). */
  readonly includeReviewBodies?: boolean;
  /** Dispatch at most this many engineers (a SUBSET); default: all ready ones. */
  readonly limit?: number;
}

/** True when `slot` lives inside `regionPath` (equal, or under it as a directory). */
function slotInRegion(regionPath: string, slot: string): boolean {
  if (regionPath === slot) return true;
  const dir = regionPath.endsWith('/') ? regionPath : `${regionPath}/`;
  return slot.startsWith(dir);
}

/** The formatted module region a contract's slot belongs to, or undefined when
 * there is no architecture / no matching region. */
function moduleRegionForSlot(orgChart: OrgChart, slot: string): string | undefined {
  const architecture = orgChart.architecture;
  if (architecture === undefined) return undefined;
  const matched = architecture.moduleMap.filter((m) => slotInRegion(m.path, slot));
  if (matched.length === 0) return undefined;
  return matched.map((m) => `  - ${m.path} (owner ${m.owner}): ${m.purpose}`).join('\n');
}

/** Build the dependency context for one dep id from its contract + produced file. */
function makeDepContext(
  dep: Contract | undefined,
  producedContent: string | undefined,
): DependencyContext | undefined {
  if (dep === undefined) return undefined;
  return {
    contractId: dep.id,
    title: dep.title,
    slot: dep.slot,
    output: dep.output,
    content: producedContent,
  };
}

/** UTF-8 byte length of a produced file (no node:Buffer dependency). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Dispatch the chart's contracts to engineers in DEPENDENCY order, writing each
 * produced file to `<workspace>/<slot>`. See the module doc for the ordering +
 * failure policy. Sequential; pure orchestration behind the injected engineer +
 * fs seams. Never mutates the input chart; never throws (an engineer error is
 * captured as a FAILED result). Returns a {@link DispatchReport}.
 */
export async function dispatchContracts(options: DispatchOptions): Promise<DispatchReport> {
  const { orgChart, fs, workspace } = options;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  // Fix 3: when measuring the interceptor, dispatch owns the capturing review
  // (it IS the interceptor); otherwise honor a caller-supplied interceptor.
  const reviews: ReviewRecord[] = [];
  let run: RunEngineer;
  if (options.captureReviews === true) {
    run = withSubmissionReview(
      options.runEngineer,
      (record) => reviews.push(record),
      options.includeReviewBodies === true,
    );
  } else if (options.interceptor !== undefined) {
    run = options.interceptor(options.runEngineer);
  } else {
    run = options.runEngineer;
  }

  const contracts = orgChart.contracts;
  const byId = new Map(contracts.map((c) => [c.id, c] as const));
  const ids = contracts.map((c) => c.id);
  const edges = orgChart.queue.length > 0 ? orgChart.queue : edgesFromContracts(contracts);
  // The planned chart is acyclic by construction; fall back to input order if a
  // caller hands us an un-planned (cyclic) chart rather than looping forever.
  const order = topologicalOrder(ids, edges) ?? ids;

  const produced = new Map<string, string>();
  const doneSet = new Set<string>();
  const failedSet = new Set<string>();
  const skippedSet = new Set<string>();
  const statusById = new Map<string, ContractStatus>();
  const results: ContractDispatchResult[] = [];
  const filesWritten: WrittenFile[] = [];
  let ran = 0;

  for (const id of order) {
    if (ran >= limit) break;
    const contract = byId.get(id);
    if (contract === undefined) continue;

    const blockedBy = contract.dependsOn.filter((d) => failedSet.has(d) || skippedSet.has(d));
    if (blockedBy.length > 0) {
      skippedSet.add(id);
      results.push({
        contractId: id,
        title: contract.title,
        slot: contract.slot,
        status: 'skipped',
        skippedBecause: blockedBy,
      });
      continue;
    }

    const depContext = contract.dependsOn
      .map((d) => makeDepContext(byId.get(d), produced.get(d)))
      .filter((c): c is DependencyContext => c !== undefined);
    const architectureRegion = moduleRegionForSlot(orgChart, contract.slot);

    try {
      const fileText = await run({ contract, depContext, architectureRegion });
      const path = writeSlot(workspace, contract.slot, fileText, fs);
      const bytes = byteLength(fileText);
      produced.set(id, fileText);
      doneSet.add(id);
      statusById.set(id, 'in-review');
      filesWritten.push({ path, bytes });
      results.push({
        contractId: id,
        title: contract.title,
        slot: contract.slot,
        status: 'done',
        path,
        bytes,
      });
    } catch (err) {
      failedSet.add(id);
      statusById.set(id, 'unfulfillable');
      results.push({
        contractId: id,
        title: contract.title,
        slot: contract.slot,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    ran += 1;
  }

  const updatedContracts = contracts.map((c) => {
    const status = statusById.get(c.id);
    return status === undefined ? c : { ...c, status };
  });
  const chart: OrgChart = { ...orgChart, contracts: updatedContracts };

  return {
    results,
    done: [...doneSet],
    failed: [...failedSet],
    skipped: [...skippedSet],
    filesWritten,
    reviews,
    interceptorChangedCount: reviews.filter((r) => r.changed).length,
    chart,
  };
}
