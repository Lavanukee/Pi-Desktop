/**
 * Escalation — the stuck-contract control path (spec §9).
 *
 * "Escalation = conflict radius." An unfulfillable/failed contract does not deadlock
 * the run and does not travel to the top: it escalates exactly ONE level, to the
 * MANAGER that holds the queue/roadmap, who re-scopes — re-contract, reorder, or
 * accept the gap. This module ships the pure pieces of that seam:
 *
 *  - {@link escalateContract} — given a failed contract id, produce the
 *    {@link EscalationRecord} routing it up to its owning manager (the nearest
 *    `manager` ancestor of the contract's owner, else the manager block).
 *  - {@link buildManagerRescopePrompt} — the manager's re-scope turn.
 *  - {@link resolveEscalation} / {@link runBoundedEscalation} — the BOUNDED loop:
 *    exactly one re-scope attempt; if it does not fix the contract, the gap is
 *    ACCEPTED and recorded (never a retry storm, never a deadlock).
 *
 * Pure (aside from the injected re-scope seam in {@link runBoundedEscalation});
 * never mutates the chart, never throws.
 */

import type { Contract, OrgChart, OrgNode } from './org-chart.js';

/** The action routing a failed contract one level up to its owning manager. */
export interface EscalationRecord {
  /** The contract being escalated. */
  readonly contractId: string;
  /** The node id of the manager that must re-scope it (the queue/roadmap owner). */
  readonly ownerManager: string;
  /** Why it was escalated (the engineer's reason, or a status-derived default). */
  readonly reason: string;
}

/** The outcome of a BOUNDED escalation: one attempt, then resolved or an accepted gap. */
export interface EscalationOutcome {
  /** The escalation that was attempted. */
  readonly record: EscalationRecord;
  /** How many re-scope attempts ran — always 1 (escalation is bounded). */
  readonly attempts: number;
  /** True when the single re-scope attempt fixed the contract. */
  readonly resolved: boolean;
  /** True when it did NOT — the gap is accepted and recorded, never retried. */
  readonly acceptedGap: boolean;
}

/**
 * The node id of the manager that owns a contract: the nearest `manager` ancestor
 * of the contract's owner node, walking `parentId` up. Because a contract's
 * `ownerNodeId` is usually an engineer SLOT (a string, not a real node), the walk
 * commonly finds nothing — so it falls back to the (single) permanent manager
 * block, then the CEO. Returns `undefined` only for a chart with neither. Pure.
 */
function owningManagerId(orgChart: OrgChart, ownerNodeId: string | undefined): string | undefined {
  const byId = new Map<string, OrgNode>(orgChart.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let cur = ownerNodeId !== undefined ? byId.get(ownerNodeId) : undefined;
  while (cur !== undefined && !seen.has(cur.id)) {
    if (cur.role === 'manager') return cur.id;
    seen.add(cur.id);
    cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined;
  }
  const manager = orgChart.nodes.find((n) => n.role === 'manager');
  if (manager !== undefined) return manager.id;
  return orgChart.nodes.find((n) => n.role === 'ceo')?.id;
}

/** Default reason from a contract's status when the caller supplies none. */
function reasonForStatus(contract: Contract | undefined): string {
  if (contract === undefined) return 'contract not found in the chart';
  if (contract.status === 'unfulfillable') {
    return `contract "${contract.title}" was returned unfulfillable`;
  }
  return `contract "${contract.title}" failed to complete`;
}

/**
 * Produce the {@link EscalationRecord} that routes a failed contract ONE level up
 * to its owning manager (spec §9). `reason` overrides the status-derived default
 * (e.g. the engineer's concrete "unfulfillable, because X"). Pure — reads the
 * chart, mutates nothing. When the contract id is unknown the record still routes
 * to the manager block so the caller is never left without a target.
 */
export function escalateContract(
  orgChart: OrgChart,
  contractId: string,
  reason?: string,
): EscalationRecord {
  const contract = orgChart.contracts.find((c) => c.id === contractId);
  const ownerManager = owningManagerId(orgChart, contract?.ownerNodeId) ?? '';
  const supplied = reason?.trim();
  return {
    contractId,
    ownerManager,
    reason: supplied !== undefined && supplied !== '' ? supplied : reasonForStatus(contract),
  };
}

/**
 * Build the manager's re-scope turn for an escalated contract (spec §9). The
 * manager holds the queue/roadmap, so it is asked to ADAPT: re-contract the work
 * more narrowly, split or reorder it, or — when it genuinely cannot be delivered —
 * accept the gap and say what will not ship. Pure string composition.
 */
export function buildManagerRescopePrompt(contract: Contract, reason: string): string {
  return [
    'One of your contracts came back unfulfillable. You own the queue and roadmap — re-scope it.',
    '',
    'THE STUCK CONTRACT',
    `- Title: ${contract.title}`,
    `- Slot: ${contract.slot}`,
    `- Input: ${contract.input}`,
    `- Output (what it was meant to produce): ${contract.output}`,
    `- Why it is stuck: ${reason}`,
    '',
    'Choose the smallest adaptation that keeps the vision on track:',
    '- RE-CONTRACT: rewrite it as a narrower, more concrete contract (or split it into a few smaller ones) that an engineer can actually fulfil.',
    '- REORDER: if it is blocked by missing prerequisites, say which must come first.',
    '- ACCEPT THE GAP: if it genuinely cannot be delivered as scoped, say so plainly and state exactly what will not ship — do not pretend it is done.',
    '',
    'Respond with your decision and, if re-contracting, the revised contract(s). Escalate to the CEO only if the vision itself is at stake.',
  ].join('\n');
}

/**
 * The pure core of the bounded escalation: given the record and whether the single
 * re-scope attempt fixed the contract, return the {@link EscalationOutcome}. Always
 * exactly one attempt — a still-failing contract becomes an ACCEPTED GAP, never a
 * retry. Pure.
 */
export function resolveEscalation(record: EscalationRecord, resolved: boolean): EscalationOutcome {
  return { record, attempts: 1, resolved, acceptedGap: !resolved };
}

/**
 * Run the BOUNDED escalation (spec §9): invoke `attemptRescope` EXACTLY once and
 * fold its result into an {@link EscalationOutcome}. This is the "one re-scope
 * attempt → if still failing, record as an accepted gap, never deadlock" rule made
 * concrete — there is no loop, so the run can never get stuck on a bad contract.
 * `attemptRescope` returns `true` when the re-scope produced a fix.
 */
export async function runBoundedEscalation(params: {
  readonly record: EscalationRecord;
  readonly attemptRescope: (record: EscalationRecord) => Promise<boolean> | boolean;
}): Promise<EscalationOutcome> {
  const resolved = await params.attemptRescope(params.record);
  return resolveEscalation(params.record, resolved === true);
}
