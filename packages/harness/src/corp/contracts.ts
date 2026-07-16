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

import { type Contract, isContract } from './org-chart.js';
import type { HierarchyDivisionSpec } from './promotion.js';

/**
 * Build the manager's user turn for authoring ONE division's contracts. Pairs
 * with the manager base system prompt (prompts.ts `MANAGER_PROMPT`), which
 * already establishes disposition, granularity, and the `notes` invitation; this
 * message supplies the concrete division + the exact output shape to emit.
 */
export function buildManagerContractPrompt(
  division: HierarchyDivisionSpec,
  vision: string,
): string {
  return [
    'Write the typed contracts for ONE division of this project.',
    '',
    `Overall vision:\n${vision.trim()}`,
    '',
    `Division: ${division.name}`,
    `Division purpose: ${division.purpose}`,
    '',
    'Keep each contract small and focused, but bounded: aim for roughly 6–12 focused contracts for this division. If a contract would take an hour, split it — but if this division genuinely needs MORE than ~12 contracts, that is the signal it should be split into sub-divisions, not crammed into one oversized contract set. Order them so each contract only depends on ones that come before it.',
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
    'Output between 6 and 12 contracts as a JSON array, then STOP and close the array.',
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
 * too. Returns `[]` (never throws) when nothing usable is present.
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
  const salvaged: unknown[] = [];
  for (const raw of salvageTopLevelObjects(text)) {
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
  return collectContracts(salvaged);
}
