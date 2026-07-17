/**
 * Cross-division handle resolution — the integration layer's assembly step
 * (spec "Integration layer"; §6 the dependency DAG; §0.6 "robustness is
 * external").
 *
 * The architect (architect.ts) publishes an {@link Architecture} of typed
 * {@link InterfaceHandle}s, and each division's manager, seeded with it
 * (contracts.ts), expresses a dependency on another division's work as a symbolic
 * handle: `dependsOn: ["iface:GameState"]`. That handle is NOT a contract id, so
 * on its own the sweep would just drop it. This module turns the handle into a
 * REAL cross-division edge:
 *
 *  {@link resolveInterfaceHandles} rewrites every `iface:<Name>` dependency to
 *  the concrete contract id — in the interface's `exposedBy` division — that
 *  PRODUCES the interface: the contract whose `slot` equals the interface's
 *  `path`, else the first contract in that division. Handles that name no known
 *  interface, or whose owning division authored no contracts, are left untouched
 *  and recorded as unresolved — the existing sanitize sweep then drops them as
 *  dangling ids (spec §0.6). The result feeds `buildOrgChartQueue` unchanged
 *  (sweep → DAG → break cycles), now with genuine cross-division edges.
 *
 * Pure: never mutates inputs, never throws.
 */

import type { Architecture, Contract, InterfaceHandle } from './org-chart.js';

/** The `dependsOn` prefix a manager uses to reference a cross-division interface. */
export const IFACE_PREFIX = 'iface:';

/** One division's authored contracts (the grouping the resolver maps over). */
export interface DivisionContracts {
  /** The division name (matches {@link InterfaceHandle.exposedBy} / `.owner`). */
  readonly division: string;
  readonly contracts: readonly Contract[];
}

/** One `iface:<Name>` handle rewritten to a concrete producing contract id. */
export interface ResolvedHandle {
  /** The raw handle as written, e.g. `iface:GameState`. */
  readonly handle: string;
  /** The interface name, e.g. `GameState`. */
  readonly name: string;
  /** The contract whose `dependsOn` carried the handle. */
  readonly inContract: string;
  /** The division that contract belongs to. */
  readonly inDivision: string;
  /** The producing contract id the handle now points at. */
  readonly resolvedTo: string;
  /** The division that produces the interface (`exposedBy`). */
  readonly exposedBy: string;
  /** True when a producer's `slot` matched the interface `path` (else first-in-division). */
  readonly matchedSlot: boolean;
}

/** Why an `iface:<Name>` handle could not be resolved (it is left for the sweep to drop). */
export type UnresolvedReason = 'unknown-interface' | 'no-producer';

/** One `iface:<Name>` handle that could not be resolved. */
export interface UnresolvedHandle {
  readonly handle: string;
  readonly name: string;
  readonly inContract: string;
  readonly inDivision: string;
  /** `unknown-interface` = no such handle in the architecture; `no-producer` =
   * the exposing division authored no contracts to point at. */
  readonly reason: UnresolvedReason;
}

/** What the resolve pass did — every handle rewritten, and every one left to the sweep. */
export interface IntegrateReport {
  readonly resolved: readonly ResolvedHandle[];
  readonly unresolved: readonly UnresolvedHandle[];
}

/** The resolve output: the flat, rewritten contracts + a report. */
export interface IntegrateResult {
  readonly contracts: Contract[];
  readonly report: IntegrateReport;
}

/** Case/space-insensitive key for matching division + interface names. */
function normKey(s: string): string {
  return s.trim().toLowerCase();
}

/** True when a `dependsOn` entry is a symbolic interface handle. */
export function isInterfaceHandleRef(dep: string): boolean {
  return dep.startsWith(IFACE_PREFIX);
}

/** The interface name from an `iface:<Name>` handle (trimmed; `''` if empty). */
function handleName(dep: string): string {
  return dep.slice(IFACE_PREFIX.length).trim();
}

