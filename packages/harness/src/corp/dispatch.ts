/**
 * Contract dispatch — the execution core (spec §7 execution, §6 the dependency
 * DAG, §0.6 "robustness is external").
 *
 * Once planning (slice 2/3) has produced an acyclic {@link OrgChart} queue, this
 * module hands each contract to an engineer, IN DEPENDENCY ORDER. The engineer
 * seam WRITES its slot file to the workspace (the chat/fallback seam parses its
 * reply and `writeSlot`s it; the agent seam writes via tools) and returns the
 * {@link WrittenFile}s; the dispatcher RECORDS them and reads the slot file back
 * (via {@link WorkspaceReadFs}) to confirm it exists, size it, and forward its
 * content to dependents. It is pure orchestration behind two injected seams —
 * {@link RunEngineer} (the engineer turn) and {@link WorkspaceReadFs} (reading
 * produced files back) — so the whole loop is unit-testable with a mock engineer
 * and an in-memory store, no model and no disk.
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
 *  - BOUNDED CONCURRENCY (spec §6): up to `concurrency` engineer jobs run at once,
 *    still respecting the DAG (a job starts only once every dep is DONE). The
 *    default width 1 is byte-for-byte the original sequential walk. Correctness
 *    never depends on the width — only speed does — so the report is EMITTED in
 *    topological `order` (per-id outcomes collected into maps), identical however
 *    the pool happened to schedule the jobs.
 *
 * The submission interceptor (spec §7, MODEL-FREE) is a thin wrapper
 * ({@link withSubmissionReview}) around the engineer seam, so the dispatch loop
 * itself stays clean and knows nothing about the self-review bounce.
 */

import { edgesFromContracts, topologicalOrder } from './dag.js';
import { buildSelfReviewPrompt, type DependencyContext } from './engineer.js';
import type { Contract, ContractStatus, OrgChart, OrgNode } from './org-chart.js';
import { slotPath, type WorkspaceReadFs } from './workspace.js';

// --- The engineer seam -------------------------------------------------------

/** One file the engineer wrote to the workspace (the slot file, plus any small
 * supporting files an agent engineer creates within its region). */
export interface WrittenFile {
  /** Absolute path written. */
  readonly path: string;
  /** UTF-8 byte length of the produced file. */
  readonly bytes: number;
}

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
  /** The owning {@link OrgNode}'s library prompt id (for the agent path's composed
   * system prompt); absent when the owner node is not in the chart (defaults to
   * `'engineer'`). */
  readonly promptId?: string;
  /** The owning node's light prompt extension (division flavor), when present. */
  readonly promptExtension?: string;
  /** Set on the self-review bounce; absent on the first draft turn. */
  readonly review?: EngineerReview;
}

/**
 * The engineer turn as a seam: given a request, WRITE the file(s) for the
 * contract's slot into the workspace and return the {@link WrittenFile}s written.
 * BOTH engineer paths conform: the chat/fallback seam parses the reply text and
 * `writeSlot`s it itself (returning `[{path,bytes}]`); the AGENT seam has already
 * written via tools (returning `result.filesWritten`). The dispatcher no longer
 * writes — it RECORDS what the seam wrote and reads the slot file back for the
 * dependents' context. Sync or async; a mock in tests, the model-backed impl in
 * the driver.
 */
export type RunEngineer = (
  request: EngineerRequest,
) => Promise<readonly WrittenFile[]> | readonly WrittenFile[];

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
  readSlot: (request: EngineerRequest) => string | undefined,
  capture?: ReviewSink,
  includeBodies = false,
): RunEngineer {
  const reviewed = new Set<string>();
  return async (request) => {
    const id = request.contract.id;
    // Already bounced once (or a pre-formed review turn) → accept without re-review.
    if (request.review !== undefined || reviewed.has(id)) return run(request);
    reviewed.add(id);
    // FILE MODEL: each seam call WRITES the slot; the draft/reviewed CONTENT is
    // read back from disk (not returned), so the interceptor measures the real
    // on-disk quality delta. The draft content is fed back as the review turn's
    // prior submission.
    await run(request); // first submit → writes the slot
    const draft = readSlot(request) ?? '';
    const finalFiles = await run({
      ...request,
      review: { priorSubmission: draft, prompt: buildSelfReviewPrompt(request.contract) },
    }); // review turn → rewrites the slot
    const reviewedContent = readSlot(request) ?? '';
    if (capture !== undefined) {
      capture({
        contractId: id,
        draftBytes: byteLength(draft),
        reviewedBytes: byteLength(reviewedContent),
        changed: draft !== reviewedContent,
        ...(includeBodies ? { draft, reviewed: reviewedContent } : {}),
      });
    }
    return finalFiles;
  };
}

