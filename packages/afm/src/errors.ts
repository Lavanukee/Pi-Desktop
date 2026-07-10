/**
 * Normalized error surfaced by {@link import('./stream.js').streamAfm} when the
 * helper emits an `{"type":"error"}` line (guardrail refusal, context overflow)
 * or dies unexpectedly. `recoverable` mirrors the helper's own hint: true when
 * trimming history / retrying could plausibly succeed (e.g. context overflow,
 * model still downloading), false for hard refusals.
 */
export class AfmError extends Error {
  readonly recoverable: boolean;

  constructor(message: string, recoverable: boolean) {
    super(message);
    this.name = 'AfmError';
    this.recoverable = recoverable;
  }
}

/** Thrown when the caller's AbortSignal fires mid-stream. */
export class AfmAbortError extends Error {
  constructor(message = 'AFM request aborted') {
    super(message);
    this.name = 'AfmAbortError';
  }
}
