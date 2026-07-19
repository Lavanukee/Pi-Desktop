/**
 * Manager contract-writing (spec §0 granularity, §4 manager block, §5 the
 * Contract shape, §12.2).
 *
 * Two pure pieces for slice 1's "one manager writes one division's contracts":
 *
 *  - {@link buildManagerContractPrompt} — the USER turn handed to a manager
 *    (whose system prompt is the manager base from prompts.ts). It asks for one
 *    division's work as a JSON array of {@link Contract}s, following the
 *    small-focused-tasks principle bounded to ~6–12 per division (more than that
 *    is the signal to split into sub-divisions, not to over-split one set).
 *  - {@link parseManagerContracts} — extracts + validates that JSON array back
 *    into {@link Contract}[], tolerant of the code fences / surrounding prose a
 *    small model tends to add, and salvaging complete contracts from a reply that
 *    was truncated mid-array (spec §10 robustness).
 *
 * Nothing here dispatches or schedules — that's a later slice. This is the
 * manager's authoring step only.
 */

import {
  COARSE_MAX_CONTRACTS_PER_DIVISION,
  DEFAULT_DECOMPOSITION_GRANULARITY,
  type DecompositionGranularity,
} from './architect.js';
import type { Architecture } from './org-chart.js';
import { type Contract, isContract } from './org-chart.js';
import type { HierarchyDivisionSpec } from './promotion.js';

/**
 * The contract-count STEER for a manager's turn, keyed off granularity (J7). COARSE
 * (`xhigh`, the default) asks for a FEW, LARGE contracts (≤ {@link
 * COARSE_MAX_CONTRACTS_PER_DIVISION}) so a division owns a big slice and the whole
 * project lands around a handful of contracts — the enforcement cap
 * ({@link capManagerContracts}) truncates anything beyond it. FINE (`max`) keeps the
 * original bounded 6–12 range (full fine-grained decomposition). Pure + deterministic.
 */
function managerContractCountGuidance(granularity: DecompositionGranularity): {
  readonly bodyLine: string;
  readonly outputLine: string;
} {
  if (granularity === 'max') {
    return {
      bodyLine:
        'Keep each contract small and focused, but bounded: aim for roughly 6–12 focused contracts for this division. If a contract would take an hour, split it — but if this division genuinely needs MORE than ~12 contracts, that is the signal it should be split into sub-divisions, not crammed into one oversized contract set. Order them so each contract only depends on ones that come before it.',
      outputLine:
        'Output between 6 and 12 contracts as a JSON array, then STOP and close the array.',
    };
  }
  const cap = COARSE_MAX_CONTRACTS_PER_DIVISION;
  return {
    bodyLine: `Author a FEW, LARGE contracts — aim for 1–${cap} (author at most ${cap}) that each OWN a substantial slice of this division. Do NOT split the work into many small tasks: GROUP closely-related concerns into the SAME big contract, giving one worker a whole coherent module. Fewer, larger contracts build faster and merge cleanly; over-splitting into many tiny contracts stresses integration and collapses the merge. Order them so each contract only depends on ones that come before it.`,
    outputLine: `Output 1 to ${cap} contracts as a JSON array, then STOP and close the array.`,
  };
}

/**
 * Enforce the COARSE (xhigh) per-division contract cap (J7): keep at most `cap`
 * contracts (the FIRST ones, which the manager authors foundation-first in dependency
 * order), truncating any beyond it. Returns the kept contracts + the ids trimmed (for
 * the caller to log — nothing is silently dropped). `cap === Infinity` (FINE / `max`)
 * returns the input UNCHANGED. Pure + deterministic.
 */
export function capManagerContracts(
  contracts: readonly Contract[],
  cap: number,
): { readonly contracts: Contract[]; readonly trimmedIds: readonly string[] } {
  if (!Number.isFinite(cap) || contracts.length <= cap) {
    return { contracts: [...contracts], trimmedIds: [] };
  }
  const limit = Math.max(0, Math.floor(cap));
  return {
    contracts: contracts.slice(0, limit),
    trimmedIds: contracts.slice(limit).map((c) => c.id),
  };
}

