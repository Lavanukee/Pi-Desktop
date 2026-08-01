/**
 * `create_production_hierarchy` as a NORMAL-CHAT tool (jedd: the corp system is an
 * OPTION the model opts into at high/max effort — "still just a tool" — not a mode
 * that hijacks every prompt).
 *
 * The corp orchestration itself is main-process-only (engineers as real agent
 * loops, the situation-room event stream, the browser bridge). The pi child that
 * runs this tool can't reach any of that. So the tool does the ONE thing it can
 * from the child: it validates the model's promotion (reason + divisions) and
 * publishes the intent to the renderer over the per-turn UI status channel
 * ({@link PROMOTE_STATUS_KEY}); the renderer watches that key and launches the
 * existing corp run (`startCorpTask`), reusing 100% of the wired corp pipeline.
 *
 * Visibility is effort-gated in `applyPreset` (the tool only enters the active set
 * at high/max); this `execute` re-checks the gate as belt-and-braces.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Static, Type } from '@sinclair/typebox';
import type { EffortLevel } from '../effort/effort.js';
import {
  CREATE_PRODUCTION_HIERARCHY,
  CREATE_PRODUCTION_HIERARCHY_TOOL,
  HIERARCHY_CREATED_ACK,
  parseCreateHierarchyArgs,
} from './promotion.js';

/**
 * The `ctx.ui.setStatus` key the tool publishes the promote intent on. The desktop
 * renderer mirrors this string (see apps/desktop `harness-status.ts`) and, on a new
 * `id`, launches the corp run with the user's original prompt.
 */
export const PROMOTE_STATUS_KEY = 'harness-promote';

/** The efforts at which the corp system is offered as a tool (jedd: high/max). */
export function corpToolEnabled(effort: EffortLevel): boolean {
  return effort === 'high' || effort === 'max';
}

const DivisionSpec = Type.Object({
  name: Type.String({
    description: 'Short division name, e.g. "Frontend", "Storyline", "3D Assets".',
  }),
  purpose: Type.String({ description: 'What this division is responsible for producing.' }),
});

const PromoteParams = Type.Object({
  /*
   * A MESSAGE, not a form. `divisions` used to be REQUIRED, which made handing
   * work over an org-design exercise the CEO had to complete before anything
   * could start — and splitting the work is the manager's own first instruction.
   * See TALK_TO_MANAGER in ./promotion.ts for the run this cost.
   */
  message: Type.String({
    description:
      'What you want built, in your own words — the full vision, in as much detail as you have. ' +
      'The manager has not spoken to the user and only knows what you tell them.',
  }),
  reason: Type.Optional(
    Type.String({ description: 'Optional: why this needs a team rather than a single pass.' }),
  ),
  divisions: Type.Optional(
    Type.Array(DivisionSpec, {
      description:
        'OPTIONAL. Only if you already have a shape in mind. Leave it out and the manager ' +
        'splits the work itself.',
    }),
  ),
});
export type PromoteInput = Static<typeof PromoteParams>;

/** The promote-intent payload published on {@link PROMOTE_STATUS_KEY}. */
export interface PromoteSignal {
  /** Unique per call so the renderer fires once per promotion (never re-fires). */
  readonly id: string;
  readonly reason: string;
  readonly divisions: readonly { readonly name: string; readonly purpose: string }[];
}

export interface PromoteToolDeps {
  /** Current effort — the tool is only usable at high/max. */
  readonly getEffort: () => EffortLevel;
  /** Monotonic id source for the promote signal (tests inject a fixed one). */
  readonly nextId?: () => string;
}

/**
 * Register the normal-chat `create_production_hierarchy` tool. Reuses the tuned
 * tool description + arg validation from the corp promotion module so the model
 * sees exactly the framing it does inside a corp run.
 */
export function registerCreateHierarchyTool(pi: ExtensionAPI, deps: PromoteToolDeps): void {
  let seq = 0;
  const nextId = deps.nextId ?? (() => `promote-${Date.now()}-${(seq += 1)}`);

  pi.registerTool({
    name: CREATE_PRODUCTION_HIERARCHY,
    label: 'Talk to Manager',
    description: CREATE_PRODUCTION_HIERARCHY_TOOL.function.description,
    promptSnippet:
      'talk_to_manager: hand a large build to your manager and their team of engineers, who deliver it back for your review (high/max effort only).',
    promptGuidelines: [
      'Use it for a large, multi-part build that a single pass cannot do well — not for a question, a quick edit, or a one-file task (do those yourself).',
      "Just send the message: say what you want built, in full. You do not need to design divisions — splitting the work is the manager's job.",
    ],
    parameters: PromoteParams,
    async execute(_toolCallId, params: PromoteInput, _signal, _onUpdate, ctx) {
      // Effort gate (belt-and-braces; visibility is already gated in applyPreset).
      if (!corpToolEnabled(deps.getEffort())) {
        return {
          content: [
            {
              type: 'text',
              text: 'The production hierarchy is only available at high or max effort. Do the task directly with your own tools instead.',
            },
          ],
          isError: true,
          details: { rejected: 'effort' },
        };
      }
      const args = parseCreateHierarchyArgs(params);
      if (args === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'talk_to_manager needs a "message" — tell the manager what you want built.',
            },
          ],
          isError: true,
          details: { rejected: 'args' },
        };
      }
      // Cross the process boundary: the pi child can't run corp orchestration, so
      // publish the intent to the renderer, which launches the corp run.
      if (ctx.hasUI === true) {
        const signal: PromoteSignal = {
          id: nextId(),
          reason: args.reason,
          divisions: args.divisions,
        };
        ctx.ui.setStatus(PROMOTE_STATUS_KEY, JSON.stringify(signal));
      }
      // Terminal ack — the model's building job is done the instant it delegates.
      return {
        content: [{ type: 'text', text: HIERARCHY_CREATED_ACK }],
        details: { promoted: true, divisions: args.divisions.length },
      };
    },
  });
}
