/**
 * Tool-call argument repair ladder.
 *
 * Local models frequently emit slightly-malformed tool-call JSON: wrapped in a
 * ```json fence, truncated mid-string, trailing commas, missing closers. This
 * module owns the first two rungs of the harness's repair ladder:
 *
 *   RUNG 1 — syntactic repair: strip fences, extract the JSON region, drop
 *            trailing commas, terminate dangling strings, balance braces.
 *   RUNG 2 — schema validation of the repaired args against the tool's
 *            parameter schema (from streamSimple's `context.tools`); on failure,
 *            ONE optional fixer-model call (injectable so tests run without a
 *            live model).
 *
 * Rungs 3–5 live in packages/harness (W5). This file exposes the seams they
 * extend: the `RepairRung`/`RepairContext`/`RepairResult` types and the
 * `extraRungs` hook on {@link repairToolCallArguments}, which run in order after
 * rung 2 with full access to the raw string, tool name, and schema.
 */

/**
 * JSON-Schema-shaped view of a TypeBox tool parameter schema.
 *
 * Deliberately a *loose* structural mirror of the JSON Schema a TypeBox
 * `Type.Object(...)` emits — enough for the dependency-free rung-2 validator
 * ({@link validateAgainstSchema}) to check the constraints local models most
 * often violate: required/typed props, unknown props under `additionalProperties:
 * false`, nested object/array shape, enums (JSON-Schema `enum`, or TypeBox's
 * `anyOf` of `const` for unions), and simple string/number/array bounds.
 */
export interface ToolSchemaLike {
  readonly type?: string;
  /** Nested schemas are recursive so object/array shape is validated deeply. */
  readonly properties?: Record<string, ToolSchemaLike | undefined>;
  readonly required?: readonly string[];
  /** JSON-Schema `additionalProperties: false` → unknown props are flagged. */
  readonly additionalProperties?: boolean;
  /** Element schema for `type: "array"`. */
  readonly items?: ToolSchemaLike;
  /** Allowed values (JSON-Schema enum). */
  readonly enum?: readonly unknown[];
  /** Union branches (TypeBox emits literal unions as `anyOf` of `const`). */
  readonly anyOf?: readonly ToolSchemaLike[];
  /** Single allowed literal (TypeBox `Type.Literal`). */
  readonly const?: unknown;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface RepairContext {
  /** Accumulated (possibly malformed) tool-call arguments string. */
  readonly raw: string;
  readonly toolName: string;
  readonly schema: ToolSchemaLike | undefined;
  /** 1-based rung index this rung represents. */
  readonly rung: number;
  /** Best repaired value produced by an earlier rung, if any. */
  readonly current: Record<string, unknown> | undefined;
}

export interface RepairResult {
  readonly ok: boolean;
  readonly value?: Record<string, unknown>;
  /** Which rung produced the successful value (1 = syntactic, 2 = schema/fixer). */
  readonly rung?: number;
  readonly error?: string;
}

export type RepairRung = (ctx: RepairContext) => RepairResult | Promise<RepairResult>;

/** One fixer-model call for rung 2 — injectable/optional so it's testable. */
export type ToolCallFixer = (input: {
  readonly raw: string;
  readonly toolName: string;
  readonly schema: ToolSchemaLike | undefined;
  readonly error: string;
}) => Promise<Record<string, unknown> | undefined>;

// --- RUNG 1: syntactic repair ---------------------------------------------

/** Remove a surrounding ```json … ``` (or bare ```) code fence. */
export function stripCodeFences(input: string): string {
  const trimmed = input.trim();
  const fence = /^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$/;
  const m = fence.exec(trimmed);
  return m?.[1] !== undefined ? m[1].trim() : trimmed;
}

/** Extract the first balanced `{…}` (or `[…]`) region, ignoring surrounding prose. */
export function extractJsonRegion(input: string): string {
  const start = input.search(/[{[]/);
  if (start === -1) return input.trim();
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  // Never closed (truncated) — return the remainder so balanceJson can close it.
  return input.slice(start).trim();
}

/**
 * Balance an unterminated JSON fragment: close a dangling string, strip a
 * trailing comma, and append the missing `}`/`]` closers in the right order.
 */
export function balanceJson(input: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let out = input;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // A dangling escape can't be completed meaningfully — drop it.
  if (escaped) out = out.slice(0, -1);
  // Close an open string literal.
  if (inString) out += '"';
  // Remove a trailing comma (possibly followed by whitespace) before closers.
  out = out.replace(/,\s*$/, '');
  // Append closers for still-open containers, innermost first.
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === '{' ? '}' : ']';
  }
  return out;
}

/**
 * Rung 1: attempt to recover a JSON object from a malformed tool-call string.
 * Returns the parsed object, or undefined if it's unrecoverable syntactically.
 */
export function repairToolCallJson(raw: string): Record<string, unknown> | undefined {
  const candidates: string[] = [];
  const cleaned = extractJsonRegion(stripCodeFences(raw));
  candidates.push(raw.trim(), cleaned, cleaned.replace(/,(\s*[}\]])/g, '$1'), balanceJson(cleaned));

  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

// --- RUNG 2: schema validation --------------------------------------------

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const JSON_TYPE_OF = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
};

