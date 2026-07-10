/**
 * Reviewer + adversarial passes (effort high/max).
 *
 * These are the effort-slider's `reviewPasses` / `adversarialChecks` made real.
 * After the agent finishes a turn, a dedicated critique — a SEPARATE utility-
 * model call over the produced output (NOT the permission "reviewer" mode, which
 * gates tool calls and is unrelated) — decides whether the result is sound. If
 * it flags problems, the harness triggers a revision turn.
 *
 * Both passes degrade safely: any model/transport failure or unparseable reply
 * yields `ok: true` (no spurious revision) so a missing utility endpoint never
 * blocks the agent.
 */

import type { CallModel } from '../model-call/call-model.js';

export interface ReviewInput {
  /** The user's task/prompt for the turn under review. */
  readonly task: string;
  /** The agent's produced result text. */
  readonly output: string;
}

export interface ReviewResult {
  /** True when the pass found no blocking problems. */
  readonly ok: boolean;
  /** Concrete problems the pass raised (empty when `ok`). */
  readonly issues: readonly string[];
  /** The raw model reply, for telemetry/debugging. */
  readonly raw: string;
}

const OK_RESULT: ReviewResult = { ok: true, issues: [], raw: '' };

/**
 * Parse a critique reply. Expects `{"ok":boolean,"issues":string[]}` but tolerates
 * extra prose. Anything unparseable → `ok:true` (fail-open).
 */
export function parseReview(raw: string): ReviewResult {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as {
        ok?: unknown;
        issues?: unknown;
      };
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.filter((x): x is string => typeof x === 'string')
        : [];
      const ok = parsed.ok === true || (parsed.ok === undefined && issues.length === 0);
      return { ok, issues: ok ? [] : issues, raw };
    } catch {
      // fall through
    }
  }
  return { ...OK_RESULT, raw };
}

async function runPass(
  callModel: CallModel,
  system: string,
  input: ReviewInput,
): Promise<ReviewResult> {
  const prompt = [
    `Task given to the agent:\n${input.task}`,
    `\nAgent's result:\n${input.output}`,
    '\nReply with ONLY a JSON object: {"ok": boolean, "issues": string[]}.',
    'Set ok=false and list concrete, actionable problems only if the result is wrong,',
    'incomplete, or unsafe. Otherwise ok=true with an empty issues array.',
  ].join('\n');
  let text: string;
  try {
    text = await callModel({ system, prompt, temperature: 0 });
  } catch {
    return OK_RESULT;
  }
  return parseReview(text);
}

/** A code/output reviewer critique of the agent's result. */
export function reviewOutput(callModel: CallModel, input: ReviewInput): Promise<ReviewResult> {
  return runPass(
    callModel,
    "You are a meticulous senior reviewer checking another agent's work for correctness and completeness.",
    input,
  );
}

/** An adversarial verification pass — actively try to find how the result fails. */
export function adversarialCheck(callModel: CallModel, input: ReviewInput): Promise<ReviewResult> {
  return runPass(
    callModel,
    'You are an adversarial red-teamer. Assume the result is flawed and hunt for edge cases, incorrect assumptions, and ways it breaks.',
    input,
  );
}
