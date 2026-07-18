/**
 * The CEO VISION-FORMING turn — the missing FIRST turn of the corp pipeline
 * (spec §4 "the CEO writes/holds the vision"; §12-Q5 mockups; §8 the standard the
 * CEO later judges against).
 *
 * WHY this turn exists: before slice this file adds, `runCorp` fed the RAW user
 * task straight into the architect. But per §4 the CEO's job is to SYNTHESIZE the
 * user's intent into a clear vision brief — what is being built, its tone + scope,
 * and the concrete deliverables — BEFORE the corporation builds. A BARE CEO
 * (single completion) overthinks; the owner's requirement is that the CEO forms
 * its vision INSIDE A HARNESS with tools: it may research references (web_search),
 * draft + iterate on a quick mockup (write/read/bash), then SUBMIT one concrete
 * vision. This module ships the pure pieces of that turn:
 *
 *  - {@link CEO_VISION_PROMPT} — the vision-forming SYSTEM prompt (the CEO
 *    disposition from the prompt library, re-framed for the scoped, self-contained
 *    vision-forming task).
 *  - {@link buildCeoVisionPrompt} — the USER turn (the raw user task → the exact
 *    vision brief to synthesize, with the INTERPRET-mode directive and the
 *    research / mockup / iterate / submit flow).
 *  - {@link SUBMIT_VISION_TOOL} — the custom tool that finalizes the brief (its
 *    `brief` argument carries the structured vision; the CALL is the submit signal).
 *  - {@link parseVisionBrief} — tolerant extraction of the brief from the submit
 *    tool call (preferred) or the final assistant text (fallback), mirroring the
 *    promotion detector's tool-call-then-text shape.
 *
 * The turn runs harnessed via the role-agent seam (chat fallback for driver /
 * tests). Its output — the VISION BRIEF — REPLACES the raw task string threaded
 * into the architect + managers, so the whole corporation builds against the CEO's
 * vision. A blank/failed vision turn falls back to the raw task (the vision can
 * never silently blank the build — "robustness is external", §0.6).
 */

import { getRolePrompt } from './prompts.js';
import type { RoleAgentCustomTool } from './role-agent-seam.js';

/** The tool name the CEO calls to finalize its vision brief. */
export const SUBMIT_VISION = 'submit_vision';

/**
 * The default results page the CEO's REAL-browser research navigates to. The
 * DuckDuckGo HTML endpoint is chosen deliberately: it renders plain server-side
 * results a `browser_read` can extract, and — unlike the scraped `web_search`
 * backend, which DuckDuckGo blocks server-side (202/challenge → "No results") — a
 * REAL browser tab is not met with the bot-detection wall. The caller appends the
 * URL-encoded query. (Google is a one-line swap: `https://www.google.com/search?q=`.)
 */
export const VISION_SEARCH_URL = 'https://duckduckgo.com/html/?q=';

/**
 * The vision-forming SYSTEM prompt. Built from the CEO disposition in the prompt
 * library ({@link getRolePrompt}('ceo') — the "you hold the vision" half) and
 * re-framed for the scoped, self-contained vision-forming task: form ONE concrete
 * interpretation (INTERPRET mode is the autonomous-run default), optionally
 * research + sketch a quick mockup, iterate, then submit. Pairs with the
 * `thinking-general` sampling profile (thinking ON — the synthesis IS the value).
 */
export const CEO_VISION_PROMPT = `${getRolePrompt('ceo').prompt}

RIGHT NOW you are FORMING THE VISION — this is the very first step, before anyone builds anything. Nothing exists yet. Your one job here is to turn the user's request into a single, concrete VISION BRIEF the whole team will build against.

You are working in INTERPRET mode: do NOT ask the user questions. Where the request is open-ended, research it, decide, and commit to ONE clear interpretation that becomes the task.

You have real tools — use them to form a vision you are confident in, not to overthink:
- browser_navigate + browser_read (PREFERRED for research — this drives a REAL browser tab the user watches live, so it is NOT blocked the way a scraped search is): to look something up, NAVIGATE to a search results page and READ it. Default to DuckDuckGo — browser_navigate to \`${VISION_SEARCH_URL}<your+url-encoded+query>\`, then browser_read to get the results text, and extract the top few titles + links. To dig deeper, browser_navigate to a promising link and browser_read the page itself.
- web_search / web_fetch (FALLBACK, if the browser is unavailable): look up references the same way. Either path: if research returns nothing, proceed on your own judgment — do not block on it.
- write / read: sketch a QUICK, ROUGH mockup of the intended result (a single self-contained \`mockup.html\`, or a short markdown outline) so the vision is concrete. It is a throwaway reference to think against, not a deliverable — keep it small.
- bash: preview or sanity-check what you drafted.

CRITICAL: researching or sketching is NOT finishing. Your turn is ONLY complete when you call ${SUBMIT_VISION} with the full brief. After a web_search or a mockup, do not stop — WRITE the brief and call ${SUBMIT_VISION}. Iterate as much as you need, then finalize by calling ${SUBMIT_VISION}. Keep your context clean: you are deciding WHAT gets built and why — never HOW (no code, no file structure, no contracts; the managers own that).`;