/** integer satisfies number; number does not satisfy integer. */
function typeMatches(actual: string, expected: string): boolean {
  return (
    actual === expected ||
    (expected === 'number' && actual === 'integer') ||
    (expected === 'integer' && actual === 'integer')
  );
}

/** Structural equality good enough for enum/const literals (primitives + plain data). */
function literalEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Recursively validate a value against a {@link ToolSchemaLike}. `path` is the
 * human-readable location for error messages (`''` at the root). Returns the list
 * of constraint violations (empty ⇒ valid). Dependency-free — no typebox runtime.
 */
function validateValue(value: unknown, schema: ToolSchemaLike | undefined, path: string): string[] {
  const errors: string[] = [];
  if (schema === undefined) return errors;
  const at = path === '' ? '' : `property "${path}": `;
  const label = path === '' ? 'value' : `property "${path}"`;

  // Union (TypeBox literal unions, or any `anyOf`): pass if ANY branch validates.
  // TypeBox emits unions as anyOf-only schemas, so this is terminal for them.
  if (schema.anyOf !== undefined && schema.anyOf.length > 0) {
    const ok = schema.anyOf.some((branch) => validateValue(value, branch, path).length === 0);
    if (!ok) errors.push(`${label} does not match any allowed variant`);
    return errors;
  }

  // Single literal.
  if (Object.hasOwn(schema, 'const') && !literalEquals(value, schema.const)) {
    errors.push(`${label} must equal ${JSON.stringify(schema.const)}`);
  }

  // Enum membership.
  if (schema.enum !== undefined && schema.enum.length > 0) {
    if (!schema.enum.some((e) => literalEquals(e, value))) {
      errors.push(
        `${label} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`,
      );
    }
  }

  const actual = JSON_TYPE_OF(value);
  if (schema.type !== undefined && !typeMatches(actual, schema.type)) {
    errors.push(`${label} should be ${schema.type} but is ${actual}`);
    return errors; // wrong container type → deeper constraints are meaningless
  }

  // Object shape.
  if (actual === 'object' && (schema.type === 'object' || schema.type === undefined)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push(`${at}missing required property "${key}"`);
      }
    }
    if (schema.properties !== undefined) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (propSchema === undefined || !(key in obj) || obj[key] === undefined) continue;
        errors.push(...validateValue(obj[key], propSchema, path === '' ? key : `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties));
        for (const key of Object.keys(obj)) {
          if (!allowed.has(key)) errors.push(`${label} has unknown property "${key}"`);
        }
      }
    }
  }

  // Array shape.
  if (actual === 'array' && schema.type === 'array') {
    const arr = value as unknown[];
    if (schema.minItems !== undefined && arr.length < schema.minItems) {
      errors.push(`${label} must have at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
      errors.push(`${label} must have at most ${schema.maxItems} item(s)`);
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < arr.length; i++) {
        errors.push(...validateValue(arr[i], schema.items, `${path}[${i}]`));
      }
    }
  }

  // String bounds.
  if (typeof value === 'string' && schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${label} must be at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${label} must be at most ${schema.maxLength} character(s)`);
    }
  }

  // Numeric bounds.
  if (typeof value === 'number' && (schema.type === 'number' || schema.type === 'integer')) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${label} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${label} must be <= ${schema.maximum}`);
    }
  }

  return errors;
}

