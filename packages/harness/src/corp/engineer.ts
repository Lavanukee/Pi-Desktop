/**
 * The engineer turn — contract → FILE CONTENT (spec §7 execution, §4 engineers).
 *
 * An engineer holds exactly ONE contract and nothing else (spec §4). Its whole
 * job is to produce the file that plugs into the contract's `slot`. This module
 * ships the pure pieces of that turn:
 *
 *  - {@link ENGINEER_SYSTEM_PROMPT} — the engineer's system prompt: the library
 *    base (prompts.ts) + the engineering handbook (carried in every contract,
 *    spec §7) + the strict OUTPUT-FORMAT rule that makes the reply a file, not a
 *    chat message.
 *  - {@link buildEngineerPrompt} — the USER turn: the contract, its resolved
 *    {@link DependencyContext} (the interfaces it consumes AND the ACTUAL produced
 *    content of the contracts it dependsOn, so it builds against real code, not a
 *    description), and its module region from the shared architecture.
 *  - {@link buildSelfReviewPrompt} — the model-free self-review bounce the
 *    submission interceptor sends (dispatch.ts `withSubmissionReview`).
 *  - {@link parseEngineerOutput} — tolerant extraction of the file body from a
 *    reply (strip prose/fences; keep the code verbatim).
 *
 * THINKING MODE (documented per the spec's ROLE_THINKING directive): the engineer
 * runs thinking ON (prompts.ts `ROLE_THINKING.engineer === true`). Code benefits
 * from reasoning — the model should think through types, edge cases, and how its
 * file meets the contract before writing it. The runaway-<think> failure that
 * forced the MANAGER thinking-OFF does NOT apply here: that defect was a JSON
 * array being starved when reasoning never closed, and a truncated array parses
 * to zero contracts (a whole unit of work lost). The engineer emits a free-form
 * FILE, not a parse-critical structure — reasoning that runs long costs tokens,
 * not the entire artifact, and a thinking model streams its reasoning on a
 * separate channel so the answer content stays clean for {@link parseEngineerOutput}.
 * The guard against runaway is the "generation-heavy" budget rule from slice 3
 * (spec §0.6): the dispatcher floors the engineer turn at an adequate `max_tokens`
 * (~16k, like the manager) so thinking has room AND the file is never truncated.
 *
 * VALIDATED (real-qwen, slice-4 execution): engineer thinking-ON is confirmed safe
 * at the 16k budget — 0/8 engineer turns ran away inside `<think>`, and every one
 * still emitted a clean file body. The single caveat is a VERY open-ended slot
 * (little dependency scaffolding to anchor the reasoning), where a think could in
 * principle run long enough to starve the file; that residual risk is covered NOT
 * by flipping thinking off but by the retry-on-empty backstop (corp/retry.ts,
 * wired into the driver): an empty/whitespace-only engineer reply is retried once
 * (fallback: thinking-OFF) and, if still empty, the contract is marked FAILED
 * rather than writing an empty file. So engineer stays thinking-ON by default.
 *
 * Nothing here dispatches, schedules, or writes to disk — that is dispatch.ts +
 * workspace.ts. This is the engineer's authoring step only.
 */

import type { Contract } from './org-chart.js';
import { ENGINEERING_HANDBOOK, getRolePrompt } from './prompts.js';

/**
 * The engineer's system prompt: the predefined library base (disposition +
 * "the contract is your entire job"), the engineering handbook (spec §7 — carried
 * in every contract), and the OUTPUT-FORMAT rule. The rule is load-bearing: the
 * reply is written VERBATIM to the contract's slot, so it must BE the file — not a
 * diff, not a fragment, not chat. Reuses the library base so there is one source
 * of truth for the engineer disposition.
 */
export const ENGINEER_SYSTEM_PROMPT = `${getRolePrompt('engineer').prompt}

${ENGINEERING_HANDBOOK}

Output format — this is not optional:
Your entire reply is written verbatim to your contract's slot as a single file, so it must BE the file and nothing else. Produce the COMPLETE file for the slot — never a diff, a fragment, or a "…rest unchanged" placeholder. Put the whole file in ONE fenced code block (\`\`\`), with nothing before or after the fence, or output the raw file body alone with no prose. Do not add explanations, headings, or commentary outside the file.`;

/**
 * One resolved dependency handed to an engineer: not just the description of a
 * contract it dependsOn, but its ACTUAL produced content, so the engineer builds
 * against real code (real types, names, signatures) rather than a paraphrase.
 * `content` is absent only when the producer's output is unavailable (e.g. it was
 * dispatched with no captured file) — the typed `output` description then guides.
 */
