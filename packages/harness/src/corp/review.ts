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
  /** How many DOWN-and-UP bounce rounds the bounded revision ran (0..maxRevisions) —
   * the generalized §8 bounce (re-dispatch → re-verify), bounded, never a deadlock. */
  readonly revisionRounds: number;
  /** The re-verify verdict after the revision (undefined when no revision ran). */
  readonly revisedVerifyOk?: boolean;
  /** The whole-codebase `auditor` was dispatched as the escape hatch (a blocking
   * finding whose source did not map to any contract — spec §8/§9 generalized). */
  readonly auditorDispatched: boolean;
  /** A synthesized INTEGRATION contract was dispatched to PRODUCE the missing
   * runnable entry (Part C recovery — the review bounce built the entry no existing
   * contract owned, rather than flagging it forever). */
  readonly integrationEntryDispatched: boolean;
  /** The integration dispatch actually produced a runnable entry — the re-assembled
   * manifest now HAS one, so the "no runnable entry" gate cleared. */
  readonly integrationEntryRecovered: boolean;
  /**
   * The TESTER GATE verdict (spec §8, generalized) — did the product end the review
   * phase actually building/running, with no remaining blocking build/run failure?
   * The CEO's APPROVE is GATED on this in the orchestrator: it cannot sign off a
   * product that failed to build/run. True when there were no blocking findings, or
   * the bounded bounce cleared the objective re-verify AND there is a runnable entry.
   */
  readonly testerGatePassed: boolean;
  /** The product is a renderable artifact with no runnable entry/build shell (spec
   * §8 — "no home"), AS OF THE END OF THE PHASE. A missing entry maps to no existing
   * contract, so re-dispatching one cannot clear it — but the Part C integration
   * recovery ({@link DispatchIntegrationContractFn}) can PRODUCE it; when it does,
   * this is recomputed to `false` against the re-assembled manifest and the gate
   * clears. It stays `true` only when no recovery seam is wired or the entry could
   * not be produced. */
  readonly runnableEntryMissing: boolean;
  /** The review pass was cut short because the global RunBudget was spent. */
  readonly skippedForBudget: boolean;
  /** The transcript-free FINDINGS summary handed to the CEO's final review. */
  readonly ceoFindingsSummary: string;
}

// --- Lens selection ----------------------------------------------------------

/** Slots whose files imply a renderable artifact (markup / component / stylesheet)
 * — the signal to add the visual-critic + accessibility lenses (render-limited). */
const RENDERABLE_FILE = /\.(?:html?|tsx|jsx|vue|svelte|css|scss|sass|less)$/i;

/** Files that constitute a runnable ENTRY / build shell — how the tester assembles,
 * builds, and launches the product. A renderable product with NONE of these has "no
 * home": nothing to build or serve, so it is not shippable (spec §8 tester gate). */
const RUNNABLE_ENTRY_FILE =
  /(?:^|\/)(?:package\.json|index\.html?|main\.[cm]?[jt]sx?|(?:vite|esbuild|webpack|rollup|next|astro|svelte|parcel)\.config\.[cm]?[jt]s)$/i;

/** True when a slot is a renderable artifact (markup, a UI component, or a
 * stylesheet). The atom under {@link hasRenderableArtifacts}; also reused by the
 * integration-contract synthesis (integration-contract.ts) to detect a web product
 * from its contract slots. Pure. */
export function isRenderableSlot(slot: string): boolean {
  return RENDERABLE_FILE.test(slot);
}

/** True when a slot is a runnable ENTRY / build shell (an index.html, a
 * package.json, a main entry, or a bundler config) — how the tester assembles,
 * builds, and launches the product. The atom under {@link hasRunnableEntry}; reused
 * by the integration-contract synthesis to decide whether an entry already exists.
 * Pure. */
export function isRunnableEntrySlot(slot: string): boolean {
  return RUNNABLE_ENTRY_FILE.test(slot);
}

/** True when the assembled product contains a renderable artifact (markup, a UI
 * component, or a stylesheet) — the visual + accessibility lenses only earn their
 * place then. Pure. */
export function hasRenderableArtifacts(manifest: ProductManifest): boolean {
  return manifest.files.some((f) => isRenderableSlot(f.slot));
}

