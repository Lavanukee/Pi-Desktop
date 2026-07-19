/**
 * CEO final sign-off — the FALSE-COMPLETION CURE (spec §8, §9).
 *
 * The structural guarantee the whole harness rests on: the CEO cannot rubber-stamp
 * its own work, because it never received the build. Its context is exactly the
 * vision it set → (work happens out of sight) → the finished product handed back
 * cold. So it reviews as a genuinely different entity — a real second opinion.
 *
 * This module ships the pure pieces of that review turn:
 *  - {@link CEO_REVIEW_PROMPT} — the CEO's clean-context final-review SYSTEM prompt.
 *  - {@link buildCeoReviewPrompt} — the USER turn, seeded with EXACTLY three things
 *    and nothing else: the ORIGINAL user task, the product manifest (assemble.ts),
 *    and the verify evidence (verify.ts). The parameter type has no field for the
 *    build transcript, so the clean-context isolation is enforced by the SHAPE —
 *    there is no way to pass the transcript in (spec §8 guardrail).
 *  - {@link parseCeoDecision} — tolerant parse of the reply into
 *    `{ decision: 'approve' | 'revise', notes? }`.
 *
 * The CEO runs the `intelligent` tier (prompts.ts `tierForRole('ceo')`) and
 * thinking-ON (`roleThinkingEnabled('ceo')`) — its reasoning IS the value.
 *
 * The decision GATES submission (wired in the driver): `approve` → the product is
 * submitted / the run is done; `revise` → the notes route back DOWN to the owning
 * division/manager as a bounded revision loop (re-contract against the notes, then
 * re-review), never an unbounded churn.
 */

import type { ProductManifest } from './assemble.js';
import type { PreflightResult } from './preflight.js';
import type { VerifyResult } from './verify.js';

/**
 * The CEO's final-review SYSTEM prompt. Deliberately frames the CLEAN, vision-only
 * context: the CEO never saw the build and judges the product cold against the
 * standard the original task set. Asks for an unambiguous leading verdict so
 * {@link parseCeoDecision} is reliable.
 */
export const CEO_REVIEW_PROMPT = `You are the CEO of this project, giving the FINAL sign-off. You hold the vision — and only the vision. You never saw the build: no transcripts, no intermediate work, no engineer chatter. You are handed exactly three things and nothing else — the ORIGINAL task you set as the standard, a manifest of the finished product, and the objective build evidence (an automated verification pass) — and you review the product cold, as a genuinely fresh pair of eyes.

Your job is one judgment: does this finished product meet the standard the original task set?

- It must ACTUALLY BUILD AND RUN. The tester's measured evidence (a build log, a headless run, a screenshot) and the objective verification pass are ground truth: if the product failed to build, threw at runtime, has a console error, has no runnable entry, or the described feature does not actually appear, then it does NOT meet the bar — however complete the manifest looks. A pile of files is not a working product.
- Weigh the product manifest, the tester/specialist findings, and the verification evidence against the original task. Confirm from that measured evidence that it works before you approve.
- Do not rubber-stamp. You are the cure for false completion: a build that reports itself "done" still has to actually meet the vision and actually run.
- Make your decision unambiguous. Begin your reply with a single word on its own line — APPROVE or REVISE:
  - APPROVE — the product builds, runs, and meets the standard; it ships.
  - REVISE — it does not yet. Follow the word with specific, actionable notes addressed to the exact gap (which deliverable, what is wrong — a build/runtime failure, a missing feature, off styling — and what "done" looks like). Vague dissatisfaction is not a note.`;

/** The (at most four) inputs to a CEO review — the clean artifact, never the build
 * transcript. The absence of any transcript field IS the §8 guardrail; the optional
 * specialist FINDINGS summary is MEASURED evidence (spec §8 review-at-merge), not a
 * transcript, so it preserves the clean-context isolation by shape. */
export interface CeoReviewInput {
  /** The ORIGINAL user task — the standard the CEO set and judges against. */
  readonly originalTask: string;
  /** The finished-product manifest (assemble.ts). */
  readonly manifest: ProductManifest;
  /** The objective verification evidence (verify.ts). */
  readonly verifyResult: VerifyResult;
  /** The static execution-grounded load evidence (preflight.ts): does the runnable
   * entry actually LOAD, or does opening it throw? Absent on the chat-fallback path or
   * for a pure-logic product. The CEO cannot approve a product that does not load. */
  readonly preflightResult?: PreflightResult;
  /** The advisory specialists' transcript-free FINDINGS summary (review.ts), when a
   * review-at-merge phase ran before the CEO (spec §8). Measured findings only. */
  readonly reviewFindings?: string;
}