/** Normalized division-name compare (the architect uses the exact names, but a
 * small model may drift case/whitespace). */
function sameDivision(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The architecture-seeding block spliced into a manager's turn when a shared
 * {@link Architecture} exists (the integration layer): (a) the module-map region
 * THIS division owns — target files there, do not invent structure — and (b) the
 * cross-division interface handles, with the rule to express a dependency on
 * another division's work by adding `iface:<Name>` to a contract's `dependsOn`
 * rather than reinventing it. Returns `[]` (no lines) when there is no
 * architecture, so a 2-arg call is byte-identical to the pre-integration prompt.
 */
function architectureSeedLines(
  division: HierarchyDivisionSpec,
  architecture: Architecture | undefined,
): string[] {
  if (architecture === undefined) return [];
  const owned = architecture.moduleMap.filter((m) => sameDivision(m.owner, division.name));
  const exposedHere = architecture.interfaces.filter((h) =>
    sameDivision(h.exposedBy, division.name),
  );

  const lines: string[] = ['', 'SHARED ARCHITECTURE (build against it — do not invent your own):'];

  if (owned.length > 0) {
    lines.push(
      'Your division owns the directory region(s) listed below. Create your work as DISTINCT FILES inside your region\'s directory — one distinct file (and/or export) per contract; set each contract\'s "slot" to a distinct file path within your region. Never assign two contracts the same slot, and never pile multiple contracts onto one file. Do not create files outside your region:',
    );
    for (const m of owned) lines.push(`  - ${m.path} — ${m.purpose}`);
  } else {
    lines.push(
      'The module map did not carve out a dedicated region for your division; place your work sensibly and lean on the interfaces below to connect to other divisions.',
    );
  }

  if (architecture.interfaces.length > 0) {
    lines.push(
      'Cross-division interfaces (the seams one division exposes for others). If your work needs something ANOTHER division produces, do NOT rebuild it — add that interface\'s handle to the contract\'s "dependsOn" as "iface:<Name>" (e.g. "dependsOn": ["iface:GameState"]); the harness resolves the handle to the real contract that produces it. Only depend on interfaces OTHER divisions expose — never add an "iface:<Name>" your OWN division exposes to a contract\'s "dependsOn" (your division BUILDS that interface, it does not consume it). Review the interface list below and reference EVERY handle your work genuinely depends on — cross-division consumption should be symmetric, not one-directional:',
    );
    for (const h of architecture.interfaces) {
      const consumers = h.consumedBy.length > 0 ? ` — consumed by ${h.consumedBy.join(', ')}` : '';
      lines.push(
        `  - iface:${h.name} — exposed by ${h.exposedBy} at ${h.path}: ${h.summary}${consumers}`,
      );
    }
  }

  if (exposedHere.length > 0) {
    lines.push(
      `Your division EXPOSES ${exposedHere.map((h) => `iface:${h.name}`).join(', ')}. Make sure one of your contracts has its "slot" set to the matching path (${exposedHere.map((h) => h.path).join(', ')}) so consuming divisions resolve to it.`,
    );
  }

  return lines;
}

/**
 * Build the manager's user turn for authoring ONE division's contracts. Pairs
 * with the manager base system prompt (prompts.ts `MANAGER_PROMPT`), which
 * already establishes disposition, granularity, and the `notes` invitation; this
 * message supplies the concrete division + the exact output shape to emit.
 *
 * When a shared {@link Architecture} is supplied (the integration layer), the
 * turn is seeded with the module-map region this division owns and the
 * cross-division interface handles — so contracts target the canonical structure
 * and express real cross-division dependencies as `iface:<Name>` entries (see
 * {@link architectureSeedLines}). Omit `architecture` (2-arg call) for the
 * pre-integration behavior — the output is then unchanged.
 */
export function buildManagerContractPrompt(
  division: HierarchyDivisionSpec,
  vision: string,
  architecture?: Architecture,
  granularity: DecompositionGranularity = DEFAULT_DECOMPOSITION_GRANULARITY,
): string {
  const countGuidance = managerContractCountGuidance(granularity);
  return [
    'Write the typed contracts for ONE division of this project.',
    '',
    `Overall vision:\n${vision.trim()}`,
    '',
    `Division: ${division.name}`,
    `Division purpose: ${division.purpose}`,
    ...architectureSeedLines(division, architecture),
    '',
    countGuidance.bodyLine,
    '',
    'Output ONLY a JSON array (no prose, no code fence) where each element is a contract with exactly these fields:',
    '- "id": string — short unique id, e.g. "' +
      `${division.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-1".`,
    '- "title": string — short human title.',
    '- "ownerNodeId": string — the engineer slot that will build it, e.g. "' +
      `${division.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-eng-1".`,
    '- "input": string — what the worker receives (typed description).',
    '- "output": string — what the worker must produce (typed description).',
    '- "slot": string — where the output plugs in (file/module/export). Give each contract a DISTINCT slot — two contracts must not target the same file/export.',
    '- "available": { "tools": string[], "imports": string[] } — the declared surface. "tools" are capabilities the worker may invoke (e.g. "read", "write", "bash"). "imports" are module/package specifiers the output depends on (e.g. "@pi-desktop/ui", "node:fs"); a language or runtime like "typescript" or "node" is NOT an import.',
    '- "reviewRubric": string — what the work is reviewed against, written before implementation.',
    '- "dependsOn": string[] — ids of contracts that must finish first ([] if none).',
    '- "notes": string (optional) — anything not captured above: a past approach that failed and should be avoided, a special instruction, a constraint, or a warning. Omit when there is nothing extra to say.',
    '- "status": "queued" — every new contract starts queued.',
    '',
    countGuidance.outputLine,
  ].join('\n');
}

/** Strip the ```lang fences (open + any close) a small model wraps its JSON in. */
function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9]*\s*\n?/g, '').replace(/```/g, '');
}

/**
 * Extract the first balanced JSON array `[…]` from `text`, tolerant of ```json
 * fences and surrounding prose (a small model rarely returns a bare array). Uses
 * the same string-aware balanced scan as the tool-call fixer's object extractor.
 * Returns `undefined` when the array is unclosed/truncated — the salvage path in
 * {@link parseManagerContracts} recovers whatever complete elements it holds.
 */
function extractJsonArray(text: string): string | undefined {
  const unfenced = stripFences(text);
  const start = unfenced.indexOf('[');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return unfenced.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Light normalization of one decoded array element before validation: fills the
 * two fields a small model most often drops (`dependsOn`, `status`) and rounds
 * out a partial `available` surface. It never invents required content (title,
 * input, output, slot, rubric) — a genuinely incomplete contract still fails
 * {@link isContract} and is dropped.
 */
function normalizeContractCandidate(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (!Array.isArray(obj.dependsOn)) obj.dependsOn = [];
  if (obj.status === undefined) obj.status = 'queued';
  const avail = obj.available;
  if (avail !== null && typeof avail === 'object' && !Array.isArray(avail)) {
    const a = avail as Record<string, unknown>;
    obj.available = {
      tools: Array.isArray(a.tools) ? a.tools : [],
      imports: Array.isArray(a.imports) ? a.imports : [],
    };
  }
  return obj;
}

/** Normalize + validate decoded array elements into {@link Contract}[]. */
function collectContracts(elements: readonly unknown[]): Contract[] {
  const contracts: Contract[] = [];
  for (const element of elements) {
    const candidate = normalizeContractCandidate(element);
    if (isContract(candidate)) contracts.push(candidate);
  }
  return contracts;
}

/**
 * Salvage the complete top-level `{…}` object elements of a JSON array from
 * `text`, even when the array itself is unclosed/truncated (spec §10 robustness).
 * String-aware balanced-brace scan starting at the first `[`: an object element
 * begins when brace depth rises 0→1 and completes when it falls back to 0, so
 * nested objects/arrays (e.g. `available`, `dependsOn`) never split an element,
 * and a final element cut off mid-stream (its braces never close) is simply not
 * collected. Returns each complete element's raw JSON substring, in order.
 *
 * Re-synchronization (real-qwen defect): a `notes` value whose closing quote the
 * model dropped — so a raw newline lands inside the still-"open" string — would
 * otherwise DESYNC the scan. The unterminated `"` swallows the element's closing
 * `}` and the `},{` boundary as string content, then flips string parity for the
 * rest of the array, so every later well-formed element is lost. Because a raw
 * control character is illegal inside a JSON string, encountering one while
 * `inString` is proof the string was never closed: we treat the newline as the
 * string's end and re-sync, so the poisoned element's `}` is counted, the next
 * top-level `{` starts a fresh element, and the elements after the defect survive
 * (the poisoned substring itself is left for per-element repair in
 * {@link parseManagerContracts}).
 */
function salvageTopLevelObjects(text: string): string[] {
  const unfenced = stripFences(text);
  const start = unfenced.indexOf('[');
  if (start === -1) return [];
  const objects: string[] = [];
  let braceDepth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      // A raw newline/CR is illegal inside a JSON string ⇒ the closing quote was
      // dropped. Treat it as the string's end and re-sync the brace scan so this
      // poisoned element does not discard the well-formed ones after it.
      else if (ch === '\n' || ch === '\r') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (braceDepth === 0) objStart = i;
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0 && objStart !== -1) {
        objects.push(unfenced.slice(objStart, i + 1));
        objStart = -1;
      } else if (braceDepth < 0) {
        // Stray close brace — malformed; reset and keep scanning.
        braceDepth = 0;
        objStart = -1;
      }
    } else if (ch === ']' && braceDepth === 0) {
      break; // clean end of the array
    }
  }
  return objects;
}