// --- Dispatch report ---------------------------------------------------------

/** Outcome of dispatching one contract. */
export type DispatchStatus = 'done' | 'failed' | 'skipped';

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
  /** The engineer seam (mock in tests, model-backed in the driver). The seam
   * WRITES the file(s); dispatch records them and reads the slot back. */
  readonly runEngineer: RunEngineer;
  /** The workspace READ seam (in-memory in tests, node:fs in the driver). Dispatch
   * reads each contract's produced slot file back — to confirm it exists (→ done),
   * to size it, and to forward its content to dependents. Writing is the seam's job. */
  readonly readFs: WorkspaceReadFs;
  /** The per-task workspace root; the seam writes files at `<workspace>/<slot>`. */
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
  /**
   * Run up to this many engineer jobs CONCURRENTLY (bounded by the DAG — a job
   * still starts only once every dep is DONE). Default 1 = the original sequential
   * walk, byte-for-byte. Values < 1 are clamped to 1. At most `concurrency` model
   * turns are ever in flight (each job runs engineer→review sequentially WITHIN
   * itself), so this is the OOM-safe knob for finishing a large plan in-budget.
   */
  readonly concurrency?: number;
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

/** Resolve a seam-reported path to an absolute workspace path: an already-absolute
 * path is kept; a relative one (an agent addressing files under its cwd) is placed
 * beneath the workspace root (via {@link slotPath}, which also sanitizes it). */
function absoluteInWorkspace(workspace: string, filePath: string): string {
  const isAbsolute = filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
  return isAbsolute ? filePath : slotPath(workspace, filePath);
}

/** The settled result of ONE engineer job — the SAME per-contract work as the
 * serial loop, done off in a promise so the pool can run up to `concurrency` at
 * once. `ok: true` carries the produced file + write; `ok: false` carries the
 * engineer error (a job NEVER throws — it captures the failure, exactly as the
 * serial try/catch did). */
type JobOutcome =
  | {
      readonly id: string;
      readonly ok: true;
      /** The produced slot-file content, read back from the workspace (forwarded
       * to dependents' depContext). */
      readonly slotContent: string;
      /** The absolute slot path + its size (the per-contract result). */
      readonly path: string;
      readonly bytes: number;
      /** Every file the seam wrote for this contract (slot + supporting files). */
      readonly files: readonly WrittenFile[];
    }
  | { readonly id: string; readonly ok: false; readonly error: string };

/**
 * Dispatch the chart's contracts to engineers in DEPENDENCY order, writing each
 * produced file to `<workspace>/<slot>`. See the module doc for the ordering +
 * failure policy. A BOUNDED-CONCURRENCY DAG walk (default width 1 = sequential,
 * byte-for-byte); pure orchestration behind the injected engineer + fs seams.
 * Never mutates the input chart; never throws (an engineer error is captured as a
 * FAILED result). The report is emitted in topological `order`, so it is identical
 * however the pool scheduled the jobs. Returns a {@link DispatchReport}.
 */
