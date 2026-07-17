/**
 * The REVIEW-AT-MERGE phase (spec §8) — advisory specialist reviewers that
 * MEASURE, running before the CEO sign-off.
 *
 * Spec §8: "Review runs at the merge step, as its own memory phase … reviews are
 * evidence-grounded — the reviewer MEASURES (runs tests, screenshots + measures
 * layout), never opines." The five advisory specialists (visual-critic / security
 * / performance / accessibility / correctness) live in the PROMPT_LIBRARY
 * (prompts.ts); this module is what INVOKES them, harnessed, over the assembled
 * product tree — between assemble/verify and the CEO final review.
 *
 * The shape mirrors the rest of corp: the PURE pieces (lens selection, the review
 * prompts, the `submit_findings` tool + tolerant parse, finding→contract mapping,
 * aggregation, and the CEO-facing findings summary) live here as deterministic,
 * fs-free helpers, and the control-flow ({@link runReviewPhase}) runs behind
 * INJECTED seams — one to run a reviewer as a real harnessed agent, one to perform
 * the bounded revision — so it is unit-testable with mocks and reused by both the
 * orchestrator ({@link ./run}) and the real-server validation driver.
 *
 * What the phase does (spec §8, bounded by construction):
 *  1. Pick the lenses appropriate to the product. CORRECTNESS/INTEGRATION always
 *     (it runs the build/typecheck/tests — the ground truth), plus SECURITY and
 *     PERFORMANCE (feasible on the code via bash). VISUAL-CRITIC + ACCESSIBILITY
 *     are added only when the product has renderable artifacts, and BEST-EFFORT:
 *     no headless browser is wired into the reviewer seam, so they run over the
 *     DOM/markup structure and are flagged `renderLimited` (they NOTE the limit
 *     rather than faking a rendered measurement).
 *  2. Run ONE review pass: each planned lens is spawned as a HARNESSED agent over
 *     the product tree (read + bash + grep/find/ls, read-only intent, thinking-ON,
 *     samplingMode 'thinking-general', NO per-agent cap) that MEASURES and returns
 *     findings ranked by severity via a `submit_findings` custom tool (falling back
 *     to its final text). Each reviewer charges the global RunBudget; a spent
 *     budget skips the rest gracefully.
 *  3. Aggregate the findings. A BLOCKING finding (a build/typecheck/test failure or
 *     a severe defect) triggers a BOUNDED revision — re-dispatch the affected
 *     contract(s) with the finding as the revision note, then re-assemble +
 *     re-verify — reusing the same revise bound (`maxRevisions`) so it can never
 *     deadlock. Non-blocking findings are recorded and surfaced to the CEO.
 *  4. The CEO then reviews the (possibly re-worked) product WITH the specialists'
 *     FINDINGS summary — transcript-free by shape: it is measured findings, never
 *     the build transcript (the false-completion cure is preserved).
 */

import type { ProductManifest } from './assemble.js';
import { budgetExceeded, type RunBudget } from './budget.js';
import type { CeoDecision } from './ceo.js';
import type { Contract } from './org-chart.js';
import { getRolePrompt, roleThinkingEnabled, type SpecialistKind } from './prompts.js';
import { runBoundedRevise } from './revise.js';
import type {
  RoleAgentCustomTool,
  RoleAgentRunInput,
  RoleAgentRunOutput,
  RoleAgentSeamToolCall,
} from './role-agent-seam.js';
import type { VerifyResult } from './verify.js';

// --- Findings model ----------------------------------------------------------

/** A review lens is one of the advisory-specialist kinds (prompts.ts §4). */
export type ReviewLens = SpecialistKind;

/**
 * Finding severity, most-severe first. `blocking` means the product does NOT meet
 * its bar as-is (the build/typecheck/tests fail, or a severe defect — a crash, a
 * security hole, data loss) and it triggers the bounded revision; the rest are
 * real-but-non-blocking issues surfaced to the CEO.
 */
export type ReviewSeverity = 'blocking' | 'high' | 'medium' | 'low';

const SEVERITIES: readonly ReviewSeverity[] = ['blocking', 'high', 'medium', 'low'];

/** One evidence-grounded finding from a reviewer: what is wrong, how severe, the
 * measured evidence, and the concrete location it points to. */
