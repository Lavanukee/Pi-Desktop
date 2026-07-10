/**
 * `ask_user` — a rich "agent asks the user a question" tool.
 *
 * ## Why a tool (reachability)
 * pi's RPC extension-UI protocol is frozen at four dialog methods —
 * confirm / select / input / editor. `select` returns a SINGLE choice and
 * `input` returns free text; neither can express multi-select or a numeric
 * slider. Rather than fabricate a wire method pi never emits, `ask_user`
 * piggybacks on the one open-ended blocking method it DOES emit — `input`, which
 * returns an arbitrary string — by encoding a rich question spec in the input
 * placeholder behind a sentinel. The desktop event-router decodes the sentinel
 * and renders the design-system QuestionCard (choice / multi-select / slider /
 * free-text); the user's answer round-trips back as the input's string value,
 * which this tool parses. In a plain TUI pi (no decoder) it degrades to a text
 * input showing the question — still answerable.
 *
 * The wire contract ({@link ASK_USER_SENTINEL} + {@link AskUserSpec}) is mirrored
 * on the decode side in `@pi-desktop/engine` (renderer/event-router.ts). Keep the
 * two in sync.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Static, Type } from '@sinclair/typebox';
import { readSubagentDepth } from '../subagent/types.js';

/** Sentinel prefixing the encoded spec in an `input` placeholder. MUST match the
 * decoder in `@pi-desktop/engine` (renderer/event-router.ts). */
export const ASK_USER_SENTINEL = 'PI_DESKTOP_ASK_USER::v1::';

export type AskUserMode = 'choice' | 'multi' | 'slider' | 'free';

/** The rich question spec encoded into the input placeholder. */
export interface AskUserSpec {
  readonly v: 1;
  readonly mode: AskUserMode;
  readonly question: string;
  /** choice / multi. */
  readonly options?: { readonly value: string; readonly label: string; readonly info?: string }[];
  /** slider. */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly defaultValue?: number;
  /** free. */
  readonly placeholder?: string;
  readonly submitLabel?: string;
}

/** Answer shape the QuestionCard round-trips back (JSON in the input value). */
export type AskUserAnswer =
  | { readonly mode: 'choice'; readonly values: string[] }
  | { readonly mode: 'free'; readonly text: string }
  | { readonly mode: 'slider'; readonly value: number };

/** Encode a spec into the `input` placeholder string. */
export function encodeAskUser(spec: AskUserSpec): string {
  return ASK_USER_SENTINEL + JSON.stringify(spec);
}

const OptionParam = Type.Object({
  value: Type.String({ description: 'Machine value returned when this option is chosen.' }),
  label: Type.String({ description: 'What the user sees.' }),
  info: Type.Optional(Type.String({ description: 'Optional per-option tooltip.' })),
});

const AskUserParams = Type.Object({
  question: Type.String({ description: 'The question to ask the user.' }),
  mode: Type.Optional(
    Type.Union(
      [Type.Literal('choice'), Type.Literal('multi'), Type.Literal('slider'), Type.Literal('free')],
      {
        description:
          'choice = pick one, multi = pick several, slider = a number in a range, free = free text. Default: choice.',
      },
    ),
  ),
  options: Type.Optional(
    Type.Array(OptionParam, { description: 'Options for choice / multi modes.' }),
  ),
  min: Type.Optional(Type.Number({ description: 'Slider minimum (default 0).' })),
  max: Type.Optional(Type.Number({ description: 'Slider maximum (default 100).' })),
  step: Type.Optional(Type.Number({ description: 'Slider step (default 1).' })),
  defaultValue: Type.Optional(Type.Number({ description: 'Slider starting value.' })),
  placeholder: Type.Optional(Type.String({ description: 'Placeholder for free-text mode.' })),
});
type AskUserInput = Static<typeof AskUserParams>;

/** Build the spec sent to the UI from validated tool params. */
export function specFromParams(params: AskUserInput): AskUserSpec {
  const mode: AskUserMode = params.mode ?? 'choice';
  return {
    v: 1,
    mode,
    question: params.question,
    ...(params.options !== undefined ? { options: params.options } : {}),
    ...(params.min !== undefined ? { min: params.min } : {}),
    ...(params.max !== undefined ? { max: params.max } : {}),
    ...(params.step !== undefined ? { step: params.step } : {}),
    ...(params.defaultValue !== undefined ? { defaultValue: params.defaultValue } : {}),
    ...(params.placeholder !== undefined ? { placeholder: params.placeholder } : {}),
  };
}

/** Parse the QuestionCard's JSON answer string into a human-readable result. */
export function describeAnswer(spec: AskUserSpec, raw: string): string {
  let answer: AskUserAnswer;
  try {
    answer = JSON.parse(raw) as AskUserAnswer;
  } catch {
    // A plain TUI (no decoder) returns the raw typed string — treat as free text.
    return raw.trim();
  }
  if (answer.mode === 'slider') return String(answer.value);
  if (answer.mode === 'free') return answer.text.trim();
  // choice / multi → map values back to labels when we have them.
  const labelFor = new Map((spec.options ?? []).map((o) => [o.value, o.label]));
  const labelled = answer.values.map((v) => labelFor.get(v) ?? v);
  return labelled.join(', ');
}

/**
 * Register the `ask_user` tool. It sends the encoded spec through the blocking
 * `input` dialog, waits for the answer, and returns it to the model.
 */
export function registerAskUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask User',
    description:
      'Ask the user a question and wait for their answer. Use mode "choice" (pick one), "multi" ' +
      '(pick several), "slider" (a number in a range), or "free" (free text). Prefer this over ' +
      'guessing when a decision needs the user.',
    promptSnippet:
      'ask_user: ask the user a question (choice / multi-select / slider / free-text) and get their answer.',
    parameters: AskUserParams,
    async execute(_toolCallId, params: AskUserInput, _signal, _onUpdate, ctx) {
      const spec = specFromParams(params);
      // A spawned child pi reports ctx.hasUI === true but has NO human attached;
      // awaiting ctx.ui.input there would hang the subagent forever. Treat any
      // headless OR subagent context as unanswerable and return deterministically.
      if (!ctx.hasUI || readSubagentDepth(process.env) > 0) {
        return {
          content: [{ type: 'text', text: 'No UI available to ask the user.' }],
          isError: true,
          details: { cancelled: true },
        };
      }
      const raw = await ctx.ui.input(spec.question, encodeAskUser(spec));
      if (raw === undefined) {
        return {
          content: [{ type: 'text', text: 'The user dismissed the question without answering.' }],
          details: { cancelled: true },
        };
      }
      const description = describeAnswer(spec, raw);
      return {
        content: [{ type: 'text', text: `User answered: ${description}` }],
        details: { answer: description, raw },
      };
    },
  });
}
