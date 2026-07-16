/**
 * Cross-division planning — the whole-corporation queue build (spec §5 org
 * chart, §6 the dependency DAG, §0.6 robustness is external).
 *
 * Slice 2 is PLANNING only: once every division's manager has authored its
 * contracts, they are assembled onto one {@link OrgChart} and this module turns
 * that pile of possibly-imperfect contracts into a scheduler-ready queue:
 *
 *  1. run {@link sanitizeContracts} (drop dangling deps, de-collide slots, drop
 *     duplicate ids — spec §0.6);
 *  2. derive the queue edges with {@link edgesFromContracts};
 *  3. verify acyclicity with {@link findCycle}; if a cycle exists, break it
 *     DETERMINISTICALLY by dropping the back-edge (the tail of the cycle path
 *     found by the deterministic DFS) and recording it, then re-check — repeated
 *     until the graph is acyclic;
 *  4. return the {@link OrgChart} with the sanitized contracts, the built queue,
 *     and its run status set to `running` (planned + queued, ready for the
 *     execution slice — dispatch/merge/review are NOT built here).
 *
 * {@link buildOrgChartQueue} is the pure API the spec names; it returns the
 * chart alone. {@link buildOrgChartQueueWithReport} runs the identical logic but
 * also returns the {@link QueueBuildReport} (the sweep repairs + the broken
 * edges) so the driver / situation room can surface what the harness fixed.
 */

import { edgesFromContracts, findCycle } from './dag.js';
import type { Contract, OrgChart, QueueEdge } from './org-chart.js';
import { type SanitizeReport, sanitizeContracts } from './sanitize.js';

/**
 * One dependency edge dropped to break a cycle (spec §6 — the queue MUST be a
 * DAG). `to` depended on `from`; that entry was removed from `to`'s `dependsOn`.
 */
export interface BrokenEdge {
  /** Prerequisite id removed from `to`'s `dependsOn`. */
  readonly from: string;
  /** The dependent contract the edge was removed from. */
  readonly to: string;
  /** The cycle path this edge closed (`[a, …, to, from]`), for logs. */
  readonly cycle: readonly string[];
}

/** What the planning pass repaired: the sweep report + any cycle-breaking. */
export interface QueueBuildReport {
  readonly sweep: SanitizeReport;
  readonly brokenEdges: readonly BrokenEdge[];
  /** Whether the final queue is acyclic — always `true` on a normal return. */
  readonly acyclic: boolean;
}

/** The planning output: the queued chart + a report of every repair made. */
export interface QueueBuildResult {
  readonly chart: OrgChart;
  readonly report: QueueBuildReport;
}

/** Remove prerequisite `from` from the `dependsOn` of the contract `to` (pure). */
function dropDependency(contracts: readonly Contract[], from: string, to: string): Contract[] {
  return contracts.map((c) =>
    c.id === to ? { ...c, dependsOn: c.dependsOn.filter((d) => d !== from) } : c,
  );
}

/**
 * Build the whole-corporation queue and report what was repaired. See the module
 * doc for the four steps. Pure: never mutates `orgChart`, never throws, and
 * always returns a chart whose `queue` is exactly `edgesFromContracts(contracts)`
 * over an acyclic graph.
 */
export function buildOrgChartQueueWithReport(orgChart: OrgChart): QueueBuildResult {
  const { contracts: swept, repairs } = sanitizeContracts(orgChart.contracts);

  let contracts: readonly Contract[] = swept;
  const brokenEdges: BrokenEdge[] = [];
  // Each iteration drops exactly one edge, so the total dependsOn count is a
  // hard upper bound on iterations — a defensive guard against any infinite loop.
  let guard = swept.reduce((n, c) => n + c.dependsOn.length, 0) + 1;
  for (;;) {
    const cycle = findCycle(
      contracts.map((c) => c.id),
      edgesFromContracts(contracts),
    );
    if (cycle === null) break;
    if (guard-- <= 0) break;
    // The back-edge closing the cycle is its tail: `to` (the dependent) depends
    // on `from` (the prerequisite). Dropping it eliminates exactly this cycle.
    const to = cycle[cycle.length - 2];
    const from = cycle[cycle.length - 1];
    if (to === undefined || from === undefined) break;
    contracts = dropDependency(contracts, from, to);
    brokenEdges.push({ from, to, cycle: [...cycle] });
  }

  const queue: readonly QueueEdge[] = edgesFromContracts(contracts);
  const acyclic =
    findCycle(
      contracts.map((c) => c.id),
      queue,
    ) === null;

  const chart: OrgChart = { ...orgChart, contracts, queue, status: 'running' };
  return { chart, report: { sweep: repairs, brokenEdges, acyclic } };
}

/**
 * Build the whole-corporation queue over an {@link OrgChart} whose `contracts`
 * are populated across ALL divisions (spec §5/§6). Runs the sweep, derives the
 * queue edges, and guarantees an acyclic result (breaking cycles deterministically
 * when needed). Returns the chart with sanitized contracts + queue + status set.
 * Use {@link buildOrgChartQueueWithReport} when you also need the repair report.
 */
export function buildOrgChartQueue(orgChart: OrgChart): OrgChart {
  return buildOrgChartQueueWithReport(orgChart).chart;
}