/**
 * Validate repaired tool-call arguments against the tool's parameter schema.
 *
 * Deeper than a top-level presence/type check: it recurses into nested
 * object/array shape, flags unknown props under `additionalProperties: false`,
 * and checks enums (incl. TypeBox `anyOf`/`const` unions) and simple
 * string/number/array bounds. Every violation is surfaced as an error string,
 * which the rung-2 fixer path feeds verbatim to the utility model so it can
 * correct the specific problem. Dependency-free (no typebox runtime).
 */
export function validateAgainstSchema(
  value: Record<string, unknown>,
  schema: ToolSchemaLike | undefined,
): ValidationResult {
  if (schema === undefined) return { valid: true, errors: [] };
  const errors = validateValue(value, schema, '');
  return { valid: errors.length === 0, errors };
}

// --- Ladder orchestration --------------------------------------------------

export interface RepairPipelineOptions {
  readonly toolName: string;
  readonly schema?: ToolSchemaLike;
  /** Rung 2 fixer-model call; when omitted rung 2 only validates. */
  readonly fixer?: ToolCallFixer;
  /** W5 rungs 3–5, run in order after rung 2 if still unresolved. */
  readonly extraRungs?: readonly RepairRung[];
}

/**
 * Run the repair ladder over a malformed tool-call arguments string.
 *
 * Order: rung 1 (syntactic) → rung 2 (schema validate, then one fixer call) →
 * any injected extra rungs (W5). Returns the first successful result, or the
 * last failure.
 */
export async function repairToolCallArguments(
  raw: string,
  opts: RepairPipelineOptions,
): Promise<RepairResult> {
  const { toolName, schema, fixer, extraRungs = [] } = opts;

  // RUNG 1 — syntactic recovery.
  const syntactic = repairToolCallJson(raw);

  // RUNG 2 — schema validation of the rung-1 value.
  if (syntactic !== undefined) {
    const validation = validateAgainstSchema(syntactic, schema);
    if (validation.valid) {
      // If there was no schema we can only claim syntactic (rung 1) success.
      return { ok: true, value: syntactic, rung: schema === undefined ? 1 : 2 };
    }
    // Invalid → one fixer-model call.
    if (fixer !== undefined) {
      const fixed = await fixer({ raw, toolName, schema, error: validation.errors.join('; ') });
      if (fixed !== undefined && validateAgainstSchema(fixed, schema).valid) {
        return { ok: true, value: fixed, rung: 2 };
      }
    }
  } else if (fixer !== undefined) {
    // Rung 1 couldn't recover anything; let the fixer try the raw string.
    const fixed = await fixer({ raw, toolName, schema, error: 'unparseable tool-call arguments' });
    if (fixed !== undefined && validateAgainstSchema(fixed, schema).valid) {
      return { ok: true, value: fixed, rung: 2 };
    }
  }

  // RUNGS 3–5 (W5) — injected extra rungs.
  let current = syntactic;
  for (let i = 0; i < extraRungs.length; i++) {
    const rung = extraRungs[i];
    if (rung === undefined) continue;
    const result = await rung({ raw, toolName, schema, rung: 3 + i, current });
    if (result.ok && result.value !== undefined) return result;
    if (result.value !== undefined) current = result.value;
  }

  return {
    ok: false,
    value: syntactic,
    error: syntactic === undefined ? 'unrecoverable tool-call JSON' : 'schema validation failed',
  };
}

// --- Fuzzy tool-name matching ----------------------------------------------

/** Default normalized-similarity threshold above which a fuzzy name is accepted. */
export const DEFAULT_TOOL_NAME_MATCH_THRESHOLD = 0.72;

/** Canonicalize a tool name for comparison: lowercase, strip non-alphanumerics. */
export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Levenshtein edit distance (iterative, single-row DP). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1, // deletion
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j - 1] ?? 0) + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

/**
 * Normalized name similarity in [0, 1]: `1 - editDistance / maxLen` over the
 * normalized names. 1 = identical after normalization (case/punctuation only).
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeToolName(a);
  const nb = normalizeToolName(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  return 1 - editDistance(na, nb) / Math.max(na.length, nb.length);
}

/**
 * Map an unknown/misspelled tool name to the nearest REGISTERED tool by
 * normalized edit-distance, but only when the best match clears `threshold`.
 * Returns the registered name + its score, or undefined (→ leave the call to the
 * existing "tool not found" path). A name that differs only in case/punctuation
 * scores 1 and always matches.
 */