/**
 * Lenient repair of a single JSON fragment whose string(s) a small model left
 * unterminated by dropping the closing quote — so a raw newline (or CR) sits
 * inside the string, which is illegal JSON and makes `JSON.parse` throw on the
 * control character. We insert the missing `"` at the first raw newline of each
 * open string, terminating it there. Pure and deterministic; it never throws and
 * returns the input unchanged when no string is open at a newline (the common,
 * well-formed case). Mirrors the provider's rung-1 syntactic tolerance in spirit
 * (the harness must not depend on the provider build, so it is reimplemented
 * here, small and local).
 */
function repairUnterminatedStrings(fragment: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === '\\') {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n' || ch === '\r') {
        // Unterminated string closed by a raw newline: insert the missing quote
        // before the newline, then continue outside the string.
        out += '"';
        out += ch;
        inString = false;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/**
 * Balance an open-but-truncated leading JSON object: close a value cut off
 * mid-string, drop a dangling trailing comma, and append the closers for every
 * still-open `{`/`[` (innermost first). Pure, string-aware, never throws — the
 * caller still gates the result on `JSON.parse` + {@link isContract}, so an
 * un-closeable fragment simply fails to parse and is discarded.
 */
function closeTruncatedObject(fragment: string): string {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') closers.push('}');
    else if (ch === '[') closers.push(']');
    else if (ch === '}' || ch === ']') closers.pop();
  }
  let out = fragment;
  if (inString) {
    // Value truncated mid-string with no trailing newline for
    // repairUnterminatedStrings to close on — terminate it here.
    out += '"';
  } else {
    // Outside a string at the cut: drop trailing whitespace + a dangling comma
    // so the object closes cleanly ("…,"queued", ␤" → "…,"queued"").
    out = out.replace(/[\s,]*$/, '');
  }
  while (closers.length > 0) out += closers.pop();
  return out;
}