export interface ReviewFinding {
  /** Which lens raised it. */
  readonly lens: ReviewLens;
  /** How severe (drives the blocking → bounded-revision decision). */
  readonly severity: ReviewSeverity;
  /** One-line description of the finding. */
  readonly title: string;
  /** What the reviewer ran, saw, or measured (a command + its output, a value). */
  readonly evidence: string;
  /** The concrete location (file:line), when the reviewer cited one. */
  readonly location?: string;
}

/** A lens selected for the review pass + whether it can truly MEASURE the artifact
 * or is limited to a static structural review (no headless browser available). */
export interface ReviewLensPlan {
  readonly lens: ReviewLens;
  /** True when the lens needs a rendered artifact but none can be rendered here, so
   * it reviews the DOM/markup structure statically and NOTES the limitation. */
  readonly renderLimited: boolean;
}

/** What one lens's run produced (recorded for the result + telemetry). */
export interface LensRunSummary {
  readonly lens: ReviewLens;
  /** The reviewer agent actually ran (false = skipped because the budget was spent). */
  readonly ran: boolean;
  /** True when the lens measured the real artifact (false when it was render-limited
   * to a static structural review). */
  readonly measured: boolean;
  readonly renderLimited: boolean;
  /** The reviewer used `bash` (ran a build/test) — the evidence-grounded signal. */
  readonly usedBash: boolean;
  readonly findingCount: number;
  readonly blockingCount: number;
  /** Why the reviewer run ended, when the seam reported it. */
  readonly terminatedReason?: string;
}

/** The review phase's summary — recorded on the run result (spec §8). */
export interface ReviewPhaseSummary {
  /** Every lens planned for this product, with its measure/render-limited status. */
  readonly lensRuns: readonly LensRunSummary[];
  /** Every finding, across all lenses (post-revision aggregate). */
  readonly findings: readonly ReviewFinding[];
  readonly blockingCount: number;
  /** A blocking finding triggered the bounded revision. */
  readonly revisionTriggered: boolean;
  /** The contracts the revision re-dispatched (affected by the blocking findings). */
  readonly revisionContractIds: readonly string[];
  /** The bounded revision actually ran a re-dispatch cycle. */
  readonly revisionRan: boolean;
  /** The re-verify verdict after the revision (undefined when no revision ran). */
  readonly revisedVerifyOk?: boolean;
  /** The review pass was cut short because the global RunBudget was spent. */
  readonly skippedForBudget: boolean;
  /** The transcript-free FINDINGS summary handed to the CEO's final review. */
  readonly ceoFindingsSummary: string;
}

// --- Lens selection ----------------------------------------------------------

/** Slots whose files imply a renderable artifact (markup / component / stylesheet)
 * — the signal to add the visual-critic + accessibility lenses (render-limited). */
const RENDERABLE_FILE = /\.(?:html?|tsx|jsx|vue|svelte|css|scss|sass|less)$/i;

/** True when the assembled product contains a renderable artifact (markup, a UI
 * component, or a stylesheet) — the visual + accessibility lenses only earn their
 * place then. Pure. */
export function hasRenderableArtifacts(manifest: ProductManifest): boolean {
  return manifest.files.some((f) => RENDERABLE_FILE.test(f.slot));
}

/**
 * Pick the lenses appropriate to THIS product (spec §8 — "pick lenses appropriate
 * to the product"). Always CORRECTNESS/INTEGRATION (it runs the build/typecheck/
 * tests — the ground truth), plus SECURITY and PERFORMANCE (feasible on the code
 * via bash). VISUAL-CRITIC + ACCESSIBILITY are added ONLY when the product has a
 * renderable artifact, and flagged `renderLimited` (best-effort: no headless
 * browser is wired into the reviewer seam, so they review the DOM/markup structure
 * statically and note the limitation rather than fake a rendered measurement).
 * Deterministic + pure.
 */
export function selectReviewLenses(manifest: ProductManifest): ReviewLensPlan[] {
  const plans: ReviewLensPlan[] = [
    { lens: 'correctness', renderLimited: false },
    { lens: 'security', renderLimited: false },
    { lens: 'performance', renderLimited: false },
  ];
  if (hasRenderableArtifacts(manifest)) {
    plans.push(
      { lens: 'visual-critic', renderLimited: true },
      { lens: 'accessibility', renderLimited: true },
    );
  }
  return plans;
}