export function fuzzyMatchToolName(
  name: string,
  registered: readonly string[],
  threshold: number = DEFAULT_TOOL_NAME_MATCH_THRESHOLD,
): { name: string; score: number } | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const candidate of registered) {
    const score = nameSimilarity(name, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best !== undefined && bestScore >= threshold
    ? { name: best, score: bestScore }
    : undefined;
}

// --- Rung 4 support: per-session schema relaxation -------------------------

/**
 * Produce a maximally-permissive schema for a tool whose strict schema keeps
 * rejecting otherwise-usable arguments. The relaxed schema accepts ANY object
 * (no `required`, no per-prop types/constraints, `additionalProperties` allowed),
 * so a later call the harness stores this against validates cleanly at rung 2.
 * Pure — the harness owns WHEN to relax and WHERE to store the result.
 */
export function relaxToolSchema(_schema: ToolSchemaLike | undefined): ToolSchemaLike {
  return { type: 'object', additionalProperties: true };
}

// --- RUNG 0: text-content tool-call reconstructor --------------------------

/** How a reconstructed call was written in the assistant's content. */
export type ReconstructedShape =
  | 'envelope-json'
  | 'function-tag'
  | 'name-tag'
  | 'paren-call'
  | 'prose-json';

export interface ReconstructedToolCall {
  /** The REGISTERED tool name the written call resolved to. */
  readonly toolName: string;
  /** The name exactly as written in the content (may differ in case/punctuation). */
  readonly rawName: string;
  /** Raw argument text, fed to the repair ladder exactly like a malformed frame. */
  readonly argsText: string;
  /** Parsed arguments (the guard requires these to parse before reconstructing). */
  readonly arguments: Record<string, unknown>;
  readonly shape: ReconstructedShape;
}

/** Keys a text tool-call envelope uses to name the tool. */
const ENVELOPE_NAME_KEYS = [
  'name',
  'tool',
  'tool_name',
  'toolName',
  'function',
  'function_name',
  'recipient_name',
];
/** Keys a text tool-call envelope uses to carry the arguments. */
const ENVELOPE_ARG_KEYS = [
  'arguments',
  'args',
  'parameters',
  'params',
  'input',
  'tool_input',
  'function_arguments',
];

/** Scan text for every top-level balanced `{…}` object substring (string-aware). */
function scanJsonObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i++;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let j = i;
    let closed = false;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          closed = true;
          break;
        }
      }
    }
    i = closed ? j + 1 : i + 1;
  }
  return out;
}

/** Coerce an envelope's arguments value (object or JSON string) into args. */
function coerceArgs(
  value: unknown,
): { argsText: string; arguments: Record<string, unknown> } | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { argsText: JSON.stringify(value), arguments: value as Record<string, unknown> };
  }
  if (typeof value === 'string') {
    const parsed = repairToolCallJson(value);
    if (parsed !== undefined) return { argsText: value, arguments: parsed };
  }
  return undefined;
}

/** Resolve a written name to a registered tool by EXACT normalized match. */
function resolveRegistered(rawName: string, registered: readonly string[]): string | undefined {
  const norm = normalizeToolName(rawName);
  if (norm.length === 0) return undefined;
  return registered.find((r) => normalizeToolName(r) === norm);
}

/** Build a reconstructed call if the name resolves + args parse, else undefined. */
function reconstruct(
  rawName: string,
  argsText: string | undefined,
  parsedArgs: Record<string, unknown> | undefined,
  registered: readonly string[],
  shape: ReconstructedShape,
): ReconstructedToolCall | undefined {
  const toolName = resolveRegistered(rawName, registered);
  if (toolName === undefined) return undefined;
  if (parsedArgs !== undefined) {
    return {
      toolName,
      rawName,
      argsText: argsText ?? JSON.stringify(parsedArgs),
      arguments: parsedArgs,
      shape,
    };
  }
  if (argsText === undefined) return undefined;
  const parsed = repairToolCallJson(argsText);
  if (parsed === undefined) return undefined;
  return { toolName, rawName, argsText, arguments: parsed, shape };
}

