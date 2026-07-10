import { describe, expect, it } from 'vitest';
import {
  type ActivityStepData,
  activitySummary,
  formatDuration,
  summarizeActivity,
} from './activity-chain.tsx';

describe('summarizeActivity', () => {
  it('renders a single step in past tense', () => {
    expect(summarizeActivity([{ kind: 'bash', label: 'x' }])).toBe('Ran a command');
  });

  it('joins distinct kinds, lower-casing all but the first', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a' },
      { kind: 'read', label: 'b' },
    ];
    expect(summarizeActivity(steps)).toBe('Ran a command, read a file');
  });

  it('aggregates same-kind steps across the whole chain with a count + plural', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a' },
      { kind: 'bash', label: 'b' },
      { kind: 'read', label: 'c' },
    ];
    expect(summarizeActivity(steps)).toBe('Ran 2 commands, read a file');
  });

  it('is order-INDEPENDENT — non-consecutive same-kind steps still coalesce', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a' },
      { kind: 'read', label: 'b' },
      { kind: 'bash', label: 'c' },
    ];
    // Not "ran a command, read a file, ran a command" — the whole chain rolls up.
    expect(summarizeActivity(steps)).toBe('Ran 2 commands, read a file');
  });

  it('emits kinds in a fixed canonical order regardless of input order', () => {
    const steps: ActivityStepData[] = [
      { kind: 'read', label: 'a' },
      { kind: 'thinking', label: 'b' },
      { kind: 'bash', label: 'c' },
    ];
    expect(summarizeActivity(steps)).toBe('Ran a command, thought, read a file');
  });

  it('keeps non-countable verbs singular even when repeated', () => {
    const steps: ActivityStepData[] = [
      { kind: 'search', label: 'a' },
      { kind: 'search', label: 'b' },
    ];
    expect(summarizeActivity(steps)).toBe('Searched the web');
  });

  it('handles thinking and canvas verbs', () => {
    const steps: ActivityStepData[] = [
      { kind: 'thinking', label: 't' },
      { kind: 'canvas-open', label: 'c' },
    ];
    expect(summarizeActivity(steps)).toBe('Thought, opened the canvas');
  });

  it('pluralizes edits and images', () => {
    const steps: ActivityStepData[] = [
      { kind: 'edit', label: 'a' },
      { kind: 'edit', label: 'b' },
      { kind: 'edit', label: 'c' },
    ];
    expect(summarizeActivity(steps)).toBe('Edited 3 files');
  });

  it('sums thinking durations into the phrase', () => {
    const steps: ActivityStepData[] = [
      { kind: 'thinking', label: 'a', durationMs: 20 * 60_000 },
      { kind: 'thinking', label: 'b', durationMs: 60 * 60_000 },
    ];
    expect(summarizeActivity(steps)).toBe('Thought for 1h 20m');
  });

  it('matches the full-aggregation reference example', () => {
    const steps: ActivityStepData[] = [
      ...Array.from({ length: 10 }, (_, i): ActivityStepData => ({ kind: 'bash', label: `c${i}` })),
      { kind: 'thinking', label: 't', durationMs: 80 * 60_000 },
      ...Array.from({ length: 3 }, (_, i): ActivityStepData => ({ kind: 'read', label: `r${i}` })),
    ];
    expect(summarizeActivity(steps)).toBe('Ran 10 commands, thought for 1h 20m, read 3 files');
  });

  it('returns an empty string for no steps', () => {
    expect(summarizeActivity([])).toBe('');
  });
});

describe('formatDuration', () => {
  it('formats hours + minutes', () => {
    expect(formatDuration(80 * 60_000)).toBe('1h 20m');
  });
  it('drops to minutes + seconds under an hour', () => {
    expect(formatDuration(90_000)).toBe('1m 30s');
  });
  it('drops to seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });
  it('keeps a zero minute/second component', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('activitySummary', () => {
  it('reads present-tense while a step is still running', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a', status: 'done' },
      { kind: 'edit', label: 'b', status: 'running' },
    ];
    expect(activitySummary(steps)).toBe('Editing a file');
  });

  it('describes the LAST running step when several run', () => {
    const steps: ActivityStepData[] = [
      { kind: 'read', label: 'a', status: 'running' },
      { kind: 'search', label: 'b', status: 'running' },
    ];
    expect(activitySummary(steps)).toBe('Searching the web');
  });

  it('flips to the past-tense roll-up once every step is done', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a', status: 'done' },
      { kind: 'edit', label: 'b', status: 'done' },
    ];
    expect(activitySummary(steps)).toBe('Ran a command, edited a file');
  });

  it('treats a step with no explicit status as done', () => {
    expect(activitySummary([{ kind: 'bash', label: 'a' }])).toBe('Ran a command');
  });

  it('falls back to "Working…" with no steps', () => {
    expect(activitySummary([])).toBe('Working…');
  });
});
