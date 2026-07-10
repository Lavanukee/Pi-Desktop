/**
 * Tier-2 classifier escalation — a CACHE-REUSING piggyback on the main model.
 *
 * `classifyWithEscalation` accepts an injectable {@link AsyncClassifier}; this
 * builds one from the {@link CallModel} seam. It fires when tier-1 is ambiguous
 * (or is force-run on turn 1 to get a conversation title), and returns
 * `undefined` on any failure so the heuristic result stands (fail-open).
 *
 * ## Why a piggyback (round-10 #8)
 * The old escalation sent a SEPARATE classifier prompt to the same single-slot
 * (`--parallel 1`) llama-server. That prompt shared almost no prefix with the
 * live conversation, so it was itself a cache miss AND — being the only slot —
 * it evicted the conversation's KV, forcing the real turn to reprocess the whole
 * transcript. A double penalty on every ambiguous turn.
 *
 * Instead we send `{ messages: [...live conversation prefix, {short JSON ask}] }`.
 * The prefix (system + full transcript, ending at the current user prompt) is
 * IDENTICAL to what the real turn will process, so the slot's KV for it is
 * primed/kept; only the short instruction + a ~15-token JSON answer are new. When
 * the real turn runs, its longest-common-prefix with the slot is the full
 * transcript → reused. Classification becomes a cache PRE-WARM, not a cost.
 *
 * ## Grammar-constrained {title, class}
 * The output is constrained to `{"title": string, "class": <enum>}` via
 * `response_format: {type:"json_schema", …}` — reachable through the frozen
 * OpenAI-compat seam and compiled to a grammar by llama-server, so even a ~2B
 * model (Gemma 3n E2B) returns a guaranteed-parseable object. Folding the
 * conversation title into the same structured call means turn 1 pays for the
 * title and the class together, on one cache-sharing request.
 *
 * ## App hook
 * Escalation activates automatically once a utility endpoint is configured
 * (`PI_DESKTOP_UTILITY_BASE_URL`, see model-call/call-model.ts) — the same seam
 * the fixer/review use. No separate wiring; absent endpoint ⇒ heuristics only.
 */

import type { CallModel } from '../model-call/call-model.js';
import { type AsyncClassifier, type ClassifyMessage, TASK_CLASSES } from './classify.js';

/** Max characters for the model-produced conversation title. */
const TITLE_MAX_CHARS = 60;

/**
 * Token cap for the reply. The output is a ~15-token JSON object, but a reasoning
 * model may "think" first — this leaves headroom so it still reaches the JSON if
 * thinking isn't suppressed (see {@link NO_THINKING}). It's a cap, not a target:
 * with thinking off the decode stops at the closing brace in a handful of tokens.
 */
const MAX_TOKENS = 512;

/**
 * llama.cpp `chat_template_kwargs` to suppress a reasoning model's thinking pass,
 * so the tiny {title, class} object comes back fast (~350ms vs ~3.2s on Gemma
 * E2B, verified) and well within the utility-call timeout. Servers/templates
 * that don't understand it ignore it, falling back to the {@link MAX_TOKENS}
 * headroom above.
 */
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } } as const;

/**
 * The short instruction appended AFTER the shared conversation prefix. Kept tiny
 * so only a handful of uncached tokens follow the (reused) transcript.
 */
const HEADER_INSTRUCTION = [
  'Before continuing, respond with ONLY a JSON object describing this conversation:',
  `{"title": "<a 3-6 word title>", "class": "<one of: ${TASK_CLASSES.join(', ')}>"}`,
  "Pick the single class that best fits the user's task. Output the JSON object and nothing else.",
].join('\n');

/**
 * A JSON-schema response format constraining the reply to exactly
 * `{title, class}`. llama-server (and other OpenAI-compat servers) compile this
 * to a decoding grammar, guaranteeing a parseable object from a small model.
 */
function titleClassResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'pi_conversation_meta',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', maxLength: TITLE_MAX_CHARS },
          class: { type: 'string', enum: [...TASK_CLASSES] },
        },
        required: ['title', 'class'],
      },
    },
  };
}

interface TitleClass {
  readonly title?: string;
  readonly class?: string;
}

/**
 * Parse `{title, class}` out of the model reply. Tolerates prose around the JSON
 * (a small model may still wrap it) by extracting the first balanced object.
 */
function parseTitleClass(text: string): TitleClass | undefined {
  const raw = extractFirstJsonObject(text);
  if (raw === undefined) return undefined;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : undefined;
    const cls = typeof obj.class === 'string' ? obj.class : undefined;
    return { title: title !== undefined && title.length > 0 ? title : undefined, class: cls };
  } catch {
    return undefined;
  }
}

/** Extract the first balanced `{…}` substring, or undefined. */
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Resolve the model's class string to one of {@link TASK_CLASSES}, else undefined. */
function matchClass(value: string | undefined): (typeof TASK_CLASSES)[number] | undefined {
  if (value === undefined) return undefined;
  const reply = value.toLowerCase();
  // Prefer the longest matching name so "advanced-video" wins over a substring.
  return [...TASK_CLASSES]
    .sort((a, b) => b.length - a.length)
    .find((c) => reply.includes(c.toLowerCase()));
}

/**
 * Build an {@link AsyncClassifier} that piggybacks a grammar-constrained
 * `{title, class}` request on the live conversation prefix (see file header).
 */
export function createClassifierEscalation(callModel: CallModel): AsyncClassifier {
  return async (input, tier1) => {
    // Share the exact live conversation prefix. `priorMessages` is
    // [system, …prior turns, current user prompt]; the only new tokens are the
    // short instruction + the tiny JSON answer, so the slot's KV is reused.
    const prefix: ClassifyMessage[] = input.priorMessages
      ? [...input.priorMessages]
      : // No transcript available (e.g. a programmatic caller) → fall back to the
        // bare prompt so we still return a usable {title, class}.
        [{ role: 'user', content: input.prompt }];
    const messages = [...prefix, { role: 'user' as const, content: HEADER_INSTRUCTION }];

    let text: string;
    try {
      text = await callModel({
        messages,
        temperature: 0,
        maxTokens: MAX_TOKENS,
        responseFormat: titleClassResponseFormat(),
        extraBody: NO_THINKING,
      });
    } catch {
      return undefined;
    }

    const parsed = parseTitleClass(text);
    if (parsed === undefined) return undefined;
    const picked = matchClass(parsed.class);
    // No usable class AND no usable title → nothing to contribute; keep tier 1.
    if (picked === undefined && parsed.title === undefined) return undefined;

    return {
      // Fall back to the heuristic class if the model didn't name a valid one
      // (the title is still useful and carried through).
      class: picked ?? tier1.class,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      confidence: picked !== undefined ? 0.9 : tier1.confidence,
      signals: [...tier1.signals, 'tier2-piggyback'],
      ambiguous: false,
    };
  };
}