/** Strategy A — a JSON envelope `{name|tool|function: …, arguments|args|…: {…}}`. */
function fromEnvelope(
  content: string,
  registered: readonly string[],
): ReconstructedToolCall | undefined {
  for (const objText of scanJsonObjects(content)) {
    const parsed = repairToolCallJson(objText);
    if (parsed === undefined) continue;

    let rawName: string | undefined;
    let argsValue: unknown;
    let hasArgKey = false;

    // OpenAI-style nested `function: { name, arguments }`.
    const fn = parsed.function;
    if (fn !== null && typeof fn === 'object' && !Array.isArray(fn)) {
      const f = fn as Record<string, unknown>;
      if (typeof f.name === 'string') rawName = f.name;
      if ('arguments' in f) {
        argsValue = f.arguments;
        hasArgKey = true;
      }
    }
    if (rawName === undefined) {
      for (const k of ENVELOPE_NAME_KEYS) {
        if (typeof parsed[k] === 'string') {
          rawName = parsed[k] as string;
          break;
        }
      }
    }
    if (!hasArgKey) {
      for (const k of ENVELOPE_ARG_KEYS) {
        if (k in parsed) {
          argsValue = parsed[k];
          hasArgKey = true;
          break;
        }
      }
    }
    if (rawName === undefined) continue;

    let args: { argsText: string; arguments: Record<string, unknown> } | undefined;
    if (hasArgKey) {
      args = coerceArgs(argsValue);
    } else if (Object.keys(parsed).every((k) => ENVELOPE_NAME_KEYS.includes(k))) {
      // A bare call envelope like `{"name":"get_time"}` — no args key, and no
      // stray data keys → treat as a no-argument call. Guards against arbitrary
      // JSON that merely happens to carry a "name" field.
      args = { argsText: '{}', arguments: {} };
    }
    if (args === undefined) continue;

    const built = reconstruct(rawName, args.argsText, args.arguments, registered, 'envelope-json');
    if (built !== undefined) return built;
  }
  return undefined;
}

/**
 * Parse Hermes/Qwen-style `<parameter=KEY>VALUE</parameter>` (or
 * `<parameter name="KEY">VALUE</parameter>`) argument tags out of a
 * `<function=NAME>…</function>` body into an args object. This is the shape a qwen
 * chat template emits when its tool-call grammar fails and the whole call lands in
 * assistant CONTENT instead of a structured `tool_calls` frame — e.g.
 * `<function=web_fetch><parameter=url>https://x/</parameter></function>`. The
 * inline-JSON path ({@link scanJsonObjects}) can't see these values, so WITHOUT
 * this the call reconstructs with EMPTY args (the url/path/body is lost). Values
 * are captured verbatim and trimmed of the surrounding whitespace the template
 * pads them with; they are deliberately NOT JSON-coerced (a url / path / file body
 * stays a string — the downstream schema + fixer ladder handles any numeric or
 * boolean coercion, and coercing here would corrupt a JSON-valued file body).
 * Returns undefined when the body carries no `<parameter …>` tag, so the caller
 * falls back to JSON scanning (and the pre-existing `<function=NAME>{…}</function>`
 * behavior is unchanged).
 */
