import { describe, expect, it } from 'vitest';
import {
  type HarnessStage,
  parsePrefillPercent,
  stageDisplay,
  threadStatusView,
} from './harness-status';

/**
 * The harness publishes a coarse lifecycle `stage`; the ONE consolidated thread
 * indicator (jedd blind-test #1) folds it into a single "Thinking"/"Working"
 * label. These tests pin the two pure cores — the stage→display mapping and the
 * consolidated-indicator view — without rendering.
 */
describe('stageDisplay (pure mapping)', () => {
  it('maps every in-flight stage to its verb, live=true', () => {
    const cases: Array<[HarnessStage, string]> = [
      ['classifying', 'Classifying'],
      ['working', 'Working'],
      ['repairing', 'Repairing'],
      ['reviewing', 'Reviewing'],
      ['revising', 'Revising'],
      ['verifying', 'Verifying'],
    ];
    for (const [stage, label] of cases) {
      expect(stageDisplay(stage)).toEqual({ label, live: true });
    }
  });

  it('maps the terminal `done` stage to a non-live label', () => {
    expect(stageDisplay('done')).toEqual({ label: 'Done', live: false });
  });

  it('hides idle / absent / unknown stages (returns null)', () => {
    expect(stageDisplay('idle')).toBeNull();
    expect(stageDisplay(null)).toBeNull();
    expect(stageDisplay(undefined)).toBeNull();
    // A garbled payload could smuggle an out-of-enum value; tolerate it.
    expect(stageDisplay('bogus' as HarnessStage)).toBeNull();
  });
});

describe('threadStatusView (the ONE consolidated indicator)', () => {
  const base = {
    isStreaming: true as boolean,
    retry: null as { attempt: number; maxAttempts: number } | null,
    toolRunning: false,
    stage: null as HarnessStage | null | undefined,
    isAuto: true,
    switchingToTier: null as string | null,
    promptProgress: null as number | null,
  };

  it('shows nothing when idle (not streaming, not switching)', () => {
    expect(threadStatusView({ ...base, isStreaming: false })).toBeNull();
  });

  it('reads "Thinking" while streaming with no tool and no acting stage', () => {
    expect(threadStatusView(base)).toEqual({
      label: 'Thinking',
      detail: undefined,
      showElapsed: true,
    });
  });

  it('reads "Working" the instant a tool is running', () => {
    expect(threadStatusView({ ...base, toolRunning: true })).toEqual({
      label: 'Working',
      detail: undefined,
      showElapsed: true,
    });
  });

  it('treats acting stages as "Working" even with no tool momentarily in flight', () => {
    for (const stage of ['working', 'repairing', 'reviewing', 'revising', 'verifying'] as const) {
      expect(threadStatusView({ ...base, stage })?.label).toBe('Working');
    }
  });

  it('folds a refinement stage in as a subtle detail word', () => {
    expect(threadStatusView({ ...base, stage: 'reviewing' })).toEqual({
      label: 'Working',
      detail: 'Reviewing',
      showElapsed: true,
    });
    expect(threadStatusView({ ...base, stage: 'verifying' })?.detail).toBe('Verifying');
    expect(threadStatusView({ ...base, stage: 'repairing' })?.detail).toBe('Repairing');
  });

  it('carries no detail for plain working/done (the primary word already says it)', () => {
    expect(threadStatusView({ ...base, stage: 'working' })?.detail).toBeUndefined();
    // `done` is terminal, but if it ever streams through it adds nothing.
    expect(threadStatusView({ ...base, stage: 'done' })?.detail).toBeUndefined();
  });

  it('surfaces "Classifying" ONLY in Auto mode (jedd #5)', () => {
    expect(threadStatusView({ ...base, stage: 'classifying', isAuto: true })).toEqual({
      label: 'Thinking',
      detail: 'Classifying',
      showElapsed: true,
    });
    // Pinned tier: never classify → just "Thinking", no "Classifying".
    expect(threadStatusView({ ...base, stage: 'classifying', isAuto: false })).toEqual({
      label: 'Thinking',
      detail: undefined,
      showElapsed: true,
    });
  });

  it('shows the retry phrase (winning over the stage) while streaming', () => {
    expect(
      threadStatusView({ ...base, retry: { attempt: 2, maxAttempts: 3 }, stage: 'reviewing' }),
    ).toEqual({ label: 'Retrying (2/3)…', showElapsed: true });
  });

  it('borrows the indicator for a pre-stream model switch (no elapsed counter)', () => {
    expect(threadStatusView({ ...base, isStreaming: false, switchingToTier: 'Balanced' })).toEqual({
      label: 'Switching to Balanced…',
      showElapsed: false,
    });
  });

  it('prefers the live turn over a stale switch flag once streaming has begun', () => {
    // If both are somehow set, streaming wins — the switch already completed.
    expect(
      threadStatusView({ ...base, isStreaming: true, switchingToTier: 'Balanced' })?.label,
    ).toBe('Thinking');
  });

  it('shows "Processing N%" during prefill, ahead of Thinking/Working', () => {
    expect(threadStatusView({ ...base, promptProgress: 42 })).toEqual({
      label: 'Processing',
      detail: '42%',
      showElapsed: true,
    });
    // Wins over an acting stage / running tool — prefill precedes any real work.
    expect(
      threadStatusView({ ...base, promptProgress: 3, stage: 'working', toolRunning: true })?.label,
    ).toBe('Processing');
  });

  it('surfaces prefill even before the turn flips to streaming (precedes Thinking)', () => {
    expect(threadStatusView({ ...base, isStreaming: false, promptProgress: 10 })).toEqual({
      label: 'Processing',
      detail: '10%',
      showElapsed: true,
    });
  });

  it('lets a pre-stream model switch win over prefill (the swap happens first)', () => {
    expect(
      threadStatusView({
        ...base,
        isStreaming: false,
        switchingToTier: 'Balanced',
        promptProgress: 20,
      })?.label,
    ).toBe('Switching to Balanced…');
  });

  it('hands off to Thinking/Working once prefill is done (promptProgress null)', () => {
    expect(threadStatusView({ ...base, promptProgress: null })?.label).toBe('Thinking');
    expect(threadStatusView({ ...base, promptProgress: null, toolRunning: true })?.label).toBe(
      'Working',
    );
  });
});

/**
 * Prefill progress rides the generic `extensionStatus` channel as a percent
 * string; the indicator parses it into 0..99 (or null when absent/done).
 */
describe('parsePrefillPercent', () => {
  it('parses a 0..99 percent string', () => {
    expect(parsePrefillPercent('0')).toBe(0);
    expect(parsePrefillPercent('42')).toBe(42);
    expect(parsePrefillPercent('99')).toBe(99);
    expect(parsePrefillPercent('37.5')).toBe(37.5);
  });

  it('collapses "complete" (>= 100) to null — prefill is over, hand off', () => {
    expect(parsePrefillPercent('100')).toBeNull();
    expect(parsePrefillPercent('120')).toBeNull();
  });

  it('is null for absent / empty / garbled / negative values', () => {
    expect(parsePrefillPercent(undefined)).toBeNull();
    expect(parsePrefillPercent('')).toBeNull();
    expect(parsePrefillPercent('nope')).toBeNull();
    expect(parsePrefillPercent('-5')).toBeNull();
  });
});