// --- The reviewer's system + user prompts ------------------------------------

/** Lenses whose findings benefit from a web lookup (WCAG criteria, CVEs) — they get
 * `web_search` in their allowlist when the app wired the web-research tools. */
const WEB_LENSES: ReadonlySet<ReviewLens> = new Set(['security', 'accessibility', 'visual-critic']);

/** The reviewer's built-in tool allowlist: read + the measurement tools, read-only
 * (no write/edit — reviewers MEASURE, they don't fix; §8/§12-Q11). `submit_findings`
 * must also be listed or the SDK allowlist hides the custom tool. */
export function reviewToolAllowlist(lens: ReviewLens): string[] {
  const base = ['read', 'bash', 'grep', 'find', 'ls', SUBMIT_FINDINGS_TOOL];
  return WEB_LENSES.has(lens) ? [...base, 'web_search'] : base;
}

/**
 * The reviewer's system prompt: the lens's library base (prompts.ts) + the
 * review-at-merge framing that turns it into a MEASUREMENT pass (run the build/
 * tests, cite evidence, do not edit, submit findings). A `renderLimited` lens also
 * gets the explicit render-limitation note (review the markup statically, never
 * fabricate a rendered measurement). Pure string composition.
 */
export function buildReviewSystemPrompt(plan: ReviewLensPlan): string {
  const base = getRolePrompt(plan.lens).prompt;
  const framing = [
    '',
    'You are running as a REVIEWER at the MERGE step, over the assembled product in your working directory. This is a MEASUREMENT pass, not an implementation pass:',
    '- MEASURE the real product. Run the build, the typecheck, and the tests with the `bash` tool; inspect the code with read/grep/find/ls. Every finding must cite what you actually ran, saw, or measured (a command and its output, a file and a line) — never an impression.',
    '- You do NOT edit, fix, or write anything — you only report what you measured.',
    '- When you are done measuring, call `submit_findings` EXACTLY ONCE with your findings ranked by severity, each with its evidence and concrete file:line location. If you measured no problems, call it with an empty list.',
    "- Severity: mark a finding 'blocking' when it means the product does NOT meet its bar as-is — the build/typecheck/tests fail, or a severe defect (a crash, a security hole, data loss). Use 'high'/'medium'/'low' for real but non-blocking issues.",
  ];
  if (plan.renderLimited) {
    framing.push(
      '- RENDER LIMITATION: no headless browser is available to you in this pass, so you CANNOT render or screenshot the artifact. Do NOT fabricate pixel measurements or contrast ratios you did not compute. Instead review the DOM/markup and stylesheet STRUCTURE statically (semantic elements, roles/labels, focus handling, declared color/spacing tokens), and state in each finding that it is a STATIC STRUCTURAL review, not a rendered measurement.',
    );
  }
  return `${base}\n${framing.join('\n')}`;
}

/** Format the product manifest as the reviewer-facing block (the files to measure). */
function manifestBlock(manifest: ProductManifest): string[] {
  const lines = [`PRODUCT — ${manifest.files.length} file(s) produced:`];
  if (manifest.files.length === 0) lines.push('  (no files were produced)');
  else for (const f of manifest.files) lines.push(`  - ${f.slot} (${f.bytes} bytes)`);
  return lines;
}

/**
 * The reviewer's USER turn: the standard (the original task + the vision brief), the
 * product manifest (the files to measure), the objective verify evidence so far, and
 * the instruction to MEASURE through this lens and submit findings. Pure.
 */
