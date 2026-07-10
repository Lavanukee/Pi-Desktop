/**
 * Tier-2 classifier escalation, backed by the utility model.
 *
 * `classifyWithEscalation` already accepts an injectable {@link AsyncClassifier};
 * this builds one from the {@link CallModel} seam. It only runs when tier-1 is
 * ambiguous (see `classifyWithEscalation`'s default), asks the utility model to
 * pick a single class from {@link TASK_CLASSES}, and returns `undefined` on any
 * failure so the heuristic result stands.
 *
 * ## App hook
 * Escalation activates automatically once a utility endpoint is configured
 * (`PI_DESKTOP_UTILITY_BASE_URL`, see model-call/call-model.ts) — the same seam
 * the fixer/review use. No separate wiring; absent endpoint ⇒ heuristics only.
 */

import type { CallModel } from '../model-call/call-model.js';
import { type AsyncClassifier, TASK_CLASSES } from './classify.js';

/** Build an {@link AsyncClassifier} that asks the utility model to pick a class. */
export function createClassifierEscalation(callModel: CallModel): AsyncClassifier {
  return async (input, tier1) => {
    const prompt = [
      'Classify the task into exactly ONE of these classes:',
      TASK_CLASSES.join(', '),
      `\nTask: ${input.prompt}`,
      `Heuristic guess: ${tier1.class} (may be wrong).`,
      '\nReply with ONLY the class name, nothing else.',
    ].join('\n');
    let text: string;
    try {
      text = await callModel({ prompt, temperature: 0 });
    } catch {
      return undefined;
    }
    const reply = text.toLowerCase();
    // Prefer the longest matching class name so e.g. "advanced-video" wins over
    // a bare substring, and "simple-QA" isn't shadowed.
    const picked = [...TASK_CLASSES]
      .sort((a, b) => b.length - a.length)
      .find((c) => reply.includes(c.toLowerCase()));
    if (picked === undefined) return undefined;
    return {
      class: picked,
      confidence: 0.9,
      signals: [...tier1.signals, 'tier2-escalation'],
      ambiguous: false,
    };
  };
}
