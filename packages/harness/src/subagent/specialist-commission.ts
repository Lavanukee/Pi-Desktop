/**
 * SPECIALIST COMMISSIONS — the specialist charters, reachable from any chat.
 *
 * jedd: "wire all the specialists, these should be via a subagent tool that has
 * options for having it be a specific specialist workflow. I think this is
 * partially implemented in the corp harness already."
 *
 * It was, and only there. `specialistMeshPrompt` / `specialistToolsFor` in
 * ../corp/corp-mesh.ts hold twelve fully-written charters, but nothing outside a
 * running corp mesh could reach them — a normal chat spawning a subagent got the
 * generic child and none of the framing. This module is the bridge: it turns a
 * kind + a commission into the prompt a child agent actually receives.
 *
 * WHY A PROMPT AND NOT A SYSTEM PROMPT. The child is driven by exactly one thing
 * — `bridge.prompt(goal)` in the desktop host (apps/desktop/electron/pi/
 * child-agents.ts). There is no seam for a separate system prompt or a tool list
 * on that path, so the charter is delivered as the head of the commission. Same
 * text, same effect on behaviour, no host protocol change; if the bridge ever
 * grows a systemPrompt field this composes into it unchanged.
 *
 * AND THE TOOLS IT NEEDS ARE ALREADY LOADED. jedd: "with just these tools
 * loaded, those subagents are only for that purpose, we aren't putting any of
 * this as 'capability suites'." The kind rides an env var to the child, whose
 * harness pins the active set to exactly `specialistToolsFor(kind)` — see
 * ./specialist-env.ts. So the charter never mentions activating anything: by the
 * time the child reads it, it is holding precisely its own kit and nothing else.
 */

import { MESH_SPECIALIST_KINDS, specialistMeshPrompt } from '../corp/corp-mesh.js';

export { MESH_SPECIALIST_KINDS };

/** Default passes for the image loop when the caller does not say. */
export const DEFAULT_IMAGE_ITERATIONS = 3;
const MAX_IMAGE_ITERATIONS = 8;

/** Is this a kind we have a charter for? Tolerant of spacing/underscores. */
export function normalizeSpecialist(kind: string): string | undefined {
  const key = kind
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return (MESH_SPECIALIST_KINDS as readonly string[]).find((k) => k === key);
}

/**
 * THE IMAGE LOOP, exactly as jedd specified it:
 *
 *   "for n iterations, model generates an initial image, decides, edit or try
 *    again from scratch at each iteration and also at each iteration indicates if
 *    the newest one is better than the current best, if so, replace it, otherwise
 *    discard (initial one from raw user prompt starts as the current best)"
 *
 * Written as a procedure rather than advice because that is what it is — a
 * hill-climb with an explicit incumbent. The two decisions per pass are separate
 * on purpose: HOW to make the next candidate (edit the best vs start over) is a
 * different judgement from WHETHER it beat the incumbent, and collapsing them is
 * how a model talks itself into keeping something worse.
 *
 * This only works because a tool-returned image now actually reaches the model
 * (see provider-llamacpp/src/stream.ts) — before that the "look at it" step was
 * an instruction with nothing behind it, and the honesty clause below was the
 * only thing standing between that and an invented critique.
 */
export function imageLoopProtocol(iterations: number): string {
  const n = Math.max(1, Math.min(MAX_IMAGE_ITERATIONS, Math.round(iterations)));
  return `YOUR WORKING LOOP — follow it literally, ${n} ${n === 1 ? 'pass' : 'passes'}.

1. Generate an image from the user's prompt as given. That image is the CURRENT
   BEST. Keep its file path; you will be comparing against it every pass.

2. Then repeat ${n} ${n === 1 ? 'time' : 'times'}:
   a. LOOK at the current best and say, specifically, what is wrong with it — the
      composition, the crop, the colour, the thing that was asked for and is not
      in the frame. One concrete fault beats a paragraph of impressions.
   b. DECIDE how to attack it, and say which you chose and why:
        · EDIT the current best — when the image is fundamentally right and the
          fault is local (a colour, an object, a crop).
        · START OVER from a new prompt — when the fault is structural: wrong
          composition, wrong subject, wrong idea. Editing cannot fix a wrong idea,
          and pass after pass of patching one is the usual way this stalls.
   c. Produce the candidate that way.
   d. LOOK at the candidate and the current best together and state a verdict in
      these words: "BETTER than current best" or "NOT better than current best".
      Judge against what the USER asked for, not against which is prettier.
   e. If BETTER: the candidate becomes the current best. If NOT: discard it and
      keep the incumbent — say you discarded it. A pass that changes nothing is a
      real and acceptable outcome; forcing an improvement that is not there is not.

3. Deliver the CURRENT BEST — its path — and a short log of the passes: what you
   tried each time, edit or from scratch, and which ones you kept.

BE HONEST ABOUT YOUR EYES. If an image comes back into your context and you can
genuinely see it, judge it. If you cannot see it, SAY SO PLAINLY and stop the
loop — a comparison you did not make is the one lie nobody downstream can catch,
and every pass after it is invented. Report how far you got and why you stopped.`;
}

export interface CommissionOptions {
  readonly kind: string;
  readonly goal: string;
  /** Passes for the image loop. Ignored by other kinds. */
  readonly iterations?: number;
}

/**
 * Compose what the child agent is actually sent: its charter, the capability it
 * should switch on, any workflow that kind runs, and the commission itself.
 *
 * The commission goes LAST. A child reads a long charter and then needs to know
 * what it is being asked for; burying the ask in the middle is how a specialist
 * ends up doing the role in general rather than the job in hand.
 */
export function composeCommission(opts: CommissionOptions): string {
  const kind = normalizeSpecialist(opts.kind);
  if (kind === undefined) {
    return opts.goal;
  }
  const parts = [specialistMeshPrompt(kind)];

  /* No activation step: the child was launched holding exactly this role's tools
   * (../subagent/specialist-env.ts). What it must NOT do is invent an artifact
   * when one of them turns out to be missing. */
  parts.push(
    'TOOLS. Everything you need is already in your tool list — there is nothing to ' +
      'turn on, and nothing else is available to you. If a tool you were promised is ' +
      'missing, say so plainly and do not invent the artifact it would have produced.',
  );

  if (kind === 'image') {
    parts.push(imageLoopProtocol(opts.iterations ?? DEFAULT_IMAGE_ITERATIONS));
  }

  parts.push(`YOUR COMMISSION:\n\n${opts.goal.trim()}`);
  return parts.join('\n\n---\n\n');
}
