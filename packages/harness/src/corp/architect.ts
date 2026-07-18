/**
 * The integration layer — the shared ARCHITECTURE pass (spec "Integration
 * layer"; §5 the org chart; §0.6 "robustness is external").
 *
 * WHY this step exists (the real-qwen finding it fixes): when every division's
 * manager plans in isolation, the plan is a "federation of siloed backlogs" —
 * ZERO cross-division dependencies (a manager can't see other divisions' contract
 * ids) and SILENT semantic duplication (three divisions each build a start-menu
 * at three different file paths, so the exact-string slot detector reports
 * "clean"). The spec assumed a dependency DAG but never said HOW a cross-division
 * edge gets created. The fix: a shared architecture, produced UP FRONT by a lead
 * architect, that all divisions build against.
 *
 * This module ships the three pure pieces of that step (it runs on the
 * `intelligent` tier — {@link ROLE_TIER}.architect — thinking-off like the
 * manager, since it emits structured JSON — {@link ROLE_THINKING}.architect):
 *
 *  - {@link ARCHITECT_PROMPT} — the lead-architect SYSTEM prompt.
 *  - {@link buildArchitectPrompt} — the USER turn (vision + divisions → the exact
 *    {@link Architecture} JSON shape to emit).
 *  - {@link parseArchitecture} — tolerant JSON parse → validated
 *    {@link Architecture}, reusing the salvage/repair spirit of contracts.ts.
 *
 * Nothing here dispatches or schedules; it is the architect's authoring step
 * only. The managers are then seeded with the result (contracts.ts
 * `buildManagerContractPrompt`) and the cross-division handles are resolved at
 * assembly (integrate.ts).
 */

import { deliveryConstraintLines, deriveDeliveryShape } from './delivery.js';
import {
  type Architecture,
  type InterfaceHandle,
  isInterfaceHandle,
  isModuleEntry,
  type ModuleEntry,
} from './org-chart.js';
import type { HierarchyDivisionSpec } from './promotion.js';

/**
 * The lead-architect SYSTEM prompt. Deliberately concise: it establishes the
 * disposition and the two deliverables (the module map + the interface seams),
 * not task detail — that arrives in {@link buildArchitectPrompt}. Pairs with the
 * `intelligent` tier and thinking-off (structured JSON output).
 */
export const ARCHITECT_PROMPT = `You are the lead architect of this project. You run once, up front, before any division writes a line of code — and everything they build lands inside the structure you define here. You do not write code or contracts; you define the shared shape the whole corporation builds against.

You produce exactly two things:
- The canonical MODULE MAP: the directory layout of the project, carved into regions — ONE clear area per division, with NO overlaps. Each region is a DIRECTORY (e.g. "src/engine/", "src/assets/"), NOT a single file: a division owns that directory namespace and fills it with MANY files. Give every division one directory region (a couple only if it genuinely spans distinct areas); no two divisions own the same path. This is the single source of truth for where work goes, so a division never has to invent its own structure (and two divisions can never each build the same thing at different paths).
- The key typed INTERFACES: the seams where one division's work is consumed by another. For each, name it, say which division exposes it, at which specific FILE path (a file inside that division's directory region), a one-line typed summary of what it provides, and which divisions consume it. Expose only the genuine cross-division seams — the handful of contracts that other divisions truly depend on — not every internal detail.

Account for how it all RUNS. The product needs a single runnable ENTRY that wires every division's exposed interface together into the actual working product — for a web artifact the root index.html (plus whatever it mounts), otherwise a top-level src/main entry. Treat that entry as a dedicated FINAL INTEGRATION step that CONSUMES the interfaces: do not fold it into a feature division's region, and do not let a feature division claim the root entry. The divisions build the modules; the entry makes them a product that opens and runs.

Keep it small and concrete. A tight map of real regions and a few real interfaces beats an exhaustive one. Use the exact division names you are given.`;