/** Format the product manifest as the reviewer-facing block. */
function manifestLines(manifest: ProductManifest): string[] {
  const divisionNames =
    manifest.divisions.length > 0 ? manifest.divisions.map((d) => d.name).join(', ') : '(none)';
  const lines: string[] = [
    'FINISHED PRODUCT — MANIFEST:',
    `- Divisions (${manifest.divisions.length}): ${divisionNames}`,
    `- Files produced (${manifest.files.length}, ${manifest.totalBytes} bytes total):`,
  ];
  if (manifest.files.length === 0) lines.push('    (no files were produced)');
  else for (const f of manifest.files) lines.push(`    - ${f.slot} (${f.bytes} bytes)`);

  lines.push(`- Cross-division interfaces (${manifest.interfaces.length}):`);
  if (manifest.interfaces.length === 0) lines.push('    (none declared)');
  else
    for (const h of manifest.interfaces) {
      lines.push(`    - ${h.name} — exposed by ${h.exposedBy} at ${h.path}: ${h.summary}`);
    }

  const s = manifest.contractStatusSummary;
  lines.push(`- Contract outcomes: ${s.done} done, ${s.failed} failed, ${s.skipped} not completed`);
  return lines;
}

/** Format the static LOAD evidence (preflight.ts) as the reviewer-facing block —
 * "the entry actually loads" or the concrete load-breakers. Empty for a pure-logic
 * product (no browser entry to load). Pure. */
function preflightLines(preflight: PreflightResult | undefined): string[] {
  if (preflight === undefined || !preflight.applicable) return [];
  if (preflight.ok) {
    return [
      '',
      'OBJECTIVE LOAD EVIDENCE — PREFLIGHT:',
      `- Result: PASS — the runnable entry (${preflight.entry ?? 'index.html'}) loads; every import resolves to a browser-loadable target.`,
    ];
  }
  const lines = [
    '',
    'OBJECTIVE LOAD EVIDENCE — PREFLIGHT:',
    `- Result: FAIL — the runnable entry (${preflight.entry ?? 'index.html'}) DOES NOT LOAD. Opening it throws before anything runs. This is DISQUALIFYING: a product that does not load has not met the bar, however complete the manifest looks.`,
    `- Load-breakers (${preflight.defects.length}):`,
  ];
  for (const d of preflight.defects) lines.push(`    - [${d.kind}] ${d.importer}: ${d.message}`);
  return lines;
}

/** Format the verification evidence as the reviewer-facing block. */
function verifyLines(verify: VerifyResult): string[] {
  const lines: string[] = [
    'OBJECTIVE BUILD EVIDENCE — VERIFICATION PASS:',
    `- Result: ${verify.ok ? 'PASS' : 'FAIL'} (${verify.filesChecked} file(s) checked)`,
  ];
  if (verify.errors.length === 0) lines.push('- Errors: none — every checked file passed.');
  else {
    lines.push(`- Errors (${verify.errors.length}):`);
    for (const e of verify.errors) lines.push(`    - ${e.file}: ${e.message}`);
  }
  return lines;
}

/**
 * Build the CEO's final-review USER turn from the {@link CeoReviewInput}. Pairs
 * with {@link CEO_REVIEW_PROMPT}. The turn contains ONLY the original task, the
 * product manifest, and the verify evidence — never the build transcript (the type
 * cannot carry one). Pure string composition; deterministic.
 */
export function buildCeoReviewPrompt(input: CeoReviewInput): string {
  const findings = input.reviewFindings?.trim();
  return [
    'Review the finished product and give your sign-off.',
    '',
    'ORIGINAL TASK (the standard you set):',
    input.originalTask.trim(),
    '',
    ...manifestLines(input.manifest),
    '',
    ...verifyLines(input.verifyResult),
    ...preflightLines(input.preflightResult),
    ...(findings !== undefined && findings !== '' ? ['', findings] : []),
    '',
    'Does this finished product ACTUALLY BUILD AND RUN, and meet the standard the original task set? Use the tester/specialist findings, the verification evidence, and the load evidence above as ground truth — do not APPROVE a product that failed to build or run, whose entry does not load, has no runnable entry, or is missing the described feature. Begin your reply with APPROVE or REVISE on its own line; if REVISE, add specific notes addressed to the exact gap.',
  ].join('\n');
}

/** The two decisions the CEO can return. */
export type CeoDecisionKind = 'approve' | 'revise';

/** The parsed CEO verdict. `notes` carries the actionable feedback on `revise`
 * (and any trailing remark on `approve`); absent when there is nothing extra. */
export interface CeoDecision {
  readonly decision: CeoDecisionKind;
  readonly notes?: string;
}

