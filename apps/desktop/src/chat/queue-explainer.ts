/**
 * Pure copy for the queue explainer: turns a {@link QueueReason} snapshot into the
 * short faded line under a queued message and the fuller blurb inside the "Why
 * isn't my message sending?" modal. Kept pure + unit-tested so the wording is
 * verified without rendering, and so it never accidentally reaches for live state.
 *
 * Voice: plain-English and reassuring — a non-technical user must never feel
 * they're on an arbitrary cooldown. Every reason names the concrete constraint
 * (one reply at a time, one model at a time, or not enough memory) and points at
 * the running-chats list the modal shows below.
 */
import type { QueueReason } from '../state/send-feasibility';

const targetName = (r: QueueReason): string => r.targetModelName ?? 'the selected model';
const loadedName = (r: QueueReason): string => r.loadedModelName ?? 'the current model';

/** The one-line reason shown, dimmed, beneath a queued message bubble. */
export function queuedLineText(reason: QueueReason | undefined): string {
  if (reason === undefined) return 'Queued · sends after this reply';
  switch (reason.kind) {
    case 'busy-switch-model':
      return reason.targetModelName !== undefined
        ? `Queued — will switch to ${reason.targetModelName} first`
        : 'Queued — a model switch is needed first';
    case 'insufficient-ram':
      return reason.targetModelName !== undefined
        ? `Queued — ${reason.targetModelName} may not fit this computer's memory`
        : "Queued — the selected model may not fit this computer's memory";
    default:
      // busy-same-model / ready / anything else → the plain sequential wait.
      return 'Queued — sends when the current reply finishes';
  }
}

export interface QueueExplainer {
  /** The fuller explanation shown at the top of the modal. */
  readonly blurb: string;
  /** A short call-to-action tying to the running-chats list below it. */
  readonly hint: string;
}

/** The modal's explanatory copy for a given reason. */
export function queueExplainer(reason: QueueReason | undefined): QueueExplainer {
  if (reason === undefined) {
    return {
      blurb: 'Your message is queued and will send when the current reply finishes.',
      hint: 'To send it now, pause or stop the running chat below.',
    };
  }
  switch (reason.kind) {
    case 'busy-switch-model':
      return {
        blurb: `This message uses ${targetName(reason)}, but ${loadedName(
          reason,
        )} is loaded and replying right now. Your computer can hold only one model at a time, so it will finish the current reply, swap models, then send — swapping takes a few seconds.`,
        hint: 'To send it now, pause or stop the running chat below to free up the model.',
      };
    case 'insufficient-ram':
      return {
        blurb: `${targetName(
          reason,
        )} needs more memory than this computer has free, so it may load slowly or fail. You can still try — it will send once anything running finishes — or pick a lighter model in the model menu.`,
        hint: 'Pausing or stopping the running chat below frees the most memory for it.',
      };
    default:
      return {
        blurb: `Your computer generates one reply at a time, and a reply is streaming right now on ${loadedName(
          reason,
        )}. Your message sends automatically the moment it finishes.`,
        hint: 'To send it sooner, pause or stop the running chat below.',
      };
  }
}
