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

/** JSON-Schema-shaped view of a TypeBox tool parameter schema. */
export interface ToolSchemaLike {
  readonly type?: string;
  readonly properties?: Record<string, { type?: string } | undefined>;
  readonly required?: readonly string[];
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

/**
 * Lightweight structural validation against a TypeBox/JSON-Schema-shaped tool
 * schema: presence of `required` props + a loose type check on declared props.
 * Dependency-free (no typebox runtime); sufficient for the rung-2 gate.
 */
export function validateAgainstSchema(
  value: Record<string, unknown>,
  schema: ToolSchemaLike | undefined,
): ValidationResult {
  if (schema === undefined) return { valid: true, errors: [] };
  const errors: string[] = [];

  for (const key of schema.required ?? []) {
    if (!(key in value) || value[key] === undefined) {
      errors.push(`missing required property "${key}"`);
    }
  }
  if (schema.properties !== undefined) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (propSchema?.type === undefined || !(key in value)) continue;
      const actual = JSON_TYPE_OF(value[key]);
      const expected = propSchema.type;
      // integer satisfies number; number does not satisfy integer.
      const ok =
        actual === expected ||
        (expected === 'number' && actual === 'integer') ||
        (expected === 'integer' && actual === 'integer');
      if (!ok) errors.push(`property "${key}" should be ${expected} but is ${actual}`);
    }
  }
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