/**
 * Final backstop for the worst truncation: the reply was cut off BEFORE the
 * first contract object ever closed, so {@link salvageTopLevelObjects} recovered
 * nothing. Extract the partial leading `{…}` (from the first brace after the
 * opening `[`), close its unterminated strings + open braces/brackets, and
 * JSON.parse it. Returns the decoded value (validated by the caller) or
 * `undefined` when there is no leading object or it will not parse. Never throws.
 */
function repairTruncatedLeadingObject(text: string): unknown {
  const unfenced = stripFences(text);
  const arrStart = unfenced.indexOf('[');
  const objStart = unfenced.indexOf('{', arrStart === -1 ? 0 : arrStart + 1);
  if (objStart === -1) return undefined;
  const closed = closeTruncatedObject(repairUnterminatedStrings(unfenced.slice(objStart)));
  try {
    return JSON.parse(closed);
  } catch {
    return undefined;
  }
}

/**
 * Parse a manager reply into validated {@link Contract}[]. Tolerant of fences /
 * prose around the array and of the two most-omitted fields (via
 * {@link normalizeContractCandidate}); every element is validated with
 * {@link isContract} and only valid contracts are returned.
 *
 * Two paths: a fast path when the whole `[…]` array is present and parses (its
 * result is authoritative — an empty array means the manager genuinely wrote
 * none), and a salvage path (spec §10) when the array is unclosed/truncated or
 * fails to JSON.parse — it recovers every complete top-level `{…}` element
 * individually so a reply cut off mid-array still yields its finished contracts
 * instead of nothing.
 *
 * The salvage path is resilient to a single poisoned element (real-qwen defect: a
 * `notes` string left unterminated by a raw newline). {@link salvageTopLevelObjects}
 * re-synchronizes past it so every well-formed element AFTER the defect survives;
 * and each element that fails to parse on its own gets one lenient repair pass
 * ({@link repairUnterminatedStrings}) so the poisoned element is usually recovered
 * too.
 *
 * Final backstop (real-qwen defect: a too-tight `max_tokens` cut the reply off
 * BEFORE its first contract object even closed): when salvage recovers zero
 * complete objects, {@link repairTruncatedLeadingObject} closes the partial
 * leading object and, if it validates, returns that one contract — so a division
 * whose reply truncated on its first object yields its one partial-but-complete
 * contract instead of silently vanishing from the plan. Returns `[]` (never
 * throws) when nothing usable is present.
 */
