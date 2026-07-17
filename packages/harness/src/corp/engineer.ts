/**
 * The engineer turn — contract → FILE CONTENT (spec §7 execution, §4 engineers).
 *
 * An engineer holds exactly ONE contract and nothing else (spec §4). Its whole
 * job is to produce the file that plugs into the contract's `slot`. This module
 * ships the pure pieces of that turn:
 *
 *  - {@link ENGINEER_SYSTEM_PROMPT} — the engineer's system prompt: the library
 *    base (prompts.ts) + the engineering handbook (carried in every contract,
 *    spec §7) + an IMPORT-SCOPING rule (a standalone project imports only its
 *    declared/relative/third-party deps, never the host app's `@pi-desktop/*`
 *    packages — a real slice-4 defect) + the strict OUTPUT-FORMAT rule that makes
 *    the reply a file, not a chat message.
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
import {
  composeNodePrompt,
  ENGINEERING_HANDBOOK,
  getPromptById,
  getRolePrompt,
} from './prompts.js';
import type { RoleAgentCustomTool } from './role-agent-seam.js';

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

Imports — this is a standalone project:
Import ONLY from (a) the imports your contract declares as available, (b) other files in THIS project — use the exact relative specifiers given in the DEPENDENCIES block, (c) genuine third-party packages you'd install (e.g. 'three'). Do NOT import from unrelated internal packages like '@pi-desktop/*' — this is a standalone project.

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

/** The built-in tool allowlist an engineer AgentSession may hold. */
export const ENGINEER_BUILTIN_TOOLS = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
] as const;

/**
 * Map a contract's declared `available.tools` to the built-in agent allowlist.
 * `available.tools` is advisory prose today (often empty/sparse), so the DEFAULT
 * is the full agentic toolset; a genuinely-declared subset is honored but always
 * augmented with `read` + `write` (an engineer must read its deps and write its
 * slot). Pure + deterministic.
 */
export function engineerToolAllowlist(declared: readonly string[]): string[] {
  const builtin = new Set<string>(ENGINEER_BUILTIN_TOOLS);
  const known = declared.map((t) => t.toLowerCase().trim()).filter((t) => builtin.has(t));
  // Sparse/advisory (fewer than 3 recognized) → the full agentic toolset.
  if (known.length < 3) return [...ENGINEER_BUILTIN_TOOLS];
  const set = new Set(known);
  set.add('read');
  set.add('write');
  return ENGINEER_BUILTIN_TOOLS.filter((t) => set.has(t));
}

/**
 * The AGENT-path engineer addendum — a SELF-CONTAINED module-builder framing
 * (spec §7/§91). It carries NO corporation lore (no CEO/manager/division/peers/
 * escalation): the model builds ONE module and knows nothing of the org around it.
 * It RETIRES the {@link ENGINEER_SYSTEM_PROMPT} "your entire reply is your slot"
 * rule (on the agent path the files it WRITES are its submission) and drives the
 * reliable write flow: read only the named deps → WRITE the slot → one bash
 * self-check → `submit_contract`. The submit tool is the §164 interceptor — the
 * first call bounces with a self-review, the second finalizes — so the model gets
 * exactly one nudge to improve before its work is final.
 *
 * WRITE-RELIABILITY (real-model defect: engineers over-EXPLORED a sparse SHARED
 * tree and stopped WITHOUT writing). The workspace is now ISOLATED and seeded with
 * ONLY the dependency files, so there is nothing to wander; the framing makes
 * WRITING the slot the single first-class action and kills the aimless
 * `ls`/`find`/`grep`.
 */