export function buildReviewUserPrompt(input: {
  readonly plan: ReviewLensPlan;
  readonly task: string;
  readonly visionBrief: string;
  readonly manifest: ProductManifest;
  readonly verifyResult: VerifyResult;
}): string {
  const { plan, task, visionBrief, manifest, verifyResult } = input;
  const lines: string[] = [
    `Review the assembled product through your ${plan.lens} lens, at the merge step.`,
    '',
    'THE STANDARD (what this product is meant to be):',
    task.trim(),
  ];
  if (visionBrief.trim() !== '') {
    lines.push('', 'VISION BRIEF (the standard the build was held to):', visionBrief.trim());
  }
  lines.push(
    '',
    ...manifestBlock(manifest),
    '',
    `OBJECTIVE VERIFY (structural pre-check): ${verifyResult.ok ? 'PASS' : 'FAIL'} (${verifyResult.filesChecked} file(s) checked)`,
  );
  if (verifyResult.errors.length > 0) {
    for (const e of verifyResult.errors) lines.push(`  - ${e.file}: ${e.message}`);
  }
  lines.push(
    '',
    'MEASURE the product now: run the build/typecheck/tests you need with `bash`, read the relevant files, and gather concrete evidence. Then call `submit_findings` once with your findings ranked by severity — each citing the evidence and the file:line. Do not edit anything; report only.',
  );
  return lines.join('\n');
}

// --- The submit_findings tool + tolerant parse -------------------------------

/** The reviewer's structured-output tool name (a custom tool; must also be in the
 * `tools` allowlist or the SDK gate hides it). */
export const SUBMIT_FINDINGS_TOOL = 'submit_findings';

/**
 * The reviewer's `submit_findings` tool — the structured way it returns its measured
 * findings. Calling it IS the terminal signal (a no-op ack, `terminal`), and the
 * findings are parsed off the recorded tool-call arguments ({@link parseFindings}),
 * falling back to the final text. Pure + deterministic.
 */
export function buildSubmitFindingsTool(): RoleAgentCustomTool {
  return {
    name: SUBMIT_FINDINGS_TOOL,
    description:
      'Report your measured findings and finish. Call this ONCE with findings ranked by severity; pass an empty list if you measured no problems.',
    parameters: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          description: 'The findings you measured, most severe first.',
          items: {
            type: 'object',
            properties: {
              severity: {
                type: 'string',
                enum: [...SEVERITIES],
                description:
                  "'blocking' if the product does not meet its bar as-is (build/tests fail, or a severe defect); else high/medium/low.",
              },
              title: { type: 'string', description: 'One line: what is wrong.' },
              evidence: {
                type: 'string',
                description:
                  'What you ran/saw/measured — the command and its output, or the value.',
              },
              location: {
                type: 'string',
                description: 'The concrete file:line the finding points to.',
              },
            },
            required: ['severity', 'title', 'evidence'],
          },
        },
      },
      required: ['findings'],
    },
    terminal: true,
  };
}

/** Coerce an unknown value to a trimmed string, or `undefined`. */
function asString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  return undefined;
}

/** Normalize a free-form severity token to a {@link ReviewSeverity}. Tolerant of the
 * synonyms a model reaches for (`critical`/`fatal` → blocking, `major` → high, …);
 * an unknown token defaults to `medium` (a real-but-unranked finding). */
export function normalizeSeverity(raw: unknown): ReviewSeverity {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (/\b(block|blocker|blocking|critical|fatal|severe)\b/.test(s)) return 'blocking';
  if (/\b(high|major)\b/.test(s)) return 'high';
  if (/\b(low|minor|info|nit|trivial)\b/.test(s)) return 'low';
  if (/\b(medium|moderate|med)\b/.test(s)) return 'medium';
  return 'medium';
}

/** Extract the first balanced `{…}` JSON object from a string (string-aware scan). */
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

/** Decode a tool call's arguments to an object (a decoded object, or a JSON string). */
function decodeArgs(args: RoleAgentSeamToolCall['arguments']): Record<string, unknown> | undefined {
  return typeof args === 'string' ? firstJsonObject(args) : args;
}

/** Turn one raw finding object into a {@link ReviewFinding}, or `undefined` when it
 * carries no usable content (no title AND no evidence). */
function toFinding(lens: ReviewLens, raw: unknown): ReviewFinding | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const title = asString(o.title) ?? asString(o.finding) ?? asString(o.issue);
  const evidence = asString(o.evidence) ?? asString(o.detail) ?? asString(o.description);
  if (title === undefined && evidence === undefined) return undefined;
  const location = asString(o.location) ?? asString(o.file) ?? asString(o.path);
  return {
    lens,
    severity: normalizeSeverity(o.severity),
    title: title ?? (evidence ?? '').slice(0, 120),
    evidence: evidence ?? title ?? '',
    ...(location !== undefined ? { location } : {}),
  };
}