export function parseManagerContracts(text: string): Contract[] {
  const region = extractJsonArray(text);
  if (region !== undefined) {
    try {
      const decoded = JSON.parse(region);
      if (Array.isArray(decoded)) return collectContracts(decoded);
    } catch {
      // Balanced brackets but invalid JSON inside — fall through to salvage.
    }
  }
  // Salvage: the array was truncated (no closing `]`) or failed to parse whole.
  const salvagedRaw = salvageTopLevelObjects(text);
  const salvaged: unknown[] = [];
  for (const raw of salvagedRaw) {
    try {
      salvaged.push(JSON.parse(raw));
    } catch {
      // Malformed on its own — most often an unterminated string closed by a raw
      // newline. Attempt the lenient repair before giving up; still-broken
      // elements are dropped, never taking the rest of the array down with them.
      try {
        salvaged.push(JSON.parse(repairUnterminatedStrings(raw)));
      } catch {
        // Genuinely unusable — drop just this one element.
      }
    }
  }
  const contracts = collectContracts(salvaged);
  if (contracts.length > 0) return contracts;
  // Backstop: salvage found NO complete object ⇒ the reply truncated before the
  // first object closed. Try to close that partial leading object rather than
  // dropping the whole division.
  if (salvagedRaw.length === 0) {
    const partial = repairTruncatedLeadingObject(text);
    if (partial !== undefined) return collectContracts([partial]);
  }
  return [];
}