export const AGENT_ENGINEER_ADDENDUM = `You build ONE self-contained module. TWO tool calls are MANDATORY and are the ONLY way to finish — do them, do not just talk:
  (1) WRITE: call the write tool to create the COMPLETE file at your contract's slot path. The file you WRITE is your deliverable — NEVER paste code as a chat message; a message is not a submission.
  (2) SUBMIT: call submit_contract. Simply stopping does NOT count and fails the contract. Your FIRST submit_contract call gives you one chance to improve the file before it is final; then call submit_contract AGAIN to finalize.
Do NOT explore the workspace (no ls / find / grep) — it holds ONLY your read-only dependency files, nothing to discover. Read ONLY the dependency files your contract names (skip reading entirely if it names none), then IMMEDIATELY call write to create your file, optionally run one quick \`bash\` check, then call submit_contract. Writing the file is the whole task — call write first, deliberate less.`;

/**
 * The AGENT engineer's SELF-CONTAINED system prompt (spec §7/§91). Unlike
 * {@link ENGINEER_SYSTEM_PROMPT} (chat path, reply-IS-the-file) it carries NO
 * corporation lore — no CEO/manager/division/peers/escalation. It is a clean
 * module-builder identity + the engineering handbook + the import-scoping rule +
 * {@link AGENT_ENGINEER_ADDENDUM} (the write flow + §164 submit-review). The run
 * appends the division PURPOSE as neutral domain flavor, never org structure.
 */
export const AGENT_ENGINEER_SYSTEM_PROMPT = `You are a software engineer building ONE self-contained module. You work alone: there is no team and no wider codebase to explore — your entire world is the contract you are given and the dependency files it names.

Good code is legible to a worker who does not share your context: typed boundaries, small single-responsibility units, intent-carrying names, and only the imports and tools your contract declares.

Imports — this is a standalone module: import ONLY from (a) your contract's declared imports, (b) the dependency files it names (use the exact relative specifiers given), (c) genuine third-party packages you'd install (e.g. 'three'). Never import from unrelated internal packages like '@pi-desktop/*'.

${AGENT_ENGINEER_ADDENDUM}`;

/** The name of the engineer's §164 submit tool (a custom tool). It MUST also
 * appear in the engineer's `tools` allowlist, or the pi runtime's allowlist
 * (which gates custom tools by name) hides it from the model. */
export const SUBMIT_CONTRACT_TOOL = 'submit_contract';

/**
 * Build the engineer's `submit_contract` tool — the §164 submission interceptor
 * (spec §7). The returned neutral {@link RoleAgentCustomTool} carries `submitReview`
 * with the contract's slot AND the model-free {@link buildSelfReviewPrompt}, so the
 * app seam wires a STATEFUL `execute`: the FIRST call returns the self-review prompt
 * (the bounce — improve, do not finalize), the SECOND verifies the slot file exists
 * and finalizes. Pure + deterministic.
 */
export function buildSubmitContractTool(contract: Contract): RoleAgentCustomTool {
  return {
    name: SUBMIT_CONTRACT_TOOL,
    description: `Call this when you believe your file at ${contract.slot} meets the contract. The FIRST time you call it you get one chance to re-read your contract and improve the file before it is final; call it again once you are satisfied to finalize.`,
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'One line: the file you wrote and that it satisfies the contract (optional).',
        },
      },
      required: [],
    },
    submitReview: { slot: contract.slot, reviewPrompt: buildSelfReviewPrompt(contract) },
  };
}

/**
 * The engineer's AGENT tool allowlist: the built-in toolset for its declared tools
 * ({@link engineerToolAllowlist}) PLUS the custom tool NAMES — {@link
 * SUBMIT_CONTRACT_TOOL} and the two consult tools ({@link CALL_PEER_TOOL} /
 * {@link CALL_SPECIALIST_TOOL}). A custom tool is only offered to the model when its
 * name is in the allowlist (the pi allowlist gotcha), so the submit + consult tools
 * must be listed here or the model never sees them. Pure + deterministic.
 */
export function engineerAgentToolAllowlist(declared: readonly string[]): string[] {
  return [
    ...engineerToolAllowlist(declared),
    SUBMIT_CONTRACT_TOOL,
    CALL_PEER_TOOL,
    CALL_SPECIALIST_TOOL,
  ];
}