/**
 * Build the CEO's vision-forming USER turn from the raw user task. Pairs with
 * {@link CEO_VISION_PROMPT}: it states the raw request, the exact shape of the
 * brief to synthesize (what / tone + scope / concrete deliverables), and the
 * research → mockup → iterate → {@link SUBMIT_VISION} flow. Pure string
 * composition; deterministic.
 */
export function buildCeoVisionPrompt(task: string): string {
  return [
    "Form the vision for this request. Synthesize the user's intent into one concrete VISION BRIEF the corporation will build against.",
    '',
    'THE USER REQUEST:',
    task.trim(),
    '',
    'Your VISION BRIEF must make three things unambiguous:',
    '1. WHAT is being built — one clear, concrete interpretation (in INTERPRET mode you decide; do not ask).',
    '2. Its TONE and SCOPE — the intended feel and how far it reaches (what is in, what is deliberately out).',
    '3. The concrete DELIVERABLES — the specific things that must exist for this to be "done".',
    '',
    `Before you submit you MAY: research references to ground the vision — PREFER the real browser (browser_navigate to \`${VISION_SEARCH_URL}<url-encoded query>\`, then browser_read the results and extract the top hits), falling back to web_search / web_fetch — and sketch a quick throwaway mockup with write (e.g. a rough mockup.html) so it is concrete. Iterate until you are confident.`,
    '',
    `When the vision is clear, call ${SUBMIT_VISION} with the full brief as its \`brief\` argument, then stop. (If you cannot call the tool, end your reply with the brief itself.) Direction only — no code, no file layout, no contracts.`,
  ].join('\n');
}

/**
 * The {@link SUBMIT_VISION} custom tool: calling it finalizes the vision brief.
 * Marked `terminal` (no `submitReview`/`consult`): the seam records the call as a
 * no-op ack and surfaces it in the run output for {@link parseVisionBrief} to read
 * (the same shape the promotion tool uses), and the `terminal` flag tells the
 * completeness bump the turn is finished — so it stops re-prompting once submitted.
 */
export const SUBMIT_VISION_TOOL: RoleAgentCustomTool = {
  name: SUBMIT_VISION,
  terminal: true,
  description:
    'Finalize your vision. Call this ONCE with the full vision brief once you are confident in it, then stop.',
  parameters: {
    type: 'object',
    properties: {
      brief: {
        type: 'string',
        description:
          'The complete vision brief: WHAT is being built (one concrete interpretation), its TONE and SCOPE, and the concrete DELIVERABLES that define "done".',
      },
    },
    required: ['brief'],
  },
};

/** Max completeness bumps for the vision turn (bounded; NOT a per-agent work cap —
 * it only prevents a PREMATURE stop, like the engineer's bump). */
export const MAX_VISION_BUMPS = 2;

/** The re-prompt appended when the vision turn stopped WITHOUT submitting (spec §4;
 * mirrors the engineer's bump-to-continue). Drives the CEO to finalize the brief it
 * has already researched, rather than starting over. */
export const VISION_BUMP_PROMPT = `You have not submitted your vision yet. Do NOT research further — decide now. Write the full VISION BRIEF (what is being built, its tone and scope, and the concrete deliverables) and call ${SUBMIT_VISION} with it as the \`brief\` argument.`;

/** One tool call as surfaced by either seam (the run's `toolCalls`). */
interface VisionToolCall {
  readonly name: string;
  readonly arguments: string | Record<string, unknown>;
}

/** Decode a tool call's arguments to an object (raw JSON string or already an
 * object), or `undefined` when it is not a usable object. */
function decodeArgs(args: string | Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof args !== 'string') return args;
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the finalized VISION BRIEF from a vision turn's output. Prefers the
 * {@link SUBMIT_VISION} tool call's `brief` argument (the explicit submit); falls
 * back to the final assistant text when the tool was not called (chat fallback, or
 * a model that stated the brief instead of calling the tool). Trimmed; returns an
 * empty string when nothing usable is present, so the caller falls back to the raw
 * task (a failed vision turn never blanks the build). Never throws.
 */
export function parseVisionBrief(toolCalls: readonly VisionToolCall[], finalText: string): string {
  for (const call of toolCalls) {
    if (call.name !== SUBMIT_VISION) continue;
    const decoded = decodeArgs(call.arguments);
    const brief = decoded?.brief;
    if (typeof brief === 'string' && brief.trim() !== '') return brief.trim();
  }
  return typeof finalText === 'string' ? finalText.trim() : '';
}
