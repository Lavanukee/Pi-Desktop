/**
 * Queue-explainer copy: the faded queued line + the modal blurb per reason. Pure,
 * so the exact wording (and the graceful fallbacks when a model name is unknown)
 * is pinned without rendering.
 */
import { describe, expect, it } from 'vitest';
import type { QueueReason } from '../state/send-feasibility';
import { queuedLineText, queueExplainer } from './queue-explainer';

describe('queuedLineText', () => {
  it('falls back to the generic wording with no reason', () => {
    expect(queuedLineText(undefined)).toBe('Queued · sends after this reply');
  });

  it('same-model → a plain sequential wait', () => {
    const r: QueueReason = { kind: 'busy-same-model', loadedModelName: 'Qwen 4B' };
    expect(queuedLineText(r)).toBe('Queued — sends when the current reply finishes');
  });

  it('switch-model → names the target when known', () => {
    expect(queuedLineText({ kind: 'busy-switch-model', targetModelName: 'Gemma 12B' })).toBe(
      'Queued — will switch to Gemma 12B first',
    );
    expect(queuedLineText({ kind: 'busy-switch-model' })).toBe(
      'Queued — a model switch is needed first',
    );
  });

  it('insufficient-ram → warns about memory', () => {
    expect(queuedLineText({ kind: 'insufficient-ram', targetModelName: 'Qwen 122B' })).toBe(
      "Queued — Qwen 122B may not fit this computer's memory",
    );
  });
});

describe('queueExplainer', () => {
  it('same-model explains the one-reply-at-a-time constraint', () => {
    const e = queueExplainer({ kind: 'busy-same-model', loadedModelName: 'Qwen 4B' });
    expect(e.blurb).toContain('one reply at a time');
    expect(e.blurb).toContain('Qwen 4B');
    expect(e.hint).toContain('pause or stop');
  });

  it('switch-model explains the one-model-at-a-time swap', () => {
    const e = queueExplainer({
      kind: 'busy-switch-model',
      targetModelName: 'Gemma 12B',
      loadedModelName: 'Qwen 4B',
    });
    expect(e.blurb).toContain('Gemma 12B');
    expect(e.blurb).toContain('Qwen 4B');
    expect(e.blurb).toContain('one model at a time');
    expect(e.hint).toContain('free up the model');
  });

  it('insufficient-ram explains the memory shortfall', () => {
    const e = queueExplainer({ kind: 'insufficient-ram', targetModelName: 'Qwen 122B' });
    expect(e.blurb).toContain('Qwen 122B');
    expect(e.blurb).toContain('memory');
  });

  it('unknown model names degrade gracefully', () => {
    const e = queueExplainer({ kind: 'busy-switch-model' });
    expect(e.blurb).toContain('the selected model');
    expect(e.blurb).toContain('the current model');
  });

  it('no reason → the generic queued explanation', () => {
    const e = queueExplainer(undefined);
    expect(e.blurb).toContain('queued');
    expect(e.hint).toContain('pause or stop');
  });
});