/**
 * Build the architect's USER turn: the vision + the divisions (name + purpose)
 * and the exact {@link Architecture} JSON shape to emit. Pairs with
 * {@link ARCHITECT_PROMPT}. Pure string composition.
 *
 * DELIVERY CONSTRAINT (spec §5/§8): when the vision demands a single openable
 * artifact with no build step (a browser opens it directly), the constraint is
 * derived from the vision text (delivery.ts) and spliced in, so the architect
 * steers toward a SELF-CONTAINED openable entry instead of a bundler-dependent
 * module graph that can never open directly. A neutral vision splices nothing, so
 * the output is unchanged for it.
 */
export function buildArchitectPrompt(
  vision: string,
  divisions: readonly HierarchyDivisionSpec[],
): string {
  const divisionLines = divisions.map((d) => `- ${d.name}: ${d.purpose}`).join('\n');
  const names = divisions.map((d) => d.name).join(', ');
  const deliveryLines = deliveryConstraintLines(deriveDeliveryShape(vision));
  return [
    'Define the shared architecture this project is built against.',
    '',
    `Overall vision:\n${vision.trim()}`,
    ...(deliveryLines.length > 0 ? ['', ...deliveryLines] : []),
    '',
    'Divisions (use these exact names for every "owner", "exposedBy", and "consumedBy" value):',
    divisionLines,
    '',
    'Lay out the canonical module map — one clear DIRECTORY region per division, no two divisions sharing a path — and the key typed interfaces one division exposes for others to consume. Keep it small and concrete.',
    '',
    'Output ONLY a JSON object (no prose, no code fence) with exactly these two fields:',
    '- "moduleMap": an array where each element is { "path": string (a canonical DIRECTORY ending in "/", e.g. "src/game/" — a namespace the division fills with many files, NOT a single file), "owner": string (one of the division names above), "purpose": string (what lives here) }. Give every division one directory region (a couple only if it truly spans distinct areas); never let two regions share a path.',
    '- "interfaces": an array where each element is { "name": string (the handle other divisions reference, e.g. "GameState"), "exposedBy": string (the division that produces it), "path": string (the specific FILE where it is produced, inside that division\'s directory region, e.g. "src/game/state.ts"), "summary": string (one-line typed description), "consumedBy": string[] (the divisions that depend on it) }. Include only the genuine cross-division seams.',
    '',
    `Remember: "owner", "exposedBy", and every "consumedBy" entry MUST be one of these exact division names: ${names}.`,
    '',
    'Output the single JSON object, then STOP and close it.',
  ].join('\n');
}