export async function dispatchContracts(options: DispatchOptions): Promise<DispatchReport> {
  const { orgChart, readFs, workspace } = options;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  // Bounded concurrency width — default 1 (the original sequential walk); < 1 is
  // meaningless (it could never start a job) so clamp up to 1.
  const concurrency = Math.max(1, options.concurrency ?? 1);

  // Read a contract's produced slot file back from the workspace (the seam wrote
  // it there). Used to forward dep content, size the primary file, decide
  // done/failed, and measure the submission review.
  const readSlot = (request: EngineerRequest): string | undefined =>
    readFs.readFile(slotPath(workspace, request.contract.slot));

  // Fix 3: when measuring the interceptor, dispatch owns the capturing review
  // (it IS the interceptor); otherwise honor a caller-supplied interceptor.
  // Captured records go into a per-id map so the report can emit them in
  // topological order (deterministic regardless of completion order).
  const reviewById = new Map<string, ReviewRecord>();
  let run: RunEngineer;
  if (options.captureReviews === true) {
    run = withSubmissionReview(
      options.runEngineer,
      readSlot,
      (record) => reviewById.set(record.contractId, record),
      options.includeReviewBodies === true,
    );
  } else if (options.interceptor !== undefined) {
    run = options.interceptor(options.runEngineer);
  } else {
    run = options.runEngineer;
  }

  const contracts = orgChart.contracts;
  const byId = new Map(contracts.map((c) => [c.id, c] as const));
  const nodeById = new Map<string, OrgNode>(orgChart.nodes.map((n) => [n.id, n] as const));
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
  // Per-id outcome maps — the report EMITS every field in topological `order`
  // (below), never completion order, so a run's report is identical no matter how
  // the pool scheduled the jobs.
  const resultById = new Map<string, ContractDispatchResult>();
  // A contract can write more than one file on the agent path (slot + small
  // supporting files); the report flattens these per id in topological order.
  const filesById = new Map<string, WrittenFile[]>();

  const isTerminal = (id: string): boolean =>
    doneSet.has(id) || failedSet.has(id) || skippedSet.has(id);

  const inFlight = new Map<string, Promise<JobOutcome>>();
  let started = 0; // counts STARTED jobs (skips do NOT count) — mirrors serial `ran`.

  // Start one engineer job: the SAME per-contract work as the serial loop. Its
  // depContext is built from the deps' PRODUCED files HERE, at start time — a job
  // only ever starts once every dep is DONE, so those files are present. The job
  // never throws; it settles to a {@link JobOutcome} the pool applies below.
  const startJob = (contract: Contract): void => {
    const id = contract.id;
    const depContext = contract.dependsOn
      .map((d) => makeDepContext(byId.get(d), produced.get(d)))
      .filter((c): c is DependencyContext => c !== undefined);
    const architectureRegion = moduleRegionForSlot(orgChart, contract.slot);
    // Thread the owning node's library prompt id / light extension so the agent
    // path can compose the engineer's system prompt (missing node → defaults).
    const node = nodeById.get(contract.ownerNodeId);
    const primaryPath = slotPath(workspace, contract.slot);
    started += 1;
    inFlight.set(
      id,
      (async (): Promise<JobOutcome> => {
        try {
          const files = await run({
            contract,
            depContext,
            ...(architectureRegion !== undefined ? { architectureRegion } : {}),
            ...(node?.promptId !== undefined ? { promptId: node.promptId } : {}),
            ...(node?.promptExtension !== undefined
              ? { promptExtension: node.promptExtension }
              : {}),
          });
          // The seam WROTE the file(s). Read the slot back: present ⇒ done (its
          // content forwards to dependents); ABSENT ⇒ the contract failed (the
          // engineer never produced its slot file).
          const slotContent = readSlot({ contract, depContext });
          if (slotContent === undefined) {
            return {
              id,
              ok: false,
              error: `engineer did not write the slot file ${contract.slot}`,
            };
          }
          return {
            id,
            ok: true,
            slotContent,
            path: primaryPath,
            bytes: byteLength(slotContent),
            files: [...files],
          };
        } catch (err) {
          return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      })(),
    );
  };

  // Fold one settled job into the shared sets (done → produced/doneSet/in-review +
  // a written file + a done result; failed → failedSet/unfulfillable + a failed
  // result). Same records the serial loop wrote, keyed by id for ordered emit.
  const applyOutcome = (outcome: JobOutcome, contract: Contract): void => {
    if (outcome.ok) {
      produced.set(outcome.id, outcome.slotContent);
      doneSet.add(outcome.id);
      statusById.set(outcome.id, 'in-review');
      // Record every file the seam wrote (slot + any supporting files), deduped by
      // absolute path, with the primary slot file guaranteed present. Relative
      // paths (an agent addressing files under its cwd) resolve against the
      // workspace so the report is a set of real, distinct paths.
      const byPath = new Map<string, WrittenFile>();
      for (const f of outcome.files) {
        const abs = absoluteInWorkspace(workspace, f.path);
        byPath.set(abs, { path: abs, bytes: f.bytes });
      }
      byPath.set(outcome.path, { path: outcome.path, bytes: outcome.bytes });
      filesById.set(outcome.id, [...byPath.values()]);
      resultById.set(outcome.id, {
        contractId: outcome.id,
        title: contract.title,
        slot: contract.slot,
        status: 'done',
        path: outcome.path,
        bytes: outcome.bytes,
      });
    } else {
      failedSet.add(outcome.id);
      statusById.set(outcome.id, 'unfulfillable');
      resultById.set(outcome.id, {
        contractId: outcome.id,
        title: contract.title,
        slot: contract.slot,
        status: 'failed',
        error: outcome.error,
      });
    }
  };

  const recordSkip = (contract: Contract, blockedBy: readonly string[]): void => {
    skippedSet.add(contract.id);
    resultById.set(contract.id, {
      contractId: contract.id,
      title: contract.title,
      slot: contract.slot,
      status: 'skipped',
      skippedBecause: blockedBy,
    });
  };

  // --- BOUNDED-CONCURRENCY DAG WALK ------------------------------------------
  // Each outer turn: (1) walk `order` once and, for every not-yet-terminal /
  // not-in-flight contract, either SKIP it (a dep failed/was skipped — cascade),
  // START it (all deps done, and both the `limit` and `concurrency` gates allow),
  // or leave it (a dep is still pending). Then, if nothing is in flight, terminate;
  // otherwise AWAIT the next job to settle (never busy-spin) and repeat — a newly
  // failed/skipped contract cascades to its dependents on the next walk. The
  // `started >= limit` break mirrors the serial loop's `if (ran >= limit) break`,
  // so at concurrency 1 this is byte-for-byte the old sequential behavior.
  for (;;) {
    for (const id of order) {
      const contract = byId.get(id);
      if (contract === undefined) continue;
      if (isTerminal(id) || inFlight.has(id)) continue;
      // Once `limit` STARTED jobs is reached, start nothing further and evaluate
      // nothing further this walk (exactly the serial break) — let in-flight finish.
      if (started >= limit) break;
      const blockedBy = contract.dependsOn.filter((d) => failedSet.has(d) || skippedSet.has(d));
      if (blockedBy.length > 0) {
        recordSkip(contract, blockedBy);
        continue;
      }
      const ready = contract.dependsOn.every((d) => doneSet.has(d));
      // Ready + a free concurrency slot → start it. Not ready (a dep is in flight /
      // unstarted) or the pool is full → leave it for a later walk.
      if (ready && inFlight.size < concurrency) startJob(contract);
    }

    if (inFlight.size === 0) {
      // Nothing running. Either everything is terminal, the `limit` cut us off
      // (remaining contracts stay unreached, exactly as the serial break), or the
      // graph is stuck — only reachable on the CYCLIC fallback `order`, since a
      // valid DAG always has an actionable source when nothing is in flight. Skip
      // whatever remains with its unmet deps so a bad chart can never hang.
      const allTerminal = order.every((id) => byId.get(id) === undefined || isTerminal(id));
      if (allTerminal || started >= limit) break;
      for (const id of order) {
        const contract = byId.get(id);
        if (contract === undefined || isTerminal(id)) continue;
        recordSkip(
          contract,
          contract.dependsOn.filter((d) => !doneSet.has(d)),
        );
      }
      break;
    }

    const outcome = await Promise.race(inFlight.values());
    inFlight.delete(outcome.id);
    const settled = byId.get(outcome.id);
    if (settled !== undefined) applyOutcome(outcome, settled);
  }

  // DETERMINISTIC EMIT: every list is built in topological `order`, so the report
  // is identical regardless of the (nondeterministic) completion order.
  const results = order
    .map((id) => resultById.get(id))
    .filter((r): r is ContractDispatchResult => r !== undefined);
  const filesWritten = order.flatMap((id) => filesById.get(id) ?? []);
  const reviews = order
    .map((id) => reviewById.get(id))
    .filter((r): r is ReviewRecord => r !== undefined);
  const done = order.filter((id) => doneSet.has(id));
  const failed = order.filter((id) => failedSet.has(id));
  const skipped = order.filter((id) => skippedSet.has(id));

  const updatedContracts = contracts.map((c) => {
    const status = statusById.get(c.id);
    return status === undefined ? c : { ...c, status };
  });
  const chart: OrgChart = { ...orgChart, contracts: updatedContracts };

  return {
    results,
    done,
    failed,
    skipped,
    filesWritten,
    reviews,
    interceptorChangedCount: reviews.filter((r) => r.changed).length,
    chart,
  };
}