function parseParameterTags(body: string): Record<string, unknown> | undefined {
  const re =
    /<parameter(?:\s*=\s*|\s+name\s*=\s*)["']?([a-zA-Z0-9_.-]+)["']?\s*>([\s\S]*?)<\/parameter\s*>/g;
  const args: Record<string, unknown> = {};
  let found = false;
  for (const m of body.matchAll(re)) {
    const key = m[1];
    const value = m[2];
    if (key === undefined || value === undefined) continue;
    args[key] = value.trim();
    found = true;
  }
  return found ? args : undefined;
}

/**
 * Strategy B1 — `<function=NAME>…</function>` (Llama/Qwen tag). Handles BOTH an
 * inline JSON body (`{…}`) and Hermes/Qwen `<parameter=KEY>VALUE</parameter>` arg
 * tags ({@link parseParameterTags}).
 */
function fromFunctionTag(
  content: string,
  registered: readonly string[],
): ReconstructedToolCall | undefined {
  const re = /<function\s*=\s*["']?([a-zA-Z0-9_.-]+)["']?\s*>([\s\S]*?)<\/function>/g;
  for (const m of content.matchAll(re)) {
    const rawName = m[1];
    const body = m[2];
    if (rawName === undefined || body === undefined) continue;
    // Prefer explicit <parameter=…> tags: they are unambiguous, and reading them
    // FIRST avoids mis-parsing a brace inside a code-valued parameter (e.g. a
    // `write` whose content is TS with `{…}`) as the args JSON via scanJsonObjects.
    const paramArgs = parseParameterTags(body);
    if (paramArgs !== undefined) {
      const built = reconstruct(
        rawName,
        JSON.stringify(paramArgs),
        paramArgs,
        registered,
        'function-tag',
      );
      if (built !== undefined) return built;
    }
    // Else an inline JSON object `<function=NAME>{…}</function>`.
    const objText = scanJsonObjects(body)[0];
    const built = reconstruct(
      rawName,
      objText ?? '{}',
      objText === undefined ? {} : undefined,
      registered,
      'function-tag',
    );
    if (built !== undefined) return built;
  }
  return undefined;
}

/** Strategy B2 — `<NAME>{…}</NAME>` where NAME is a registered tool. */
function fromNameTag(
  content: string,
  registered: readonly string[],
): ReconstructedToolCall | undefined {
  for (const tool of registered) {
    const esc = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<${esc}\\s*>([\\s\\S]*?)</${esc}\\s*>`);
    const m = re.exec(content);
    if (m?.[1] === undefined) continue;
    const objText = scanJsonObjects(m[1])[0];
    if (objText === undefined) continue;
    const built = reconstruct(tool, objText, undefined, registered, 'name-tag');
    if (built !== undefined) return built;
  }
  return undefined;
}

/** Strategy C — `NAME({…})` or `NAME()` paren-style call. */
function fromParenCall(
  content: string,
  registered: readonly string[],
): ReconstructedToolCall | undefined {
  const re = /([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\(\s*(\{[\s\S]*?\})?\s*\)/g;
  for (const m of content.matchAll(re)) {
    const rawName = m[1];
    if (rawName === undefined) continue;
    const objText = m[2];
    const built =
      objText === undefined
        ? reconstruct(rawName, '{}', {}, registered, 'paren-call')
        : reconstruct(rawName, objText, undefined, registered, 'paren-call');
    if (built !== undefined) return built;
  }
  return undefined;
}

/** Strategy D — prose: a registered NAME + a call connective + a JSON object. */
function fromProse(
  content: string,
  registered: readonly string[],
): ReconstructedToolCall | undefined {
  for (const tool of registered) {
    const esc = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // NAME <connective> { … } — the connective (with/:/=/->/→) is what separates
    // an actual call from prose that merely names the tool near some braces.
    const re = new RegExp(`\\b${esc}\\b\\s*(?:with|:|=|->|→)\\s*(\\{)`, 'i');
    const m = re.exec(content);
    if (m?.index === undefined) continue;
    const bracePos = content.indexOf('{', m.index);
    if (bracePos === -1) continue;
    const objText = scanJsonObjects(content.slice(bracePos))[0];
    if (objText === undefined) continue;
    const built = reconstruct(tool, objText, undefined, registered, 'prose-json');
    if (built !== undefined) return built;
  }
  return undefined;
}

/**
 * RUNG 0 — reconstruct a tool call the model wrote into its assistant CONTENT as
 * prose/markdown instead of a structured `tool_calls` frame (the biggest gap in
 * the ladder: such calls never entered it). Pure regex/heuristics, NO model call.
 *
 * Recognizes four written shapes, in order of reliability: a JSON envelope
 * (`{"name":"web_search","arguments":{…}}`, incl. inside a ```json fence or a
 * `<tool_call>` tag), an XML/tag call (`<function=NAME>…` or `<NAME>…</NAME>`), a
 * paren call (`NAME({…})`), and a prose call (`… web_search with {…}`).
 *
 * FALSE-POSITIVE GUARD — reconstruction fires only when ALL hold:
 *   1. a recognizable call SHAPE matched (envelope / tag / paren / connective+JSON),
 *   2. the written name resolves to an EXACTLY REGISTERED tool (normalized), and
 *   3. the arguments PARSE (via rung-1 recovery) to a JSON object.
 * Prose that merely mentions a tool — no call shape, an unregistered name, or no
 * parseable args — returns undefined and is left as plain content.
 */
export function reconstructToolCallFromContent(
  content: string,
  registeredToolNames: readonly string[],
): ReconstructedToolCall | undefined {
  if (content.length === 0 || registeredToolNames.length === 0) return undefined;
  return (
    fromEnvelope(content, registeredToolNames) ??
    fromFunctionTag(content, registeredToolNames) ??
    fromNameTag(content, registeredToolNames) ??
    fromParenCall(content, registeredToolNames) ??
    fromProse(content, registeredToolNames)
  );
}

// --- Written tool-call scaffolding (display salvage) ------------------------
//
// A text-form tool call the model wrote into its CONTENT is wrapped in markup
// tokens — a `<tool_call>` envelope, a `<function=NAME>` tag, Hermes/Qwen
// `<parameter=…>` arg tags. Display code (the corp feed) needs to (a) find the
// COMPLETE region so it can split it out of prose, (b) detect an opener while the
// block is still STREAMING so the half-written scaffolding is suppressed, and
// (c) scrub any orphan token that survives a partial parse. These pure helpers own
// that mechanical parsing; the block-splitting/suppression POLICY lives in the
// caller.

/**
 * The opener of a written tool call: a `<tool_call>` wrapper or a `<function=`
 * tag. A match means a call has STARTED even before it closes.
 */
const TOOL_CALL_OPENER_RE = /<tool_call\s*>|<function\s*=/i;

/**
 * Every standalone tool-call scaffolding token — the `<tool_call>`/`</tool_call>`
 * wrappers, the `<function=…>`/`</function>` tags, and the Hermes/Qwen
 * `<parameter=…>` / `<parameter name="…">` / `</parameter>` arg tags. Used to
 * scrub stray/orphan tokens so none render as literal text.
 */
const TOOL_CALL_SCAFFOLD_RE =
  /<\/?tool_call\s*>|<\/?function(?:\s*=\s*["']?[a-zA-Z0-9_.-]*["']?)?\s*>|<\/?parameter(?:(?:\s*=\s*|\s+name\s*=\s*)["']?[a-zA-Z0-9_.-]*["']?)?\s*>/gi;

/**
 * Index of the first tool-call opener (`<tool_call>` or `<function=`) in `text`,
 * or -1. A non-negative result means a written call has begun — display code
 * suppresses everything from here on while the block is still streaming.
 */
export function findToolCallOpener(text: string): number {
  const m = TOOL_CALL_OPENER_RE.exec(text);
  return m === null ? -1 : m.index;
}

/**
 * Remove every stray tool-call scaffolding token so a `<tool_call>` /
 * `</tool_call>` / `</function>` / `<parameter=…>` never renders as literal text.
 * The tag VALUES (a parameter body, prose between tags) are kept — only the markup
 * tokens are scrubbed. Pure/tolerant; leaves non-scaffolding text untouched.
 */
export function stripToolCallScaffolding(text: string): string {
  return text.replace(TOOL_CALL_SCAFFOLD_RE, '');
}

/**
 * Locate the first COMPLETE written tool-call region in `text`: a
 * `<function=NAME>…</function>` span (optionally trailed by `</tool_call>`) or a
 * `<tool_call>…</tool_call>` wrapper (JSON-form `{"name":…}` or a bare wrapper).
 * Returns the prose `before` it, the `region` markup, and the prose `after` it —
 * or null when there is no complete region (an opener with no matching closer is
 * still streaming, so it is deliberately NOT reported here). Pure; never throws.
 */
export function findWrittenToolCallRegion(
  text: string,
): { before: string; region: string; after: string } | null {
  const open = TOOL_CALL_OPENER_RE.exec(text);
  if (open === null) return null;
  const start = open.index;
  const rest = text.slice(start);
  const isWrapper = rest.slice(0, 12).toLowerCase().startsWith('<tool_call');

  let len: number | null = null;
  if (isWrapper) {
    const wrap = /^<tool_call\s*>[\s\S]*?<\/tool_call\s*>/i.exec(rest);
    if (wrap !== null) {
      len = wrap[0].length;
    } else {
      // Wrapper opened but no `</tool_call>` — accept an inner closed `<function=…>`.
      const fn = /<function\s*=[\s\S]*?<\/function\s*>/i.exec(rest);
      if (fn !== null) len = fn.index + fn[0].length;
    }
  } else {
    const fn = /^<function\s*=[\s\S]*?<\/function\s*>(?:\s*<\/tool_call\s*>)?/i.exec(rest);
    if (fn !== null) len = fn[0].length;
  }
  if (len === null) return null;
  return { before: text.slice(0, start), region: rest.slice(0, len), after: rest.slice(len) };
}