const APPROVE_RE = /\b(?:approve|approved|approving|ship it|sign(?:ed)?[- ]?off|lgtm)\b/i;
const REVISE_RE =
  /\b(?:revise|revision|reject|rejected|send (?:it )?back|not (?:yet )?ready|needs? (?:more )?work|changes? needed)\b/i;

/** Trim a matched-token remainder into notes, dropping leading punctuation; returns
 * `undefined` when nothing meaningful is left. */
function remainderNotes(text: string, endIndex: number): string | undefined {
  const rest = text
    .slice(endIndex)
    .replace(/^[\s:.,;—–-]+/, '')
    .trim();
  return rest === '' ? undefined : rest;
}

/** Extract the first balanced `{…}` JSON object from `text` and parse it, or
 * `undefined`. String-aware brace scan (tolerant of surrounding prose). */
function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** First present string among `keys` of `obj` (trimmed; else `undefined`). */
function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function finalize(decision: CeoDecisionKind, notes: string | undefined): CeoDecision {
  return notes === undefined ? { decision } : { decision, notes };
}

/**
 * Parse a CEO reply into a {@link CeoDecision}. Tolerant of a structured JSON
 * verdict (`{ "decision": "revise", "notes": "…" }`) and of free prose (the
 * prompt asks for a leading APPROVE / REVISE, but the parser scans anywhere).
 *
 * Rules:
 *  - A structured `{ decision, notes }` object, when present and decisive, wins.
 *  - Otherwise the EARLIEST decisive keyword wins (approve vs. revise); the text
 *    after it becomes the notes.
 *  - When NEITHER keyword appears, the safe default is `revise` (never rubber-
 *    stamp on an unparseable reply — this is the false-completion cure), carrying
 *    the whole reply as notes. Never throws.
 */
export function parseCeoDecision(text: string): CeoDecision {
  if (typeof text !== 'string' || text.trim() === '') {
    return { decision: 'revise', notes: 'No decision was produced; defaulting to revise.' };
  }

  const json = firstJsonObject(text);
  if (json !== undefined && typeof json.decision === 'string') {
    const notes = firstString(json, ['notes', 'feedback', 'reason', 'comments']);
    if (APPROVE_RE.test(json.decision) && !REVISE_RE.test(json.decision)) {
      return finalize('approve', notes);
    }
    if (REVISE_RE.test(json.decision)) return finalize('revise', notes ?? text.trim());
  }

  const approve = APPROVE_RE.exec(text);
  const revise = REVISE_RE.exec(text);
  const aIdx = approve?.index ?? Number.POSITIVE_INFINITY;
  const rIdx = revise?.index ?? Number.POSITIVE_INFINITY;

  if (aIdx === Number.POSITIVE_INFINITY && rIdx === Number.POSITIVE_INFINITY) {
    // No decisive keyword — do not rubber-stamp; treat as revise.
    return { decision: 'revise', notes: text.trim() };
  }
  if (aIdx < rIdx && approve !== null) {
    return finalize('approve', remainderNotes(text, approve.index + approve[0].length));
  }
  const endIndex = revise !== null ? revise.index + revise[0].length : text.length;
  return finalize('revise', remainderNotes(text, endIndex) ?? text.trim());
}

/** The note attached when a CEO APPROVE is downgraded because the tester gate is
 * blocking (spec §8, generalized — the CEO cannot sign off a product that failed to
 * build/run). It routes DOWN as the revision feedback. */
export const TESTER_GATE_BLOCK_NOTE =
  "The tester's measured evidence shows this product does not actually build and run (a build/runtime/console error, or no runnable entry/build shell). A product that does not run cannot be approved, however complete the manifest looks — the specific build/run failures the reviewers measured must be fixed first.";

/**
 * GATE the CEO's verdict on the tester gate (spec §8, generalized — "the CEO's
 * APPROVE must be GATED on the tester gate passing; it cannot sign off a product
 * that failed to build/run"). When the tester gate did NOT pass, an APPROVE is
 * DOWNGRADED to REVISE (carrying {@link TESTER_GATE_BLOCK_NOTE} + any CEO notes) so
 * the work bounces back DOWN; a REVISE is returned unchanged, and when the gate
 * passed the CEO's verdict stands untouched. This never UP-grades a verdict — it
 * only ever holds back an approval of a product that does not run. Pure.
 */
export function applyTesterGate(decision: CeoDecision, testerGatePassed: boolean): CeoDecision {
  if (testerGatePassed || decision.decision !== 'approve') return decision;
  const existing = decision.notes?.trim();
  const notes =
    existing !== undefined && existing !== ''
      ? `${TESTER_GATE_BLOCK_NOTE}\n\n${existing}`
      : TESTER_GATE_BLOCK_NOTE;
  return { decision: 'revise', notes };
}
