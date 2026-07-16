/**
 * Referential-integrity sweep over manager-authored contracts (spec §0.6
 * "robustness is external", §5 the Contract shape, §6 the queue).
 *
 * Real-model testing (slice 1, qwen3.5-4b) showed a small manager occasionally
 * emitting three defects the harness must absorb WITHOUT adding more prompt text
 * (spec §0.6 — repair rather than ask the model to be careful):
 *
 *  - a `dependsOn` id that never resolves to any emitted contract (a DANGLING
 *    reference — the manager renamed/cut the target but kept the pointer);
 *  - two contracts whose `slot` is the same file/export (a COLLISION — two
 *    engineers would race to write one injection point);
 *  - two contracts sharing an `id` (a DUPLICATE — ambiguous dispatch + edges).
 *
 * {@link sanitizeContracts} is a pure function: it never throws, always returns
 * a valid {@link Contract}[], and reports exactly what it changed so the
 * situation room / logs can surface the repairs (and so {@link buildOrgChartQueue}
 * can fold them into its planning report).
 *
 * Policy — all deterministic and input-order-preserving:
 *
 *  1. DUPLICATE IDS — the FIRST contract with a given id wins; later duplicates
 *     are dropped (recorded). The kept set defines the valid id space that the
 *     next two steps resolve against.
 *  2. DANGLING / SELF `dependsOn` — within each kept contract, any `dependsOn`
 *     id that doesn't resolve to a *different* kept contract id is dropped
 *     (recorded); a repeated dep is de-duped silently.
 *  3. SLOT COLLISIONS — the FIRST contract to claim a slot OWNS it. Each later
 *     contract targeting that same slot is SERIALIZED after the previous writer
 *     of that slot (that writer's id is appended to the later contract's
 *     `dependsOn`), never renamed and never dropped (recorded).
 *
 * Why SERIALIZE (not rename, not drop) is the safest slot policy: the slot is
 * the injection point the wider program plugs into (spec §5). Renaming the
 * second contract's slot would aim its output at a file nothing references —
 * silently orphaning real work. Dropping the contract throws the work away.
 * Serializing keeps BOTH contributions landing in the real slot, but orders
 * them so (a) no two engineers write the same file concurrently and (b) the
 * later worker builds on the merged earlier one. Chaining each new writer after
 * the *previous* same-slot writer serializes all N writers of a slot in input
 * order — fully deterministic.
 *
 * Note: serialization ADDS ordering dependencies, which — combined with a
 * pre-existing forward reference the manager wrote — could in principle close a
 * cycle. That is by design: sanitize is not the acyclicity authority.
 * {@link buildOrgChartQueue} runs {@link findCycle} AFTER the sweep and breaks
 * any cycle deterministically.
 */

import type { Contract } from './org-chart.js';

/** Why a `dependsOn` entry was removed by the sweep. */
export type DroppedDependencyReason = 'unknown-id' | 'self';

/** One `dependsOn` id removed from a contract during the sweep. */
export interface DroppedDependency {
  /** The contract whose `dependsOn` was edited. */
  readonly contractId: string;
  /** The id that was removed. */
  readonly dependsOn: string;
  /** `unknown-id` = no emitted contract has that id; `self` = a self-dependency. */
  readonly reason: DroppedDependencyReason;
}

/** One later contract serialized behind an earlier writer of the same slot. */
export interface SlotCollision {
  /** The contended slot (file/module/export). */
  readonly slot: string;
  /** The first contract to claim the slot — it keeps the slot unchanged. */
  readonly owner: string;
  /** The later contract that was serialized (its work still targets `slot`). */
  readonly contractId: string;
  /** The previous same-slot writer that `contractId` now `dependsOn`. */
  readonly serializedAfter: string;
}

/** One later contract dropped because an earlier contract already used its id. */
export interface DuplicateId {
  /** The shared id (the first contract with it was kept). */
  readonly id: string;
  /** The dropped contract's title, for human-legible logs. */
  readonly droppedTitle: string;
}

/** Everything the sweep changed. All arrays empty ⇒ the input was already clean. */
export interface SanitizeReport {
  readonly duplicateIds: readonly DuplicateId[];
  readonly droppedDependencies: readonly DroppedDependency[];
  readonly slotCollisions: readonly SlotCollision[];
}

/** The sweep output: the repaired contracts + a report of every repair made. */
export interface SanitizeResult {
  readonly contracts: readonly Contract[];
  readonly repairs: SanitizeReport;
}

/** Total number of individual repairs in a report (0 ⇒ the input was clean). */
export function sanitizeRepairCount(report: SanitizeReport): number {
  return (
    report.duplicateIds.length + report.droppedDependencies.length + report.slotCollisions.length
  );
}

/** True when the sweep made no changes at all. */
export function isSanitizeReportClean(report: SanitizeReport): boolean {
  return sanitizeRepairCount(report) === 0;
}

/**
 * Run the referential-integrity sweep (see the module doc for the full policy).
 * Pure — never mutates the input contracts, never throws, always returns a valid
 * {@link Contract}[] plus a {@link SanitizeReport} of every repair.
 */
export function sanitizeContracts(contracts: readonly Contract[]): SanitizeResult {
  const duplicateIds: DuplicateId[] = [];
  const droppedDependencies: DroppedDependency[] = [];
  const slotCollisions: SlotCollision[] = [];

  // 1. Dedupe ids — the first occurrence of an id wins; drop later duplicates.
  const keptIds = new Set<string>();
  const deduped: Contract[] = [];
  for (const c of contracts) {
    if (keptIds.has(c.id)) {
      duplicateIds.push({ id: c.id, droppedTitle: c.title });
      continue;
    }
    keptIds.add(c.id);
    deduped.push(c);
  }

  // 2. Clean each kept contract's dependsOn against the kept id set: drop
  //    dangling (unknown) ids and self-references; de-dupe repeats silently.
  const cleaned: Contract[] = deduped.map((c) => {
    const kept: string[] = [];
    const seenDeps = new Set<string>();
    for (const dep of c.dependsOn) {
      if (dep === c.id) {
        droppedDependencies.push({ contractId: c.id, dependsOn: dep, reason: 'self' });
        continue;
      }
      if (!keptIds.has(dep)) {
        droppedDependencies.push({ contractId: c.id, dependsOn: dep, reason: 'unknown-id' });
        continue;
      }
      if (seenDeps.has(dep)) continue; // repeated dep — harmless, drop silently
      seenDeps.add(dep);
      kept.push(dep);
    }
    return kept.length === c.dependsOn.length ? c : { ...c, dependsOn: kept };
  });

  // 3. De-collide slots — the first writer owns the slot; every later writer of
  //    the same slot is serialized after the previous one (chain in input order).
  const ownerBySlot = new Map<string, string>();
  const lastWriterBySlot = new Map<string, string>();
  const finalContracts: Contract[] = cleaned.map((c) => {
    const previous = lastWriterBySlot.get(c.slot);
    lastWriterBySlot.set(c.slot, c.id);
    if (previous === undefined) {
      ownerBySlot.set(c.slot, c.id);
      return c;
    }
    const owner = ownerBySlot.get(c.slot) ?? previous;
    slotCollisions.push({ slot: c.slot, owner, contractId: c.id, serializedAfter: previous });
    if (c.dependsOn.includes(previous)) return c; // already ordered after it
    return { ...c, dependsOn: [...c.dependsOn, previous] };
  });

  return {
    contracts: finalContracts,
    repairs: { duplicateIds, droppedDependencies, slotCollisions },
  };
}
