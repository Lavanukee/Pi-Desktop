/**
 * Wire + public types for the Apple Foundation Models bridge. These mirror the
 * NDJSON protocol the Swift `pi-afm` helper speaks over stdio, kept in one place
 * so the helper contract and the Node API can't drift apart.
 */

/** Why the on-device model is unavailable (each needs a different UI response). */
export type AfmUnavailableReason =
  | 'deviceNotEligible'
  | 'appleIntelligenceNotEnabled'
  | 'modelNotReady'
  | 'unsupportedOS';

/** The full set of `reason` values `pi-afm --check` can emit. */
export type AfmReason = 'available' | AfmUnavailableReason;

/** Parsed result of `pi-afm --check`. */
export interface AfmAvailability {
  /** True iff a real streamed completion can be served right now. */
  readonly available: boolean;
  readonly reason: AfmReason;
  /** Shared per-session token ceiling (input + instructions + history + output). */
  readonly contextWindow: number;
  /** Best-effort model identifier the helper exposes. */
  readonly model: string;
}

/** A prior conversation turn folded into the session's instructions. */
export interface AfmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** Request written (as one JSON object) to `pi-afm --respond` over stdin. */
export interface AfmRequest {
  /** The live user turn to stream a response to. */
  readonly prompt: string;
  /** System instructions for the session. */
  readonly instructions?: string;
  /** Prior turns, rendered by the helper into a transcript preamble. */
  readonly messages?: readonly AfmMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
}

/** Token usage, when the helper can surface it. */
export interface AfmUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** One NDJSON line emitted by `pi-afm --respond`. */
export type AfmDelta =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly usage?: AfmUsage }
  | { readonly type: 'error'; readonly message: string; readonly recoverable: boolean };

/** Resolved value of a successful {@link streamAfm} call. */
export interface AfmStreamResult {
  /** The full concatenated response text. */
  readonly text: string;
  readonly usage?: AfmUsage;
}
