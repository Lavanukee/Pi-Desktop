/**
 * The PLAN, derived from what the team actually did.
 *
 * The situation room has always had a plan panel, and on the mesh path it has
 * always been empty: progress reads `state.checklist`, which only a `checklist`
 * event fills, and the mesh emits `org-chart` / `worker-activity` / `status` /
 * `done` and nothing else. So a run showed a roomful of agents and 0/0 tasks —
 * no roadmap, no progress rail, nothing to follow.
 *
 * The mesh has no contract OBJECT to publish; a contract is a message the manager
 * types to an engineer. That is not a gap to paper over with an invented schema —
 * it is the honest source. A row is a piece of work somebody was actually given:
 *
 *   assigned  the manager (or anyone) handed work to a worker
 *   working   that worker is mid-turn on it
 *   done      it replied, or submitted its work
 *
 * Nothing here decides whether the work was any GOOD — that is the hierarchy's
 * job, and a plan that marked itself green would be the automated verdict jedd
 * rejected. It reports only who was asked for what, and whether they have come
 * back yet.
 *
 * Pure: hops in, checklist out.
 */

/** The shape the coordination `checklist` event carries (kept structural so this
 * module needs no import from the event package). */
export interface PlanRow {
  readonly id: string;
  readonly label: string;
  readonly group?: string;
  readonly state: 'queued' | 'in-progress' | 'done' | 'blocked';
}

/** One hop, as the mesh records it. */
export interface PlanHop {
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly reply: string;
  readonly queued?: boolean;
  readonly refused?: unknown;
}

/** Roles that RECEIVE work worth listing. A reply back up to the CEO, or a
 * specialist being asked a question, is not a piece of the plan. */
function isWorker(agentId: string): boolean {
  return agentId.startsWith('engineer:');
}

/**
 * A readable label for a contract message. The manager writes a whole brief;
 * the row wants the one line that says what it is.
 *
 * Prefers an explicit "WHAT TO BUILD:" line (the contract template's own first
 * field), else the first non-empty line, clipped. A row labelled with 400 words
 * of brief is a row nobody can read.
 */
export function planLabel(message: string): string {
  const lines = message.split('\n').map((l) => l.trim());
  const what = lines.find((l) => /^WHAT TO BUILD\s*:/i.test(l));
  const picked =
    what !== undefined
      ? what.replace(/^WHAT TO BUILD\s*:\s*/i, '')
      : (lines.find((l) => l.length > 0 && !/^\[/.test(l)) ?? 'work');
  const clipped = picked.length > 80 ? `${picked.slice(0, 79)}…` : picked;
  return clipped.length > 0 ? clipped : 'work';
}

/** "engineer:2" → "Engineer 2"; anything else title-cased enough to read. */
export function planGroup(agentId: string): string {
  const m = /^engineer:(\d+)$/.exec(agentId);
  if (m !== null) return `Engineer ${m[1]}`;
  const name = agentId.split(':').pop() ?? agentId;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Fold the hops so far into the plan.
 *
 * One row per (worker, piece of work). A worker given a SECOND, different piece
 * gets a second row — that is a re-contract after a failed check, and hiding it
 * would hide the loop the whole design exists to run. The same message repeated
 * to the same worker is the same row, so a resend does not inflate the count.
 */
export function planFromHops(hops: readonly PlanHop[], active: ReadonlySet<string>): PlanRow[] {
  const rows: PlanRow[] = [];
  const seen = new Map<string, number>(); // dedupe key → index in rows
  for (const hop of hops) {
    if (!isWorker(hop.to)) continue;
    if (hop.refused !== undefined) continue; // never delivered; not work
    const label = planLabel(hop.message);
    const key = `${hop.to}::${label}`;
    const existing = seen.get(key);
    // A queued hop has not been read yet; a delivered one has a real reply.
    const delivered = hop.queued !== true && hop.reply.length > 0;
    const state: PlanRow['state'] = delivered
      ? 'done'
      : active.has(hop.to)
        ? 'in-progress'
        : 'queued';
    if (existing !== undefined) {
      // Later news about the same piece wins — a row only ever moves forward.
      const prior = rows[existing];
      if (prior !== undefined && prior.state !== 'done') {
        rows[existing] = { ...prior, state };
      }
      continue;
    }
    seen.set(key, rows.length);
    rows.push({ id: `${hop.to}#${rows.length}`, label, group: planGroup(hop.to), state });
  }
  return rows;
}
