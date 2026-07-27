/**
 * The waveform that replaces the composer's text while you dictate.
 *
 * Bars are drawn from the live analyser levels (useDictation), newest on the
 * right, so the shape follows the voice rather than a timer. The row also
 * carries the two exits — cancel throws the recording away, stop transcribes it
 * — because a recording UI with no visible way out is the thing people
 * complain about.
 *
 * `transcribing` keeps the last waveform on screen at reduced opacity instead
 * of clearing it. A box that empties the instant you stop reads as "it lost
 * what I said"; a frozen waveform reads as "it is working on that".
 */
import type { JSX } from 'react';
import type { DictationPhase } from './useDictation';

/** Bars are drawn even before any level arrives, so the row has a shape the
 * moment it appears rather than growing into one. */
const MIN_BARS = 28;

export function DictationBar({
  phase,
  levels,
  onStop,
  onCancel,
}: {
  readonly phase: DictationPhase;
  readonly levels: readonly number[];
  readonly onStop: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const padded =
    levels.length >= MIN_BARS
      ? levels.slice(-MIN_BARS)
      : [...Array.from({ length: MIN_BARS - levels.length }, () => 0), ...levels];

  return (
    <div
      className="pd-dictation"
      data-testid="dictation-bar"
      data-phase={phase}
      role="status"
      aria-live="polite"
      aria-label={phase === 'transcribing' ? 'Transcribing your dictation' : 'Recording'}
    >
      <button
        type="button"
        className="pd-dictation-x pd-focusable"
        data-testid="dictation-cancel"
        aria-label="Discard this recording"
        onClick={onCancel}
      >
        ×
      </button>
      <div className="pd-dictation-wave" aria-hidden="true">
        {padded.map((level, i) => (
          <span
            // Bars are a fixed-length window, so the index IS the identity —
            // keying by value would remount every bar on every tick.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length window
            key={i}
            className="pd-dictation-bar"
            style={{ transform: `scaleY(${Math.max(0.08, level).toFixed(3)})` }}
          />
        ))}
      </div>
      <span className="pd-dictation-hint">
        {phase === 'transcribing' ? 'Transcribing…' : 'Listening'}
      </span>
      {phase === 'recording' ? (
        <button
          type="button"
          className="pd-dictation-done pd-focusable"
          data-testid="dictation-stop"
          onClick={onStop}
        >
          Done
        </button>
      ) : null}
    </div>
  );
}
