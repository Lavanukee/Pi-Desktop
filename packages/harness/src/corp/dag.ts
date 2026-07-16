/**
 * Tiny dependency-DAG helpers over the contract queue (spec §6).
 *
 * Pure functions, no state: the scheduler (Phase 2) and the checklist renderer
 * both derive everything from ({@link Contract.dependsOn} / {@link QueueEdge})
 * on demand. Semantics: an edge `from → to` means `from` must be completed
 * (merged) before `to` may start. Parallelism is always OPTIONAL — these
 * helpers only ever narrow what MAY run, never require concurrency.
 */

import type { Contract, QueueEdge } from './org-chart.js';

/** Derive the explicit queue edges from the contracts' `dependsOn` lists. */
export function edgesFromContracts(contracts: readonly Contract[]): readonly QueueEdge[] {
  const edges: QueueEdge[] = [];
  for (const c of contracts) {
    for (const dep of c.dependsOn) edges.push({ from: dep, to: c.id });
  }
  return edges;
}

/** Map of node id → its prerequisite ids (deduped; every id gets an entry). */
function prerequisites(
  ids: readonly string[],
  edges: readonly QueueEdge[],
): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const id of ids) deps.set(id, new Set());
  for (const e of edges) {
    // Edges referencing unknown ids are ignored rather than fabricated: the
    // queue may briefly mention a contract the managers already cut.
    if (!deps.has(e.to) || !deps.has(e.from)) continue;
    deps.get(e.to)?.add(e.from);
  }
  return deps;
}

/**
 * The ids that are READY: not yet completed, and every prerequisite completed.
 * Input order is preserved (managers' queue order = tie-break priority).
 * Prerequisites not present in `ids` are treated as external/already-satisfied
 * only if listed in `completed`; otherwise they block.
 */
export function readyIds(
  ids: readonly string[],
  edges: readonly QueueEdge[],
  completed: ReadonlySet<string>,
): readonly string[] {
  const known = new Set(ids);
  const blockers = new Map<string, string[]>();
  for (const e of edges) {
    if (!known.has(e.to)) continue;
    const list = blockers.get(e.to);
    if (list === undefined) blockers.set(e.to, [e.from]);
    else list.push(e.from);
  }
  return ids.filter((id) => {
    if (completed.has(id)) return false;
    const pre = blockers.get(id) ?? [];
    return pre.every((p) => completed.has(p));
  });
}

/**
 * Convenience over a contract list: the contracts that may start now, given
 * that `merged` contracts count as completed. Phase-2 scheduling will layer
 * capacity on top; this is pure graph logic.
 */
export function readyContracts(
  contracts: readonly Contract[],
  edges: readonly QueueEdge[],
): readonly Contract[] {
  const completed = new Set(contracts.filter((c) => c.status === 'merged').map((c) => c.id));
  const ready = new Set(
    readyIds(
      contracts.map((c) => c.id),
      edges,
      completed,
    ),
  );
  return contracts.filter((c) => ready.has(c.id));
}

/**
 * Kahn topological order over `ids` (stable: among available nodes, input
 * order wins). Returns `null` if the edges contain a cycle — callers surface
 * that as a manager-must-fix condition, they don't guess an order.
 */
export function topologicalOrder(
  ids: readonly string[],
  edges: readonly QueueEdge[],
): readonly string[] | null {
  const deps = prerequisites(ids, edges);
  const order: string[] = [];
  const placed = new Set<string>();
  const remaining = [...ids];
  while (remaining.length > 0) {
    const i = remaining.findIndex((id) => {
      const pre = deps.get(id);
      return pre === undefined || [...pre].every((p) => placed.has(p));
    });
    if (i === -1) return null; // every remaining node waits on another → cycle
    const id = remaining.splice(i, 1)[0];
    if (id === undefined) return null; // unreachable; satisfies noUncheckedIndexedAccess
    order.push(id);
    placed.add(id);
  }
  return order;
}

/**
 * Find one dependency cycle, as the ids along it (first id repeated at the
 * end for readability: `['a','b','a']`), or `null` if the graph is acyclic.
 * Deterministic: DFS in input order.
 */
export function findCycle(
  ids: readonly string[],
  edges: readonly QueueEdge[],
): readonly string[] | null {
  const deps = prerequisites(ids, edges);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]));
  const stack: string[] = [];

  const visit = (id: string): readonly string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const pre of deps.get(id) ?? []) {
      const c = color.get(pre);
      if (c === GRAY) {
        const start = stack.indexOf(pre);
        return [...stack.slice(start), pre];
      }
      if (c === WHITE) {
        const found = visit(pre);
        if (found !== null) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of ids) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found !== null) return found;
    }
  }
  return null;
}