const FAILURE_RE =
  /\b(fail(?:s|ed|ing|ure)?|error|errors|crash(?:es|ed)?|throw(?:s|n)?|broken|does not (?:build|compile|run)|cannot (?:build|compile|run)|not a function|undefined|reference ?error|type ?error|syntax ?error|unbalanced|truncat)\b/i;

/**
 * Parse a reviewer's measured findings from its recorded {@link submit_findings}
 * call (the structured path) or, failing that, its final text (the fallback):
 *  - A `submit_findings` tool call → its `findings` array, each normalized.
 *  - No structured findings but a non-empty final text → ONE synthesized finding
 *    carrying the text as evidence; its severity is `blocking` for the correctness
 *    lens when the text reads like a build/run failure, else `low` (an observation).
 * Never throws; returns `[]` when there is nothing usable.
 */
export function parseFindings(
  lens: ReviewLens,
  toolCalls: readonly RoleAgentSeamToolCall[],
  finalText: string,
): ReviewFinding[] {
  for (const call of toolCalls) {
    if (call.name !== SUBMIT_FINDINGS_TOOL) continue;
    const args = decodeArgs(call.arguments);
    const list = args?.findings;
    if (Array.isArray(list)) {
      const findings = list
        .map((f) => toFinding(lens, f))
        .filter((f): f is ReviewFinding => f !== undefined);
      // A submit_findings call is authoritative even when empty (measured nothing).
      return findings;
    }
  }
  const text = typeof finalText === 'string' ? finalText.trim() : '';
  if (text === '') return [];
  const looksLikeFailure = FAILURE_RE.test(text);
  return [
    {
      lens,
      severity: lens === 'correctness' && looksLikeFailure ? 'blocking' : 'low',
      title: text.split('\n')[0]?.slice(0, 120) ?? 'reviewer note',
      evidence: text.slice(0, 600),
    },
  ];
}

/** True when a finding blocks the merge (spec §8 — a build/test failure or a severe
 * defect). Lenient for the correctness lens: a `high` correctness finding whose
 * evidence reads like a real build/run failure also blocks, so a reviewer that
 * under-labels a genuine failure still triggers the revision. */
export function isBlocking(finding: ReviewFinding): boolean {
  if (finding.severity === 'blocking') return true;
  return (
    finding.lens === 'correctness' &&
    finding.severity === 'high' &&
    FAILURE_RE.test(`${finding.title} ${finding.evidence}`)
  );
}

// --- Aggregation + mapping ---------------------------------------------------

/** The basename of a slot/path (`src/a/b.ts` → `b.ts`), for tolerant matching. */
function basename(p: string): string {
  const parts = p.split(/[/\\]+/);
  return parts[parts.length - 1] ?? p;
}

/** True when a finding's location/evidence references a contract's slot (by the
 * slot path or its basename — tolerant of absolute paths and `file:line` suffixes). */
function findingReferencesSlot(finding: ReviewFinding, slot: string): boolean {
  const hay = `${finding.location ?? ''} ${finding.evidence} ${finding.title}`;
  if (hay.includes(slot)) return true;
  const base = basename(slot);
  // Require a non-trivial basename to avoid matching a bare "index"/short token.
  return base.length >= 4 && hay.includes(base);
}

/**
 * Map blocking findings to the contract(s) they point at, by matching each finding's
 * cited location/evidence against every contract's slot (path or basename). Returns
 * the distinct owner contract ids to re-dispatch. Pure + deterministic.
 */
export function mapFindingsToContractIds(
  findings: readonly ReviewFinding[],
  contracts: readonly Contract[],
): string[] {
  const ids = new Set<string>();
  for (const finding of findings) {
    for (const c of contracts) {
      if (findingReferencesSlot(finding, c.slot)) ids.add(c.id);
    }
  }
  return [...ids];
}