/** True when the product has a runnable entry / build shell the tester can build and
 * launch (an index.html, a package.json, a main entry, or a bundler config). Pure. */
export function hasRunnableEntry(manifest: ProductManifest): boolean {
  return manifest.files.some((f) => isRunnableEntrySlot(f.slot));
}

/**
 * Pick the lenses appropriate to THIS product (spec §8 — "pick lenses appropriate
 * to the product", specialists that MEASURE). Always CORRECTNESS/INTEGRATION (types
 * + tests), the TESTER (the workability lens — it assembles, BUILDS, RUNS headless,
 * and SCREENSHOTS the product, the ground truth for "does it actually work"), plus
 * SECURITY and PERFORMANCE (feasible on the code via bash). VISUAL-CRITIC +
 * ACCESSIBILITY are added ONLY when the product has a renderable artifact; they are
 * flagged `renderLimited` HERE, but the review phase flips that OFF and lets them
 * consume the tester's real screenshot when the tester managed to build + run the
 * product (only when a build genuinely can't be produced do they fall back to the
 * static structural review). Deterministic + pure. The `auditor` is NOT a standing
 * lens — it is dispatched ON DEMAND by {@link runReviewPhase} as the escape hatch
 * when a blocking finding's source is unknown.
 */
export function selectReviewLenses(manifest: ProductManifest): ReviewLensPlan[] {
  const plans: ReviewLensPlan[] = [
    { lens: 'correctness', renderLimited: false },
    { lens: 'tester', renderLimited: false },
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
  if (plan.lens === 'tester') {
    framing.push(
      '- BUILD + RUN + SCREENSHOT (this is your whole job — do not stop at reading files): assemble the product, BUILD it with its real toolchain via `bash` (npm/pnpm build, vite/esbuild, or tsc), then RUN it — for a web artifact, launch it headless, load its entry, and read the console. Then SCREENSHOT it and confirm the feature the task describes actually appears and works.',
      '- A missing runnable entry (no index.html / package.json / bundler config to build+serve a web artifact), a build failure, a runtime or console error, or a described feature that does not actually appear is a BLOCKING finding — a product that does not run has not met its bar.',
    );
  }
  if (plan.lens === 'auditor') {
    framing.push(
      '- You may read the ENTIRE product tree (you are not scoped to one module). Trace the reported symptom to its cross-module ROOT CAUSE and report the precise fix as a finding a manager can turn into a contract — which file(s) are wrong, the single correct shape, and which module must change to agree. Cite the exact files/lines you compared.',
    );
  }
  if (plan.renderLimited) {
    framing.push(
      '- RENDER LIMITATION: no headless browser is available to you in this pass, so you CANNOT render or screenshot the artifact. Do NOT fabricate pixel measurements or contrast ratios you did not compute. Instead review the DOM/markup and stylesheet STRUCTURE statically (semantic elements, roles/labels, focus handling, declared color/spacing tokens), and state in each finding that it is a STATIC STRUCTURAL review, not a rendered measurement.',
    );
  } else if (plan.lens === 'visual-critic' || plan.lens === 'accessibility') {
    framing.push(
      '- The tester already BUILT and RAN this product and saved a screenshot of the running artifact in your working directory. Read/inspect that screenshot (and the built output) and measure the REAL rendered result — do not restrict yourself to a static markup review when a rendered artifact exists.',
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

/**
 * The tester gate's MODEL-FREE ground truth (spec §8 — "if none exists, that's a
 * BLOCKING finding — the product isn't shippable"). A RENDERABLE product (a web/UI
 * artifact) with NO runnable entry/build shell cannot be assembled, launched, or
 * screenshotted — the classic "food with no home": working modules that never
 * compose into a runnable product. That is a BLOCKING tester finding regardless of
 * what any lens agent reported, and — unlike a build error in an existing file — it
 * CANNOT be cleared by re-dispatching an existing contract (the missing shell is a
 * whole new deliverable), so the review phase carries it as a hard gate failure.
 * A pure-logic product (no renderable artifact) needs no web entry, so this is
 * empty for it. Pure.
 */
export function deriveTesterGateBlocking(manifest: ProductManifest): ReviewFinding[] {
  if (!hasRenderableArtifacts(manifest) || hasRunnableEntry(manifest)) return [];
  return [
    {
      lens: 'tester',
      severity: 'blocking',
      title: 'No runnable entry — the product cannot be built, launched, or screenshotted',
      evidence:
        'The product has renderable artifacts but no build/serve entry (no index.html, package.json, or bundler config), so the tester cannot assemble and run it. A web artifact with no home is not shippable.',
    },
  ];
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

/**
 * CREATE + dispatch a NEW synthesized INTEGRATION contract — the runnable product
 * entry that wires the modules into a running product — then RE-ASSEMBLE + re-verify
 * (spec §5/§8, Part C recovery). This is what lets the review bounce PRODUCE the
 * missing entry the tester gate flags, instead of only flagging it forever: the
 * missing entry is a NEW deliverable no existing contract owns, so re-running an
 * existing contract can never conjure it. The seam owns the actual synthesis +
 * dispatch (run.ts, mirroring {@link ReviseForFindingsFn}); it returns the fresh
 * manifest so {@link runReviewPhase} can recompute the model-free tester gate against
 * the RE-ASSEMBLED product. Returns `undefined` when it could not run (budget spent).
 */
export type DispatchIntegrationContractFn = (input: {
  readonly reason: string;
  readonly notes: string;
}) => Promise<
  | { readonly ran: boolean; readonly manifest: ProductManifest; readonly verify: VerifyResult }
  | undefined
>;

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
  /** The integration-entry RECOVERY seam (Part C): synthesize + dispatch a new
   * integration contract that PRODUCES the runnable entry, then re-assemble. Absent →
   * a "no runnable entry" gate failure is flagged but not repaired (the pre-fix
   * behavior — it can never clear). */
  readonly dispatchIntegrationContract?: DispatchIntegrationContractFn;
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

/** Record one lens's run in {@link LensRunSummary} shape (a skipped lens = ran:false). */
function lensRun(
  lens: ReviewLens,
  over: Partial<Omit<LensRunSummary, 'lens'>> = {},
): LensRunSummary {
  return {
    lens,
    ran: over.ran ?? false,
    measured: over.measured ?? false,
    renderLimited: over.renderLimited ?? false,
    usedBash: over.usedBash ?? false,
    findingCount: over.findingCount ?? 0,
    blockingCount: over.blockingCount ?? 0,
    ...(over.terminatedReason !== undefined ? { terminatedReason: over.terminatedReason } : {}),
  };
}

/** The bounce-note the review phase hands DOWN when it re-dispatches a contract to
 * fix blocking findings (plus the auditor's root-cause notes when it ran). */
function buildBounceNotes(blocking: readonly ReviewFinding[], auditorNotes: string): string {
  const lines = [
    'The reviewers MEASURED BLOCKING problems the product must fix before it can ship:',
    ...blocking.map(findingLine),
  ];
  if (auditorNotes.trim() !== '') {
    lines.push(
      '',
      'The whole-codebase auditor traced the root cause(s) — fix these at the source:',
      auditorNotes.trim(),
    );
  }
  lines.push('', 'Re-build the affected file(s) to resolve these specific findings.');
  return lines.join('\n');
}

/** The bounce-note handed to the Part C integration RECOVERY — the tester gate's
 * "no runnable entry" evidence + the instruction to PRODUCE the entry that wires the
 * modules into a running product. Pure. */
function buildIntegrationBounceNotes(testerGate: readonly ReviewFinding[]): string {
  return [
    'The product has renderable modules but NO runnable ENTRY — nothing wires them into a product that opens/builds/runs (the classic "food with no home"). The reviewers measured:',
    ...testerGate.map(findingLine),
    '',
    'Produce that entry NOW: the single runnable entry that loads/mounts every module and launches the working product, then confirm it runs.',
  ].join('\n');
}

/**
 * Run the REVIEW-AT-MERGE phase (spec §8, generalized) — the harnessed specialists
 * that MEASURE, and the bidirectional BOUNCE that keeps the product being re-worked
 * until it actually builds/runs:
 *  1. Spawn each planned lens (correctness, TESTER, security, performance, and — for
 *     a renderable product — visual-critic + accessibility) as a harnessed reviewer.
 *     The TESTER builds + runs + screenshots; when it managed to build+run, the
 *     visual/accessibility lenses drop their `renderLimited` flag and consume its
 *     real screenshot (they fall back to a static review only when no build could be
 *     produced).
 *  2. Aggregate the specialists' findings PLUS the model-free ground truth (the
 *     objective verify failures AND the tester gate's "no runnable entry" blocker).
 *  3. On a BLOCKING finding, BOUNCE: re-dispatch the affected contracts → re-verify,
 *     repeating up to `maxRevisions` DOWN-and-UP rounds (the generalized §8 bounce).
 *     When a blocking finding's SOURCE is unknown (it maps to no contract), the
 *     whole-codebase `auditor` is dispatched as the escape hatch to trace the
 *     cross-module root cause, and its findings target the contracts + enrich the
 *     bounce notes.
 *  4. Compute the TESTER GATE verdict (did the product end up building/running?) —
 *     the orchestrator GATES the CEO's APPROVE on it — and the transcript-free
 *     findings summary for the CEO.
 *
 * Bounded by construction: each lens runs once, the auditor at most once, the bounce
 * at most `maxRevisions` rounds, every agent charges the global budget (a spent
 * budget skips the rest), so it can never deadlock. Never throws. No per-agent caps.
 */
export async function runReviewPhase(params: ReviewPhaseParams): Promise<ReviewPhaseSummary> {
  const log = params.log ?? (() => {});
  const lensRuns: LensRunSummary[] = [];
  let collected: ReviewFinding[] = [];
  let skippedForBudget = false;

  // The model-free gate failure: a renderable product with no runnable entry / build
  // shell ("no home") — the tester cannot build or launch it, and re-running an
  // EXISTING contract cannot conjure the missing entry. Part C (below) can PRODUCE it
  // via the synthesized integration contract, at which point this is recomputed
  // against the re-assembled manifest; it stays true only when no recovery ran.
  let runnableEntryMissing = deriveTesterGateBlocking(params.manifest).length > 0;
  // Did the TESTER manage to build + run the product? (Set after the tester lens.) The
  // visual/accessibility lenses consume its real screenshot only when it did.
  let testerBuiltOk = false;

  const budgetSpent = (): boolean => params.budget !== undefined && budgetExceeded(params.budget);

  // 1. ONE review pass — each lens runs once, serially (its own memory phase, §8).
  for (const plan of params.lensPlan) {
    // The tester's real screenshot lets the visual/accessibility lenses MEASURE the
    // rendered artifact; without a successful build they stay statically render-limited.
    const isRenderLens = plan.lens === 'visual-critic' || plan.lens === 'accessibility';
    const renderLimited = isRenderLens ? !testerBuiltOk : plan.renderLimited;
    const effectivePlan: ReviewLensPlan = { lens: plan.lens, renderLimited };

    if (budgetSpent()) skippedForBudget = true;
    if (skippedForBudget) {
      lensRuns.push(lensRun(plan.lens, { renderLimited }));
      continue;
    }
    log(`review lens: ${plan.lens}${renderLimited ? ' (render-limited)' : ''}`);
    const out = await params.runReviewAgent(buildReviewAgentInput(effectivePlan, params));
    if (out === undefined) {
      // Budget spent at charge time — record as skipped and stop starting new lenses.
      skippedForBudget = true;
      lensRuns.push(lensRun(plan.lens, { renderLimited }));
      continue;
    }
    const findings = parseFindings(plan.lens, out.toolCalls, out.finalText);
    const usedBash = out.toolCalls.some((c) => c.name === 'bash');
    const blockingCount = findings.filter(isBlocking).length;
    collected = [...collected, ...findings];
    if (plan.lens === 'tester') {
      // The tester built + ran the product when it actually ran the build (bash) and
      // measured no blocking failure — and only when the product HAS a home to run in.
      testerBuiltOk = usedBash && blockingCount === 0 && !runnableEntryMissing;
    }
    lensRuns.push(
      lensRun(plan.lens, {
        ran: true,
        measured: !renderLimited,
        renderLimited,
        usedBash,
        findingCount: findings.length,
        blockingCount,
        ...(out.terminatedReason !== undefined ? { terminatedReason: out.terminatedReason } : {}),
      }),
    );
  }

  // 2. Aggregate — the specialists' findings PLUS the model-free ground truth: the
  // objective verify failures AND the tester gate's "no runnable entry" blocker. The
  // manifest / tester gate are LET-bound: Part C re-assembles the product when it
  // produces the missing entry, and the gate is recomputed against the fresh manifest.
  const objective = deriveBlockingFromVerify(params.verifyResult, params.contracts);
  let currentManifest = params.manifest;
  let testerGate = deriveTesterGateBlocking(currentManifest);
  // The specialists' + (later) the auditor's findings — the set that survives a
  // successful re-verify (the verify-derived blockers are dropped, these stay).
  let specialistFindings = collected;
  let findings = sortBySeverity(
    dedupeFindings(dedupeFindings(specialistFindings, objective), testerGate),
  );
  let blocking = findings.filter(isBlocking);
  const hadBlocking = blocking.length > 0;

  // 3. BLOCKING → recovery + the bounded, MULTI-ROUND bounce. Never deadlocks; each
  // cycle is budget-charged by the seam.
  let revisionTriggered = false;
  let revisionRan = false;
  let revisionRounds = 0;
  let revisedVerifyOk: boolean | undefined;
  let revisionContractIds: string[] = [];
  let auditorDispatched = false;
  let integrationEntryDispatched = false;
  let integrationEntryRecovered = false;

  if (hadBlocking && !budgetSpent()) {
    // 3a. MISSING RUNNABLE ENTRY → Part C recovery (spec §5/§8). The tester gate's "no
    // runnable entry" blocker maps to NO existing contract (the entry is a NEW
    // deliverable), so the re-dispatch bounce below could never clear it. Synthesize +
    // DISPATCH an integration contract that PRODUCES the entry, then re-assemble and
    // recompute the model-free gate against the fresh manifest — so the gate can
    // actually clear instead of flagging forever.
    if (
      runnableEntryMissing &&
      params.dispatchIntegrationContract !== undefined &&
      !budgetSpent()
    ) {
      log('review: no runnable entry → synthesizing + dispatching an integration contract');
      const out = await params.dispatchIntegrationContract({
        reason:
          'the product has renderable modules but no runnable entry that wires them into a running product',
        notes: buildIntegrationBounceNotes(testerGate),
      });
      if (out === undefined) {
        skippedForBudget = true;
      } else if (out.ran) {
        integrationEntryDispatched = true;
        currentManifest = out.manifest;
        revisedVerifyOk = out.verify.ok;
        // Recompute the MODEL-FREE gate against the RE-ASSEMBLED manifest.
        testerGate = deriveTesterGateBlocking(currentManifest);
        runnableEntryMissing = testerGate.length > 0;
        integrationEntryRecovered = !runnableEntryMissing;
        // Re-aggregate: the "no runnable entry" blocker is gone once the entry exists.
        findings = sortBySeverity(
          dedupeFindings(dedupeFindings(specialistFindings, objective), testerGate),
        );
        blocking = findings.filter(isBlocking);
        log(
          integrationEntryRecovered
            ? 'review: integration entry produced — the tester gate re-opened'
            : 'review: integration dispatch ran but no runnable entry yet',
        );
      }
    }
  }

  // 3b. The remaining BLOCKING findings (build failures in existing files) → the
  // bounded, MULTI-ROUND bounce (re-dispatch → re-verify), reusing the revise bound.
  if (blocking.length > 0 && params.reviseForFindings !== undefined && !budgetSpent()) {
    revisionContractIds = mapFindingsToContractIds(blocking, params.contracts);
    let auditorNotes = '';

    // ESCAPE HATCH (spec §8/§9 generalized): the blocking findings map to NO contract
    // — the SOURCE is unknown — so dispatch the whole-codebase `auditor` to trace the
    // cross-module root cause, then target the contracts IT cites + carry its notes.
    if (revisionContractIds.length === 0 && !budgetSpent()) {
      log('review: blocking source unknown → dispatching the whole-codebase auditor');
      const auditorPlan: ReviewLensPlan = { lens: 'auditor', renderLimited: false };
      const auditorOut = await params.runReviewAgent(buildReviewAgentInput(auditorPlan, params));
      if (auditorOut === undefined) {
        skippedForBudget = true;
      } else {
        auditorDispatched = true;
        const auditorFindings = parseFindings(
          'auditor',
          auditorOut.toolCalls,
          auditorOut.finalText,
        );
        specialistFindings = [...specialistFindings, ...auditorFindings];
        findings = sortBySeverity(
          dedupeFindings(dedupeFindings(specialistFindings, objective), testerGate),
        );
        const auditorBlocking = auditorFindings.filter(isBlocking);
        revisionContractIds = mapFindingsToContractIds(
          [...blocking, ...auditorBlocking],
          params.contracts,
        );
        auditorNotes = auditorFindings.map(findingLine).join('\n');
        lensRuns.push(
          lensRun('auditor', {
            ran: true,
            measured: true,
            usedBash: auditorOut.toolCalls.some((c) => c.name === 'bash'),
            findingCount: auditorFindings.length,
            blockingCount: auditorBlocking.length,
            ...(auditorOut.terminatedReason !== undefined
              ? { terminatedReason: auditorOut.terminatedReason }
              : {}),
          }),
        );
      }
    }

    if (revisionContractIds.length > 0 && params.reviseForFindings !== undefined) {
      revisionTriggered = true;
      const notes = buildBounceNotes(blocking, auditorNotes);
      log(
        `review: ${blocking.length} blocking finding(s) → bounded bounce of [${revisionContractIds.join(', ')}]`,
      );
      const revise = params.reviseForFindings;
      // runBoundedRevise caps the re-dispatch at `maxRevisions` DOWN-and-UP rounds
      // (the same generous bound the CEO revise loop uses) and re-checks via the
      // OBJECTIVE re-verify each round — it can never deadlock.
      const outcome = await runBoundedRevise({
        initialDecision: { decision: 'revise', notes } as CeoDecision,
        maxRevisions: params.maxRevisions,
        ...(params.budget !== undefined ? { budget: params.budget } : {}),
        runRevision: async (round): Promise<CeoDecision> => {
          const result = await revise({
            contractIds: revisionContractIds,
            notes: round.notes ?? notes,
          });
          if (result === undefined || !result.ran) {
            // Could not re-dispatch (budget/none) — accept the honest state.
            return { decision: 'approve' };
          }
          revisionRan = true;
          revisedVerifyOk = result.verify.ok;
          // The re-check signal is the OBJECTIVE re-verify — the tester gate's per-round
          // ground truth: pass → the gate clears; still failing → let the bound decide.
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
      revisionRounds = outcome.revisionsRun;
    }
  }

  // If any recovery/bounce cleared the OBJECTIVE re-verify, the verify-derived
  // blockers are stale — drop them from what the CEO sees, keeping the specialists'
  // findings and the (now-live, possibly cleared) tester gate. Then recompute the
  // residual blocking set the gate verdict reads.
  if (revisedVerifyOk === true) {
    findings = sortBySeverity(dedupeFindings(specialistFindings, testerGate));
  }
  blocking = findings.filter(isBlocking);

  // 4. The TESTER GATE verdict (spec §8, generalized — the CEO's APPROVE is gated on
  // it). It PASSES when the product ends the phase actually building/running: there is
  // a runnable entry (Part C may have PRODUCED it) AND no blocking failure remains, or
  // the bounded bounce cleared the objective re-verify. A "no home" product that could
  // not be given an entry never passes.
  const testerGatePassed = runnableEntryMissing
    ? false
    : blocking.length === 0
      ? true
      : revisedVerifyOk === true;

  const ceoFindingsSummary = buildFindingsSummary({
    findings,
    revisionTriggered,
    ...(revisedVerifyOk !== undefined ? { revisedVerifyOk } : {}),
  });

  return {
    lensRuns,
    findings,
    blockingCount: blocking.length,
    revisionTriggered,
    revisionContractIds,
    revisionRan,
    revisionRounds,
    ...(revisedVerifyOk !== undefined ? { revisedVerifyOk } : {}),
    auditorDispatched,
    integrationEntryDispatched,
    integrationEntryRecovered,
    testerGatePassed,
    runnableEntryMissing,
    skippedForBudget,
    ceoFindingsSummary,
  };
}