/**
 * Build the engineer's USER turn for the AGENT path — the contract framing of
 * {@link buildEngineerPrompt} MINUS the "output the whole file as text" bits.
 * Dependencies are given as SLOT PATHS (with the exact relative import specifier)
 * and the engineer is told to READ them with its tools, rather than having their
 * produced content inlined (the agent reads real files from the shared workspace).
 * An optional CEO revision note is appended when re-dispatching a flagged contract.
 * Pure string composition; deterministic.
 */
export function buildAgentEngineerPrompt(
  contract: Contract,
  depContext: readonly DependencyContext[],
  architectureRegion?: string,
  extraNotes?: string,
): string {
  const tools =
    contract.available.tools.length > 0 ? contract.available.tools.join(', ') : '(none declared)';
  const imports =
    contract.available.imports.length > 0 ? contract.available.imports.join(', ') : '(none)';

  const lines: string[] = [
    `Your single required deliverable is the file at ${contract.slot}. WRITE it with the write tool. Do NOT explore the workspace (it may be empty — expected); do NOT print the file as text.`,
    '',
    'YOUR CONTRACT',
    `- Title: ${contract.title}`,
    `- Slot (write your file to THIS exact path): ${contract.slot}`,
    `- Input: ${contract.input}`,
    `- Output (what you must produce): ${contract.output}`,
    `- Advisory tools: ${tools}`,
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
      'DEPENDENCIES — already written to the workspace by prior contracts. Read ONLY these exact files with your `read` tool (nothing else in the workspace) and integrate against their ACTUAL types/names/signatures:',
    );
    for (const dep of depContext) {
      lines.push(
        '',
        `--- ${dep.title} (${dep.contractId})`,
        `Read file: ${dep.slot}`,
        `Provides: ${dep.output}`,
        `Import from '${relativeImportSpecifier(contract.slot, dep.slot)}' (use exactly this specifier).`,
      );
    }
  } else {
    lines.push(
      '',
      'DEPENDENCIES: none — do not read or explore anything. Go straight to writing your slot file.',
    );
  }

  const extra = extraNotes?.trim();
  if (extra !== undefined && extra !== '') {
    lines.push('', 'CEO REVISION NOTES (address these specifically):', extra);
  }

  lines.push(
    '',
    `Now WRITE the complete file to ${contract.slot} with the write tool, run ONE quick bash sanity check, then call submit_contract to finish — you are NOT finished until you call it, as simply stopping does not submit your work. On your first submit you get one chance to review and improve the file before it is final. Writing the slot file is the entire task — do not explore the workspace or print the file as text.`,
    `If you get stuck, consult FIRST (call_peer / call_specialist) before giving up; only if it is still genuinely impossible after that, reply on one line exactly: unfulfillable, because <reason>.`,
  );
  return lines.join('\n');
}

/** The spec bound on bump-to-continue: after a premature stop, re-prompt the SAME
 * engineer session at most this many times to reach a terminal decision (write +
 * submit, or declare unfulfillable). NOT a per-agent work cap — see §"Run safety". */
export const MAX_ENGINEER_BUMPS = 2;

/**
 * The BUMP-TO-CONTINUE user turn (spec "Run safety & budgets" — the completeness
 * backstop, like §204 retry-on-empty). Appended to the SAME engineer session when
 * its loop ended WITHOUT producing its deliverable: it names the exact slot, insists
 * the file be written + submit_contract be called, and offers the single explicit
 * escape — an "unfulfillable, because …" line — so the engineer always reaches a
 * TERMINAL decision instead of a silent premature stop. Pure + deterministic.
 */