/** Strip the ```lang fences (open + any close) a small model wraps its JSON in. */
function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9]*\s*\n?/g, '').replace(/```/g, '');
}

/**
 * Extract the first balanced JSON object `{…}` from `text`, tolerant of ```json
 * fences and surrounding prose. String-aware balanced-brace scan (the same
 * approach as the contract array extractor). Returns `undefined` when no closed
 * object is present — the caller then attempts a lenient repair.
 *
 * Re-synchronization (the real-qwen defect, mirrored from contracts.ts
 * `salvageTopLevelObjects`): a raw newline/CR is illegal inside a JSON string, so
 * hitting one while `inString` is proof the closing quote was dropped. We treat
 * the newline as the string's end and re-sync the brace scan, so an unterminated
 * value cannot swallow the object's closing `}` and desync the whole extract —
 * the balanced region is still found, and {@link repairUnterminatedStrings} then
 * closes the string before `JSON.parse`.
 */
function extractJsonObject(text: string): string | undefined {
  const unfenced = stripFences(text);
  const start = unfenced.indexOf('{');
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
      else if (ch === '\n' || ch === '\r') inString = false; // dropped closing quote → re-sync
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return unfenced.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Lenient repair of a JSON fragment whose string(s) a small model left
 * unterminated by dropping the closing quote — so a raw newline (illegal in a
 * JSON string) sits inside, making `JSON.parse` throw. Inserts the missing `"`
 * at the first raw newline of each open string. Pure, never throws; mirrors the
 * same rung in contracts.ts (reimplemented locally so the harness carries no
 * dependency on the provider build).
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

/** First present array among the given keys of `obj` (else `[]`). */
function firstArray(obj: Record<string, unknown>, keys: readonly string[]): unknown[] {
  for (const key of keys) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** First present string among the given keys of `obj` (trimmed; else `undefined`). */
function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Normalize one decoded module-map element into {@link ModuleEntry} shape,
 * tolerating the field-name variants a small model tends to use (`division` for
 * `owner`, `slot`/`file`/`dir` for `path`, `description`/`summary` for
 * `purpose`). Returns `undefined` when a required field is genuinely absent.
 */
function normalizeModuleEntry(raw: unknown): ModuleEntry | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const candidate = {
    path: firstString(obj, ['path', 'slot', 'file', 'dir', 'directory']),
    owner: firstString(obj, ['owner', 'division', 'ownedBy']),
    purpose: firstString(obj, ['purpose', 'description', 'summary']),
  };
  return isModuleEntry(candidate) ? candidate : undefined;
}

/**
 * Normalize one decoded interface element into {@link InterfaceHandle} shape,
 * tolerating field-name variants (`producedBy`/`owner`/`division` for
 * `exposedBy`, `slot` for `path`, `description` for `summary`, `consumers` for
 * `consumedBy`) and defaulting `consumedBy` to `[]`. Returns `undefined` when a
 * required field is genuinely absent.
 */
function normalizeInterfaceHandle(raw: unknown): InterfaceHandle | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const consumedByRaw = firstArray(obj, ['consumedBy', 'consumers', 'consumedByDivisions']);
  const candidate = {
    name: firstString(obj, ['name', 'id']),
    exposedBy: firstString(obj, ['exposedBy', 'producedBy', 'owner', 'division']),
    path: firstString(obj, ['path', 'slot', 'file']),
    summary: firstString(obj, ['summary', 'description', 'purpose']),
    consumedBy: consumedByRaw.filter((x): x is string => typeof x === 'string'),
  };
  return isInterfaceHandle(candidate) ? candidate : undefined;
}

/** Collect + validate decoded elements into a {@link ModuleEntry}[] (invalid dropped). */
function collectModules(elements: readonly unknown[]): ModuleEntry[] {
  const out: ModuleEntry[] = [];
  for (const el of elements) {
    const m = normalizeModuleEntry(el);
    if (m !== undefined) out.push(m);
  }
  return out;
}

/** Collect + validate decoded elements into an {@link InterfaceHandle}[] (invalid dropped). */
function collectInterfaces(elements: readonly unknown[]): InterfaceHandle[] {
  const out: InterfaceHandle[] = [];
  for (const el of elements) {
    const h = normalizeInterfaceHandle(el);
    if (h !== undefined) out.push(h);
  }
  return out;
}

/** The empty architecture — the tolerant fallback when nothing usable parses. */
const EMPTY_ARCHITECTURE: Architecture = { moduleMap: [], interfaces: [] };

function shapeArchitecture(decoded: unknown): Architecture {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return EMPTY_ARCHITECTURE;
  }
  const obj = decoded as Record<string, unknown>;
  return {
    moduleMap: collectModules(firstArray(obj, ['moduleMap', 'modules', 'files'])),
    interfaces: collectInterfaces(firstArray(obj, ['interfaces', 'interfaceHandles', 'seams'])),
  };
}

/**
 * Parse an architect reply into a validated {@link Architecture}. Tolerant of
 * fences / prose around the object and of the field-name variants a small model
 * uses; every element is validated ({@link isModuleEntry} / {@link isInterfaceHandle})
 * and invalid ones are dropped. Never throws — returns an empty architecture
 * (`{ moduleMap: [], interfaces: [] }`) when nothing usable is present.
 *
 * Two paths mirror contracts.ts: a fast path when the whole `{…}` object is
 * present and parses, and a lenient-repair path (close an unterminated string at
 * its raw newline, spec §10) when the extracted object fails to JSON.parse.
 */
export function parseArchitecture(text: string): Architecture {
  const region = extractJsonObject(text);
  if (region === undefined) return EMPTY_ARCHITECTURE;
  try {
    return shapeArchitecture(JSON.parse(region));
  } catch {
    // Balanced braces but invalid JSON inside — most often an unterminated
    // string closed by a raw newline. One lenient repair pass, then give up.
    try {
      return shapeArchitecture(JSON.parse(repairUnterminatedStrings(region)));
    } catch {
      return EMPTY_ARCHITECTURE;
    }
  }
}