/**
 * Find the producing contract id for an interface: a contract in the exposing
 * division whose `slot` equals the interface `path`, else the first contract in
 * that division. Returns `undefined` when the division authored no contracts.
 */
function findProducer(
  handle: InterfaceHandle,
  contractsByDivision: Map<string, readonly Contract[]>,
): { id: string; matchedSlot: boolean } | undefined {
  const producers = contractsByDivision.get(normKey(handle.exposedBy));
  if (producers === undefined || producers.length === 0) return undefined;
  const bySlot = producers.find((c) => c.slot === handle.path);
  if (bySlot !== undefined) return { id: bySlot.id, matchedSlot: true };
  const first = producers[0];
  return first === undefined ? undefined : { id: first.id, matchedSlot: false };
}

/**
 * Resolve every `iface:<Name>` dependency across all divisions' contracts to the
 * concrete contract id that produces it (see the module doc). Returns the flat
 * contract list (division order preserved) with rewritten `dependsOn`, plus a
 * report of what resolved and what was left for the sweep to drop. Pure.
 */
export function resolveInterfaceHandles(
  byDivision: readonly DivisionContracts[],
  architecture: Architecture,
): IntegrateResult {
  // Interface lookup by normalized name (first occurrence wins).
  const interfaceByName = new Map<string, InterfaceHandle>();
  for (const h of architecture.interfaces) {
    const key = normKey(h.name);
    if (!interfaceByName.has(key)) interfaceByName.set(key, h);
  }
  // Contracts grouped by normalized division name.
  const contractsByDivision = new Map<string, readonly Contract[]>();
  for (const group of byDivision) contractsByDivision.set(normKey(group.division), group.contracts);

  const resolved: ResolvedHandle[] = [];
  const unresolved: UnresolvedHandle[] = [];
  const out: Contract[] = [];

  for (const group of byDivision) {
    for (const contract of group.contracts) {
      const rewritten: string[] = [];
      let changed = false;
      for (const dep of contract.dependsOn) {
        if (!isInterfaceHandleRef(dep)) {
          if (!rewritten.includes(dep)) rewritten.push(dep);
          continue;
        }
        const name = handleName(dep);
        const handle = name === '' ? undefined : interfaceByName.get(normKey(name));
        if (handle === undefined) {
          unresolved.push({
            handle: dep,
            name,
            inContract: contract.id,
            inDivision: group.division,
            reason: 'unknown-interface',
          });
          if (!rewritten.includes(dep)) rewritten.push(dep); // left for the sweep to drop
          changed = true; // it is not a real id; mark so we always re-emit
          continue;
        }
        const producer = findProducer(handle, contractsByDivision);
        if (producer === undefined) {
          unresolved.push({
            handle: dep,
            name,
            inContract: contract.id,
            inDivision: group.division,
            reason: 'no-producer',
          });
          if (!rewritten.includes(dep)) rewritten.push(dep);
          changed = true;
          continue;
        }
        resolved.push({
          handle: dep,
          name,
          inContract: contract.id,
          inDivision: group.division,
          resolvedTo: producer.id,
          exposedBy: handle.exposedBy,
          matchedSlot: producer.matchedSlot,
        });
        if (!rewritten.includes(producer.id)) rewritten.push(producer.id);
        changed = true;
      }
      out.push(changed ? { ...contract, dependsOn: rewritten } : contract);
    }
  }

  return { contracts: out, report: { resolved, unresolved } };
}

/**
 * Count the queue edges that cross a division boundary — the metric the whole
 * integration layer exists to raise (a siloed plan has ZERO). Given a map from
 * contract id → division name, an edge `from → to` is cross-division when both
 * ends are known and belong to different divisions. Pure.
 */
export function countCrossDivisionEdges(
  edges: readonly { readonly from: string; readonly to: string }[],
  divisionByContractId: ReadonlyMap<string, string>,
): number {
  let count = 0;
  for (const e of edges) {
    const a = divisionByContractId.get(e.from);
    const b = divisionByContractId.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) count += 1;
  }
  return count;
}