export interface DependencyContext {
  /** The dependency contract's id. */
  readonly contractId: string;
  /** Its human title. */
  readonly title: string;
  /** Where its output landed (its slot / file path). */
  readonly slot: string;
  /** Its declared output — the typed description of what it produces. */
  readonly output: string;
  /** The ACTUAL produced file content, when available (else build to `output`). */
  readonly content?: string;
}

/** Split a slot into path segments, tolerating `\\` separators and normalizing
 * `.` / `..` / empty segments away (an internal `..` pops its parent). */
function normalizeSlotSegments(slot: string): string[] {
  const out: string[] = [];
  for (const raw of slot.split(/[/\\]+/)) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      out.pop();
      continue;
    }
    out.push(raw);
  }
  return out;
}

/** Drop a single trailing file extension from a path segment (`state.ts` →
 * `state`, `hud.tsx` → `hud`); leave an extension-less segment unchanged. */
function stripExtension(segment: string): string {
  return segment.replace(/\.[^.]+$/, '');
}

/**
 * The EXACT relative import specifier from one slot to another, computed from the
 * two file paths the harness already knows — so an engineer never has to GUESS
 * whether a dependency is `./state`, `../state`, or the contract-id as a module
 * name (the real-qwen defect: 7/8 files wired the import slightly wrong even
 * though BOTH slots were known to the harness). Pure and deterministic.
 *
 * Given `fromSlot` (the file being written) and `toSlot` (a dependency's file),
 * it returns the module specifier to import the dependency with: the path
 * RELATIVE to `fromSlot`'s directory, with the file extension stripped and a
 * leading `./` or `../` guaranteed (an ES/TS relative import must be dot-anchored).
 *
 * Examples:
 *   src/mechanics/gameLoop.ts → src/mechanics/state.ts  ⇒ "./state"        (same dir)
 *   src/mechanics/gameLoop.ts → src/engine/state.ts     ⇒ "../engine/state" (sibling dir)
 *   src/a.ts                  → src/ui/theme/tokens.ts  ⇒ "./ui/theme/tokens" (nested)
 *   src/a/b/c.ts              → src/x/y.ts              ⇒ "../../x/y"
 *
 * Slots are treated as posix-style, project-relative paths; `\\` separators are
 * tolerated and `.` / `..` / empty segments normalized away before comparison.
 */
export function relativeImportSpecifier(fromSlot: string, toSlot: string): string {
  const fromDir = normalizeSlotSegments(fromSlot).slice(0, -1);
  const toParts = normalizeSlotSegments(toSlot);
  const last = toParts.length - 1;
  if (last >= 0) toParts[last] = stripExtension(toParts[last] ?? '');

  // Longest common directory prefix (compared segment-by-segment, so `foo` and
  // `foobar` never falsely share a prefix).
  let common = 0;
  while (
    common < fromDir.length &&
    common < toParts.length &&
    fromDir[common] === toParts[common]
  ) {
    common++;
  }
  const up = fromDir.length - common;
  const segments = [...Array<string>(up).fill('..'), ...toParts.slice(common)];
  if (segments.length === 0) return '.';
  const joined = segments.join('/');
  // Dot-anchor the same-dir / subdir case (`state` → `./state`); a `..`-prefixed
  // path is already anchored.
  return joined.startsWith('.') ? joined : `./${joined}`;
}

/**
 * Build the engineer's USER turn for producing the file at a contract's slot.
 * Pairs with {@link ENGINEER_SYSTEM_PROMPT}. Carries the full contract surface
 * (title / slot / input / output / tools / imports / rubric / notes), the module
 * region this file lives in (from the shared architecture, when supplied), and
 * the resolved {@link DependencyContext} of every contract it dependsOn — with
 * each dependency's real produced file inlined so the engineer integrates against
 * actual code. For every dependency it also states the EXACT relative import
 * specifier ({@link relativeImportSpecifier}) the engineer must use — the harness
 * knows both slots, so the engineer is handed `./state` / `../engine/state`
 * verbatim instead of guessing it (the real-qwen wiring defect). Pure string
 * composition; deterministic.
 */
