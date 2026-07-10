/**
 * Rung-2 tool-call fixer, backed by the utility model.
 *
 * When a tool call is parseable-but-schema-invalid (or unparseable), rung 2 asks
 * the utility model to emit corrected arguments as JSON. This is the concrete
 * {@link ToolCallFixer} the harness pushes to the provider's repair ladder. It
 * degrades to `undefined` (skip to rung 3) whenever the model call fails or the
 * reply isn't usable JSON.
 *
 * {@link withRepairAttempts} bounds the retries by the effort slider's
 * `repairAttempts`, so higher effort tries the fixer more times before giving up.
 */

import type { CallModel } from '../model-call/call-model.js';
import type { ToolCallFixer } from './types.js';

/** Strip a ```json fence and parse the first balanced `{…}` object, if any. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const unfenced = text.replace(/```[a-zA-Z0-9]*\s*\n?/g, '').replace(/```/g, '');
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
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(unfenced.slice(start, i + 1)) as unknown;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // fall through — no usable object
        }
        return undefined;
      }
    }
  }
  return undefined;
}

/** Build a {@link ToolCallFixer} that repairs arguments via one utility-model call. */
export function createToolCallFixer(callModel: CallModel): ToolCallFixer {
  return async ({ raw, toolName, schema, error }) => {
    const schemaText = schema !== undefined ? JSON.stringify(schema) : '(no schema provided)';
    const prompt = [
      `The tool "${toolName}" was called with invalid arguments.`,
      `Parameter JSON schema: ${schemaText}`,
      `Invalid arguments: ${raw}`,
      `Validation error: ${error}`,
      'Reply with ONLY the corrected arguments as a single minified JSON object.',
      'No prose, no explanation, no code fence.',
    ].join('\n');
    let text: string;
    try {
      text = await callModel({ prompt, temperature: 0 });
    } catch {
      return undefined;
    }
    return extractJsonObject(text);
  };
}

/**
 * Wrap a fixer so it retries up to `attempts` times (the effort slider's
 * `repairAttempts`), returning the first usable result. `attempts` is clamped to
 * at least 1.
 */
export function withRepairAttempts(fixer: ToolCallFixer, attempts: number): ToolCallFixer {
  const n = Math.max(1, Math.floor(attempts));
  return async (input) => {
    for (let i = 0; i < n; i++) {
      const out = await fixer(input);
      if (out !== undefined) return out;
    }
    return undefined;
  };
}
