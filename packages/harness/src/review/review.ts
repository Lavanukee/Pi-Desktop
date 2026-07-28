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
  /**
   * The conversation the turn ran on — `[system, …turns]`, built the same way
   * the post-turn naming builds it.
   *
   * THIS IS A LATENCY FIELD, not a quality one. The reviewer runs after EVERY
   * turn from `medium` effort up, on the SAME single-slot llama-server the chat
   * uses. Sent as its own `{system: "You are a meticulous senior reviewer…"}`
   * request it diverges from the resident KV at the very first token, so the
   * server evicts the whole conversation to prefill the critique — and the
   * user's NEXT message then re-prefills from scratch. MEASURED on the shipped
   * app: first message 274ms, follow-ups 4015-8096ms. Prefixing the critique
   * with the conversation instead makes it a continuation of what is already
   * resident: it prefills only its own instruction, and leaves the conversation
   * in the slot for the next turn.
   */
  readonly priorMessages?: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[];
  /**
   * The tools the turn ran with, in the SAME order. Chat templates render tools
   * at the START of the prompt, so omitting them diverges the prefix just as
   * surely as a different system message would.
   */
  readonly tools?: readonly { readonly name: string; readonly description?: string; readonly parameters?: unknown }[];
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

/** Enough for `{"ok":false,"issues":[…]}` with several real issues, and nowhere
 * near enough for a monologue that would sit on the slot. */
const MAX_REVIEW_TOKENS = 512;

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
  role: string,
  input: ReviewInput,
): Promise<ReviewResult> {
  const instruction = [
    `${role}`,
    `\nTask given to the agent:\n${input.task}`,
    `\nAgent's result:\n${input.output}`,
    '\nReply with ONLY a JSON object: {"ok": boolean, "issues": string[]}.',
    'Set ok=false and list concrete, actionable problems only if the result is wrong,',
    'incomplete, or unsafe. Otherwise ok=true with an empty issues array.',
  ].join('\n');
  // When the caller supplies the conversation, ride ITS prefix: same system
  // message, same tools, the critique appended as one more user turn. The role
  // instruction moves into that turn — it CANNOT go in the system message,
  // because the system message is the first thing the template renders and any
  // change to it invalidates the entire cached prefix. Without a conversation
  // (a programmatic caller, or before any turn has run) fall back to the
  // standalone shape.
  const request =
    input.priorMessages !== undefined && input.priorMessages.length > 0
      ? {
          messages: input.priorMessages,
          prompt: instruction,
          ...(input.tools !== undefined && input.tools.length > 0 ? { tools: input.tools } : {}),
        }
      : { system: role, prompt: instruction };
  let text: string;
  try {
    text = await callModel({
      ...request,
      temperature: 0,
      // NO reasoning, and a hard token cap. Not a quality decision — a HOLD-TIME
      // one. This pass runs on the same single-slot server the chat uses, so
      // every token it generates is a token the user's next message waits behind.
      // A reasoning model spends seconds thinking before a two-field JSON verdict
      // it could emit immediately; measured, that showed up as an intermittent
      // multi-second TTFT whenever a message landed while the critique was still
      // running. Servers that don't understand the flag just ignore it.
      maxTokens: MAX_REVIEW_TOKENS,
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    });
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
