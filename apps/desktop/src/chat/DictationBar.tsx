/**
 * The dictation row: it TAKES OVER the composer footer while the mic is open.
 *
 * Where the +, mic, model picker and send button normally sit, there is instead
 * an X, a live waveform, and a confirm button. The editor above stays visible
 * and fills with words as you speak — which is the reason this row moved down
 * here at all (jedd): a waveform standing where the text goes hides the thing
 * you actually want to watch.
 *
 * Bars are drawn from the live analyser levels (useDictation), newest on the
 * right, so the shape follows the voice rather than a timer.
 *
 * `transcribing` keeps the last waveform on screen at reduced opacity instead
 * of clearing it. A row that empties the instant you stop reads as "it lost
 * what I said"; a frozen waveform reads as "it is working on that".
 */

import { IconArrowUp, IconButton, IconClose } from '@pi-desktop/ui';
import type { JSX } from 'react';
import type { DictationPhase } from './useDictation';

/** Bars are drawn even before any level arrives, so the row has a shape the
 * moment it appears rather than growing into one. */
const MIN_BARS = 96;

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

  const label =
    phase === 'transcribing' ? 'Transcribing…' : phase === 'starting' ? 'Starting…' : 'Listening';

  return (
    <div
      className="pd-dictation"
      data-testid="dictation-bar"
      data-phase={phase}
      role="status"
      aria-live="polite"
      aria-label={phase === 'transcribing' ? 'Transcribing your dictation' : 'Recording'}
    >
      <IconButton
        aria-label="Discard this recording"
        variant="secondary"
        circle
        data-testid="dictation-cancel"
        onClick={onCancel}
      >
        <IconClose size={13} />
      </IconButton>
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
      <span className="pd-dictation-hint">{label}</span>
      <IconButton
        aria-label="Finish dictating and keep the text"
        variant="accent"
        circle
        data-testid="dictation-stop"
        onClick={onStop}
        // Nothing has been heard yet while the recogniser loads, so there is
        // nothing to confirm.
        disabled={phase !== 'recording'}
      >
        <IconArrowUp size={13} />
      </IconButton>
    </div>
  );
}