export function buildBumpContinuePrompt(contract: Contract): string {
  return [
    'You ended your turn without submitting your deliverable.',
    `Your module is NOT complete until the file at ${contract.slot} exists AND you have called submit_contract.`,
    `If your module is complete, WRITE the file at ${contract.slot} now with the write tool and then call submit_contract.`,
    'If you got stuck, call call_peer or call_specialist for advice, then finish.',
    'If it is genuinely impossible, reply on ONE line exactly: unfulfillable, because <reason>.',
    'Do not stop again without doing one of these.',
  ].join('\n');
}

/** The peer-consult tool name (a clean-context engineer of the same division/role). */
export const CALL_PEER_TOOL = 'call_peer';
/** The specialist-consult tool name (an advisory reviewer chosen by lens). */
export const CALL_SPECIALIST_TOOL = 'call_specialist';

/** The advisory-specialist lenses a stuck engineer may consult (spec §4 advisory
 * reviewers; a safe, focused subset of PROMPT_LIBRARY). */
export const CONSULT_SPECIALIST_LENSES = ['correctness', 'security', 'performance'] as const;

/**
 * Build the engineer's two CONSULT tools (spec §7 peer & specialist consults, the
 * stuck-engineer's first stop before returning unfulfillable):
 *  - `call_peer(question)` — a CLEAN-CONTEXT instance of the engineer's own
 *    division/role (its archetype base + domain), returning its approach as prose.
 *  - `call_specialist(lens, question)` — an advisory reviewer (correctness /
 *    security / performance, from PROMPT_LIBRARY) returning evidence-grounded advice.
 *
 * ADVICE-ONLY (§12-Q11 safe default): the app seam runs each advisor read-only with
 * NO consult tools of its own (a depth cap of 1), so advisors return prose and can
 * never edit the requester's files or recurse. `promptId` selects the peer's
 * archetype base; `domain` is the division purpose flavor. Pure + deterministic.
 */
export function buildConsultTools(
  contract: Contract,
  opts?: { readonly promptId?: string; readonly domain?: string },
): RoleAgentCustomTool[] {
  const context = [
    `A teammate is building the module at slot ${contract.slot} and is stuck.`,
    `Module title: ${contract.title}`,
    `What it must produce: ${contract.output}`,
    `Review rubric it will be checked against: ${contract.reviewRubric}`,
  ].join('\n');

  const archetypeBase = getPromptById(opts?.promptId ?? '') ?? getRolePrompt('engineer');
  const peerSystemPrompt = `You are consulting as a PEER: a fresh engineer with the same skills, asked for advice by a teammate who is stuck. Return concise, concrete, actionable guidance as prose — the approach you would take, the key types or steps, and the pitfalls to avoid. You give ADVICE ONLY; never write or edit files.\n\n${composeNodePrompt(archetypeBase, opts?.domain)}`;

  const lensPrompts: Record<string, string> = {};
  for (const lens of CONSULT_SPECIALIST_LENSES) lensPrompts[lens] = getRolePrompt(lens).prompt;

  return [
    {
      name: CALL_PEER_TOOL,
      description:
        'Ask a peer engineer (same skills, fresh context) for advice when you are stuck. Returns concrete guidance as prose; it does not touch your files.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'What you are stuck on — be specific about the blocker.',
          },
        },
        required: ['question'],
      },
      consult: {
        kind: 'peer',
        context,
        systemPrompt: peerSystemPrompt,
        samplingMode: 'thinking-general',
      },
    },
    {
      name: CALL_SPECIALIST_TOOL,
      description:
        'Ask an advisory specialist to review your approach through one lens (correctness, security, or performance). Returns evidence-grounded advice as prose; it does not touch your files.',
      parameters: {
        type: 'object',
        properties: {
          lens: {
            type: 'string',
            enum: [...CONSULT_SPECIALIST_LENSES],
            description: 'Which lens to review through.',
          },
          question: {
            type: 'string',
            description: 'What you want the specialist to check or advise on.',
          },
        },
        required: ['lens', 'question'],
      },
      consult: { kind: 'specialist', context, lensPrompts, samplingMode: 'thinking-general' },
    },
  ];
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