export function buildEngineerPrompt(
  contract: Contract,
  depContext: readonly DependencyContext[],
  architectureRegion?: string,
): string {
  const tools =
    contract.available.tools.length > 0 ? contract.available.tools.join(', ') : '(none)';
  const imports =
    contract.available.imports.length > 0 ? contract.available.imports.join(', ') : '(none)';

  const lines: string[] = [
    'Build the file for your contract. Return the COMPLETE file content for the slot below — nothing else.',
    '',
    'YOUR CONTRACT',
    `- Title: ${contract.title}`,
    `- Slot (write your file here): ${contract.slot}`,
    `- Input: ${contract.input}`,
    `- Output (what you must produce): ${contract.output}`,
    `- Available tools: ${tools}`,
    `- Available imports (build only against these): ${imports}`,
    `- Review rubric (your work is checked against this): ${contract.reviewRubric}`,
  ];

  const notes = contract.notes?.trim();
  if (notes !== undefined && notes !== '') lines.push(`- Notes: ${notes}`);

  const region = architectureRegion?.trim();
  if (region !== undefined && region !== '') {
    lines.push(
      '',
      'YOUR MODULE REGION (where this file sits in the shared architecture — stay inside it):',
      region,
    );
  }

  if (depContext.length > 0) {
    lines.push(
      '',
      'DEPENDENCIES — the real work you build ON. Integrate against these ACTUAL outputs (their real types, names, and signatures), not against a guess:',
    );
    for (const dep of depContext) {
      lines.push(
        '',
        `--- ${dep.title} (${dep.contractId}) → ${dep.slot}`,
        `Provides: ${dep.output}`,
        `Import from '${relativeImportSpecifier(contract.slot, dep.slot)}' (do not guess the path; use exactly this specifier).`,
      );
      const content = dep.content;
      if (content !== undefined && content.trim() !== '') {
        lines.push('Produced file:', '```', content, '```');
      } else {
        lines.push('(Produced file not available — build to the "Provides" description above.)');
      }
    }
  }

  lines.push('', `Return ONLY the file content for ${contract.slot}.`);
  return lines.join('\n');
}

/**
 * The model-free self-review bounce (spec §7 submission interceptor): auto-generated
 * from the contract, it asks the engineer to re-read its contract and the file it
 * just wrote and return the FINAL file — revised if anything needs fixing, or the
 * same file if it already meets the contract. No second model is involved; the
 * dispatcher (dispatch.ts `withSubmissionReview`) sends this once per contract.
 */
export function buildSelfReviewPrompt(contract: Contract): string {
  return [
    'Before your file is accepted, review it once against your contract.',
    `- Does it fully meet the contract's input → output for its slot (${contract.slot})?`,
    `- Does it satisfy the review rubric: ${contract.reviewRubric}?`,
    '- Is there anything you would improve — a correctness bug, a missed edge case, unclear names, or a drift from house style?',
    'Re-read your contract and the file you wrote, then return the FINAL file: the complete file content, revised if anything needed fixing, or exactly the same file if it already fully meets the contract. Output only the file.',
  ].join('\n');
}

/** Strip leading and trailing blank lines from a fence body while keeping the
 * code between them verbatim (indentation, internal blank lines, everything). */
function trimBlankLines(s: string): string {
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** Every ```lang … ``` fenced block body in `text`, in order (outer blank lines
 * trimmed, code kept verbatim). Empty when there is no closed fence. */
function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let match = re.exec(text);
  while (match !== null) {
    blocks.push(trimBlankLines(match[1] ?? ''));
    match = re.exec(text);
  }
  return blocks;
}

/**
 * Extract the file body an engineer produced from its raw reply — tolerant of the
 * prose / code fences a model tends to add, keeping the code itself verbatim.
 *
 * Order of tolerance:
 *  1. Prefer fenced code blocks. When the reply contains one or more ```…```
 *     blocks, return the LARGEST — the file is the substantive block, while a
 *     stray inline snippet inside reasoning prose is always smaller.
 *  2. An opening fence with no closer (a reply truncated mid-file) → return
 *     everything after the opening fence line.
 *  3. No fences at all → the reply IS the file (the system prompt asks for exactly
 *     that); return it verbatim with only its outer blank lines trimmed.
 *
 * Never throws; returns `''` for a non-string or empty reply.
 */
export function parseEngineerOutput(text: string): string {
  if (typeof text !== 'string' || text === '') return '';

  const blocks = extractFencedBlocks(text);
  if (blocks.length > 0) {
    return blocks.reduce((largest, block) => (block.length >= largest.length ? block : largest));
  }

  const open = text.match(/```[^\n]*\n/);
  if (open !== null && open.index !== undefined) {
    return trimBlankLines(text.slice(open.index + open[0].length));
  }

  return trimBlankLines(text);
}