/**
 * Synthesize BLOCKING correctness findings from the objective verify errors
 * (verify.ts) — the model-free ground truth. When the structural verify pass reports
 * a concrete file error (an empty/truncated/malformed produced file), that is a
 * build-level failure regardless of how the specialists labeled it, so the review
 * phase always has an objective blocking signal to act on. Pure.
 */
export function deriveBlockingFromVerify(
  verifyResult: VerifyResult,
  contracts: readonly Contract[],
): ReviewFinding[] {
  return verifyResult.errors.map((e) => {
    const owner = contracts.find(
      (c) => e.file.includes(c.slot) || e.file.endsWith(basename(c.slot)),
    );
    return {
      lens: 'correctness' as const,
      severity: 'blocking' as const,
      title: `Objective verify failure: ${e.message}`,
      evidence: `The structural verify pass failed on ${e.file}: ${e.message}`,
      location: owner?.slot ?? e.file,
    };
  });
}

/** Merge two finding lists, dropping exact duplicates (same lens+title+location). */
function dedupeFindings(a: readonly ReviewFinding[], b: readonly ReviewFinding[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const seen = new Set<string>();
  for (const f of [...a, ...b]) {
    const key = `${f.lens}|${f.severity}|${f.title}|${f.location ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Sort findings most-severe first, stable within a severity. */
export function sortBySeverity(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const rank = (s: ReviewSeverity): number => SEVERITIES.indexOf(s);
  return [...findings].sort((x, y) => rank(x.severity) - rank(y.severity));
}

/** One-line-per-finding excerpt for a prompt/summary (evidence capped). */
function findingLine(f: ReviewFinding): string {
  const loc = f.location !== undefined ? ` — ${f.location}` : '';
  const ev = f.evidence.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `  - [${f.lens}/${f.severity}] ${f.title}${loc}${ev !== '' ? ` — evidence: ${ev}` : ''}`;
}

/**
 * Build the transcript-free SPECIALIST FINDINGS summary handed to the CEO's final
 * review (spec §8 — the CEO judges the product WITH the reviewers' measured
 * evidence, never the build transcript). Findings only (measurements), ranked by
 * severity, plus a one-line note on the bounded-revision outcome. Pure.
 */
export function buildFindingsSummary(input: {
  readonly findings: readonly ReviewFinding[];
  readonly revisionTriggered: boolean;
  readonly revisedVerifyOk?: boolean;
}): string {
  const findings = sortBySeverity(input.findings);
  const revisionNote = input.revisionTriggered
    ? input.revisedVerifyOk === true
      ? 'A blocking finding triggered a bounded revision; the product below reflects the re-worked result, and the objective verify now passes.'
      : 'A blocking finding triggered a bounded revision; the product below reflects the re-worked result.'
    : undefined;
  if (findings.length === 0) {
    const head = 'SPECIALIST REVIEW (advisory reviewers measured the product before you):';
    // Even with no residual findings, a revision that ran must be reported honestly.
    return revisionNote !== undefined
      ? `${head}\n  ${revisionNote}`
      : `${head}\n  The reviewers measured the product and reported no findings.`;
  }
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  const lines = [
    'SPECIALIST REVIEW FINDINGS (advisory reviewers measured the product before you — these are measurements, not opinions):',
    ...findings.map(findingLine),
    `(${findings.length} finding(s); ${blocking} blocking.)`,
  ];
  if (revisionNote !== undefined) lines.push(revisionNote);
  return lines.join('\n');
}

// --- The review phase orchestration (seam-injected, bounded) -----------------

/** Run ONE reviewer as a harnessed agent. Returns the recorded output, or
 * `undefined` when the global budget is spent (skip the rest gracefully). */
export type RunReviewAgentFn = (
  input: RoleAgentRunInput,
) => Promise<RoleAgentRunOutput | undefined>;

/** Perform ONE bounded revision cycle: re-dispatch the affected contracts with the
 * notes, re-assemble + re-verify, and return the fresh objective verdict. Returns
 * `undefined` when it could not run (budget spent, or no targetable contracts). */
export type ReviseForFindingsFn = (input: {
  readonly contractIds: readonly string[];
  readonly notes: string;
}) => Promise<{ readonly ran: boolean; readonly verify: VerifyResult } | undefined>;

/** Inputs to {@link runReviewPhase}. */
export interface ReviewPhaseParams {
  readonly lensPlan: readonly ReviewLensPlan[];
  readonly task: string;
  readonly visionBrief: string;
  readonly manifest: ProductManifest;
  readonly verifyResult: VerifyResult;
  readonly contracts: readonly Contract[];
  /** The product tree the reviewers run over (read-only intent). */
  readonly workspace: string;
  /** The judgment-turn token cap for a reviewer (findings are concise). */
  readonly maxTokens: number;
  /** Run ONE reviewer, charged against the global budget (undefined = budget spent). */
  readonly runReviewAgent: RunReviewAgentFn;
  /** The bounded revision seam (re-dispatch + re-verify). Absent → findings are
   * recorded but no revision runs (still surfaced to the CEO). */
  readonly reviseForFindings?: ReviseForFindingsFn;
  /** Reuse the CEO revise bound for the review-triggered revision (default 1). */
  readonly maxRevisions?: number;
  /** The global backstop: when spent, no further reviewer/revision runs. */
  readonly budget?: RunBudget;
  readonly log?: (message: string) => void;
}

/** Build the {@link RoleAgentRunInput} for one reviewer (spec §8 — harnessed,
 * read-only, thinking-ON, samplingMode 'thinking-general', NO per-agent cap). Pure. */
export function buildReviewAgentInput(
  plan: ReviewLensPlan,
  params: Pick<
    ReviewPhaseParams,
    'task' | 'visionBrief' | 'manifest' | 'verifyResult' | 'workspace' | 'maxTokens'
  >,
): RoleAgentRunInput {
  return {
    purpose: 'review',
    systemPrompt: buildReviewSystemPrompt(plan),
    userPrompt: buildReviewUserPrompt({
      plan,
      task: params.task,
      visionBrief: params.visionBrief,
      manifest: params.manifest,
      verifyResult: params.verifyResult,
    }),
    tools: reviewToolAllowlist(plan.lens),
    customTools: [buildSubmitFindingsTool()],
    cwd: params.workspace,
    thinking: roleThinkingEnabled(plan.lens),
    samplingMode: 'thinking-general',
    maxTokens: params.maxTokens,
    // NO isolation (reviews the whole product tree, read-only), NO bump, NO per-agent
    // cap — the reviewer runs until it submits / the global RunBudget stops the run.
  };
}

/**
 * Run the REVIEW-AT-MERGE phase (spec §8): spawn each planned lens as a harnessed
 * reviewer that MEASURES the product, aggregate the findings, and — when a blocking
 * finding is present — run ONE bounded revision (re-dispatch the affected contracts
 * + re-verify, reusing the revise bound). Returns the {@link ReviewPhaseSummary},
 * including the transcript-free findings summary for the CEO. Never throws.
 *
 * Bounded by construction: one review pass (each lens runs once), each reviewer
 * charges the global budget (a spent budget skips the rest), and the revision reuses
 * `maxRevisions` so it can never deadlock. No per-agent caps.
 */
export async function runReviewPhase(params: ReviewPhaseParams): Promise<ReviewPhaseSummary> {
  const log = params.log ?? (() => {});
  const lensRuns: LensRunSummary[] = [];
  let collected: ReviewFinding[] = [];
  let skippedForBudget = false;

  // 1. ONE review pass — each lens runs once, serially (its own memory phase, §8).
  for (const plan of params.lensPlan) {
    if (params.budget !== undefined && budgetExceeded(params.budget)) {
      skippedForBudget = true;
    }
    if (skippedForBudget) {
      lensRuns.push({
        lens: plan.lens,
        ran: false,
        measured: false,
        renderLimited: plan.renderLimited,
        usedBash: false,
        findingCount: 0,
        blockingCount: 0,
      });
      continue;
    }
    log(`review lens: ${plan.lens}${plan.renderLimited ? ' (render-limited)' : ''}`);
    const input = buildReviewAgentInput(plan, params);
    const out = await params.runReviewAgent(input);
    if (out === undefined) {
      // Budget spent at charge time — record as skipped and stop starting new lenses.
      skippedForBudget = true;
      lensRuns.push({
        lens: plan.lens,
        ran: false,
        measured: false,
        renderLimited: plan.renderLimited,
        usedBash: false,
        findingCount: 0,
        blockingCount: 0,
      });
      continue;
    }
    const findings = parseFindings(plan.lens, out.toolCalls, out.finalText);
    const usedBash = out.toolCalls.some((c) => c.name === 'bash');
    collected = [...collected, ...findings];
    lensRuns.push({
      lens: plan.lens,
      ran: true,
      measured: !plan.renderLimited,
      renderLimited: plan.renderLimited,
      usedBash,
      findingCount: findings.length,
      blockingCount: findings.filter(isBlocking).length,
      ...(out.terminatedReason !== undefined ? { terminatedReason: out.terminatedReason } : {}),
    });
  }

  // 2. Aggregate — the specialists' findings PLUS the objective verify failures (the
  // model-free ground truth), deduped and ranked most-severe first.
  const objective = deriveBlockingFromVerify(params.verifyResult, params.contracts);
  let findings = sortBySeverity(dedupeFindings(collected, objective));
  const blocking = findings.filter(isBlocking);

  // 3. BLOCKING → ONE bounded revision (re-dispatch the affected contracts + re-verify),
  // reusing the revise bound. Never deadlocks; each cycle is budget-charged by the seam.
  let revisionTriggered = false;
  let revisionRan = false;
  let revisedVerifyOk: boolean | undefined;
  let revisionContractIds: string[] = [];

  if (
    blocking.length > 0 &&
    params.reviseForFindings !== undefined &&
    !(params.budget !== undefined && budgetExceeded(params.budget))
  ) {
    revisionContractIds = mapFindingsToContractIds(blocking, params.contracts);
    if (revisionContractIds.length > 0) {
      revisionTriggered = true;
      const notes = [
        'The advisory reviewers found BLOCKING problems the product must fix:',
        ...blocking.map(findingLine),
        '',
        'Re-build the affected file(s) to resolve these specific findings.',
      ].join('\n');
      log(
        `review: ${blocking.length} blocking finding(s) → bounded revision of [${revisionContractIds.join(', ')}]`,
      );
      const revise = params.reviseForFindings;
      // runBoundedRevise caps the re-dispatch at `maxRevisions` (the same bound the
      // CEO revise loop uses) and re-checks via the OBJECTIVE re-verify each cycle —
      // it can never deadlock. Its side-effects (revisionRan/revisedVerifyOk) are
      // captured in the closure below; the returned outcome is not needed here.
      await runBoundedRevise({
        initialDecision: { decision: 'revise', notes } as CeoDecision,
        maxRevisions: params.maxRevisions,
        ...(params.budget !== undefined ? { budget: params.budget } : {}),
        runRevision: async (): Promise<CeoDecision> => {
          const result = await revise({ contractIds: revisionContractIds, notes });
          if (result === undefined || !result.ran) {
            // Could not re-dispatch (budget/none) — accept the honest state.
            return { decision: 'approve' };
          }
          revisionRan = true;
          revisedVerifyOk = result.verify.ok;
          // Re-check signal is the OBJECTIVE re-verify (not a second specialist pass —
          // one review pass): pass → done; still failing → let the bound decide.
          return result.verify.ok
            ? { decision: 'approve' }
            : {
                decision: 'revise',
                notes: `${notes}\n\nThe re-verify still reports errors:\n${result.verify.errors
                  .map((e) => `  - ${e.file}: ${e.message}`)
                  .join('\n')}`,
              };
        },
      });
      // If the revision fixed the objective failures, drop the now-stale verify-derived
      // blocking findings from what the CEO sees (the specialists' own findings stay).
      if (revisedVerifyOk === true) {
        findings = sortBySeverity(dedupeFindings(collected, []));
      }
    }
  }

  const ceoFindingsSummary = buildFindingsSummary({
    findings,
    revisionTriggered,
    ...(revisedVerifyOk !== undefined ? { revisedVerifyOk } : {}),
  });

  return {
    lensRuns,
    findings,
    blockingCount: findings.filter(isBlocking).length,
    revisionTriggered,
    revisionContractIds,
    revisionRan,
    ...(revisedVerifyOk !== undefined ? { revisedVerifyOk } : {}),
    skippedForBudget,
    ceoFindingsSummary,
  };
}
