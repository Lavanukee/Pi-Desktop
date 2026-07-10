/**
 * Model-backed "scary bash" flagger for reviewer permission mode.
 *
 * The regex rules (permissions/rules.ts) are the always-available first line —
 * fast and offline. When a utility model is configured, this flagger layers a
 * small-model judgment on TOP: it only runs for commands the regex did NOT
 * already flag (see registerPermissions in modes.ts), catching destructive /
 * irreversible commands the static rules miss. It fails open (returns null on
 * any error/timeout) so the gate never wedges on a slow or absent model — the
 * regex fallback still stands.
 */

import type { CallModel } from '../model-call/call-model.js';
import type { BashFlagger } from './modes.js';

const SYSTEM_PROMPT =
  'You are a cautious security reviewer for a coding agent. You are shown a single shell ' +
  'command the agent wants to run. Decide whether it is DANGEROUS: destructive, irreversible, ' +
  'exfiltrates data, damages the system, or is otherwise something a careful user would want to ' +
  'approve first. Reply with a SHORT reason (max ~12 words) if it is dangerous, or the single ' +
  'word SAFE if it is fine. Do not explain safe commands.';

/** How long to wait for the model before failing open to the regex rules. */
const FLAG_TIMEOUT_MS = 4000;
/** Cap the reason we surface to the user. */
const MAX_REASON_LEN = 140;

/** Interpret the model's reply: a reason string when flagged, else null. */
export function interpretFlagReply(reply: string): string | null {
  const trimmed = reply.trim();
  if (trimmed.length === 0) return null;
  // "SAFE" (optionally punctuated) → not scary.
  if (/^safe[.!]?$/i.test(trimmed)) return null;
  // Some models answer "DANGEROUS: <reason>" — strip a leading verdict token.
  const reason = trimmed.replace(/^(dangerous|unsafe|risky|scary)\s*[:-]\s*/i, '').trim();
  const text = reason.length > 0 ? reason : trimmed;
  return `flagged by model: ${text.slice(0, MAX_REASON_LEN)}`;
}

/**
 * Build a {@link BashFlagger} backed by the utility model. Returns a reason
 * string when the model judges the command dangerous, or null when it is safe
 * (or on any error/timeout — fail open).
 */
export function createBashFlagger(callModel: CallModel): BashFlagger {
  return async (command: string): Promise<string | null> => {
    const trimmed = command.trim();
    if (trimmed.length === 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FLAG_TIMEOUT_MS);
    try {
      const reply = await callModel({
        system: SYSTEM_PROMPT,
        prompt: `Command:\n${trimmed}`,
        temperature: 0,
        maxTokens: 40,
        signal: controller.signal,
      });
      return interpretFlagReply(reply);
    } catch {
      // Model unreachable / timed out / aborted → fall back to the regex rules.
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
