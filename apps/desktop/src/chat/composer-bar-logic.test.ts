import type { ChatMsg } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import {
  classificationHover,
  contextGaugeFromPercent,
  deriveContextGauge,
  effortDisplay,
  effortSliderView,
  levelForIndex,
  resolveContextGauge,
  tierLabel,
  usesSandbox,
} from './composer-bar-logic';

/**
 * The composer-bar display logic (round-12 W2): the CENTER tier label + its
 * classification hover, and the RIGHT effort-slider view (Auto ↔ tier ↔ level).
 * ComposerBar.tsx renders these; the desktop test env is node, so the mapping
 * is tested here (no DOM).
 */
describe('tierLabel', () => {
  it('maps the active tier to its user-facing label; null before classify', () => {
    expect(tierLabel('fast')).toBe('Fast');
    expect(tierLabel('balanced')).toBe('Balanced');
    expect(tierLabel('intelligent')).toBe('Intelligent');
    expect(tierLabel(null)).toBeNull();
  });
});

describe('classificationHover', () => {
  it('builds "request categorized as <class>" (dashes → spaces)', () => {
    expect(classificationHover('basic-tools')).toBe('request categorized as basic tools');
    expect(classificationHover('coding')).toBe('request categorized as coding');
    expect(classificationHover('simple-QA')).toBe('request categorized as simple QA');
  });

  it('is null with no class', () => {
    expect(classificationHover(null)).toBeNull();
    expect(classificationHover(undefined)).toBeNull();
  });
});

/**
 * The folder chip's SANDBOX state (jedd #13): true when a project is selected but
 * pi's live cwd isn't inside it (its folder went missing and the harness rerouted
 * to the conversation sandbox), so the chip shows "Sandbox" instead of the stale
 * project name. Prefers an explicit flag; otherwise infers from the session cwd.
 */
describe('usesSandbox', () => {
  const proj = '/tmp/pi-rt8-project';
  const sandbox = '/Users/jedd/.pi/desktop/sandbox/abc123';

  it('true when a project is selected but pi fell back to the conversation sandbox', () => {
    expect(usesSandbox(proj, sandbox)).toBe(true);
    expect(usesSandbox(proj, `${sandbox}/notes`)).toBe(true); // a subdir of the sandbox
  });

  it('false when pi is running inside the selected project (root or a descendant)', () => {
    expect(usesSandbox(proj, proj)).toBe(false);
    expect(usesSandbox(proj, `${proj}/src/app`)).toBe(false);
  });

  it('does NOT false-warn when the OS realpaths the project folder (/tmp vs /private/tmp)', () => {
    // A naive "cwd !== project path" check would wrongly flag this as sandbox.
    expect(usesSandbox('/tmp/foo', '/private/tmp/foo')).toBe(false);
  });

  it('false when no project is selected — that is the plain "No project" state', () => {
    expect(usesSandbox(null, sandbox)).toBe(false);
  });

  it('false before the session cwd is known (avoids a false warning on load)', () => {
    expect(usesSandbox(proj, null)).toBe(false);
    expect(usesSandbox(proj, undefined)).toBe(false);
    expect(usesSandbox(proj, '')).toBe(false);
  });

  it('an explicit store flag wins over the cwd inference (either direction)', () => {
    expect(usesSandbox(proj, proj, true)).toBe(true);
    expect(usesSandbox(proj, sandbox, false)).toBe(false);
  });
});

describe('effortDisplay', () => {
  it('maps the effort scale to display names, with the mid/auto default → "Balanced"', () => {
    expect(effortDisplay('low')).toBe('Low');
    expect(effortDisplay('medium')).toBe('Balanced');
    expect(effortDisplay('high')).toBe('High');
    expect(effortDisplay('max')).toBe('Max');
  });
});

describe('effortSliderView', () => {
  it('auto: the label reads "Effort · Adaptive" while the tier still drives the slider position', () => {
    // fast → the knob rests at the low detent, but the readout says "Adaptive".
    expect(effortSliderView('auto', 'medium', 'fast')).toMatchObject({
      auto: true,
      index: 0,
      fill: 0,
      label: 'Effort · Adaptive',
      valueText: 'Effort, adaptive',
    });

    // balanced → the knob sits at the mid detent; the label stays "Effort · Adaptive".
    const bal = effortSliderView('auto', 'low', 'balanced');
    expect(bal.auto).toBe(true);
    expect(bal.label).toBe('Effort · Adaptive');
    expect(bal.valueText).toBe('Effort, adaptive');
    expect(bal.index).toBe(1); // medium — the routed position, not the readout
    expect(bal.fill).toBeCloseTo(1 / 3, 5);

    // intelligent → the knob rests at the tick below max; still "Effort · Adaptive".
    const smart = effortSliderView('auto', 'low', 'intelligent');
    expect(smart.label).toBe('Effort · Adaptive');
    expect(smart.valueText).toBe('Effort, adaptive');
    expect(smart.index).toBe(2);
    expect(smart.fill).toBeCloseTo(2 / 3, 5);
  });

  it('auto + no tier yet: still reads "Effort · Adaptive", resting the knob on the explicit level', () => {
    expect(effortSliderView('auto', 'high', null)).toMatchObject({
      auto: true,
      label: 'Effort · Adaptive',
      valueText: 'Effort, adaptive',
      index: 2, // the knob rests on the last explicit level
    });
    // Regardless of the resting level, the auto readout is "Adaptive" (jedd #12 —
    // a distinct word from the model chip's "Auto").
    expect(effortSliderView('auto', 'medium', null).label).toBe('Effort · Adaptive');
  });

  it('level mode: pins the explicit level (max reachable), ignoring the tier', () => {
    expect(effortSliderView('level', 'max', 'fast')).toMatchObject({
      auto: false,
      index: 3,
      fill: 1,
      label: 'Effort · Max',
    });
    expect(effortSliderView('level', 'low', 'intelligent')).toMatchObject({
      auto: false,
      index: 0,
      fill: 0,
      label: 'Effort · Low',
    });
  });
});

describe('levelForIndex', () => {
  it('maps a detent index back to its effort level (clamped)', () => {
    expect(levelForIndex(0)).toBe('low');
    expect(levelForIndex(1)).toBe('medium');
    expect(levelForIndex(2)).toBe('high');
    expect(levelForIndex(3)).toBe('max');
    expect(levelForIndex(-1)).toBe('low');
    expect(levelForIndex(9)).toBe('max');
  });
});

/**
 * The context-fullness ring (round-A #5) moved to the composer bar (left of
 * Effort). `deriveContextGauge` computes its value from the most recent assistant
 * turn's total tokens over the launched context window — tested here (node env).
 */
describe('deriveContextGauge', () => {
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const user = (id: string): ChatMsg => ({ kind: 'user', id, text: 'hi', timestamp: 0 });
  const assistant = (id: string, totalTokens?: number): ChatMsg => ({
    kind: 'assistant',
    id,
    blocks: [],
    timestamp: 0,
    ...(totalTokens !== undefined
      ? {
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens,
            cost: zeroCost,
          },
        }
      : {}),
  });

  it('uses the MOST RECENT assistant turn that carries usage', () => {
    const messages = [assistant('a1', 1000), user('u2'), assistant('a2', 4000)];
    expect(deriveContextGauge(messages, 8000)).toEqual({ value: 0.5, usedTokens: 4000 });
  });

  it('clamps the fullness fraction to 1 when usage exceeds the window', () => {
    expect(deriveContextGauge([assistant('a', 9000)], 8000)).toEqual({
      value: 1,
      usedTokens: 9000,
    });
  });

  it('is null with no measured turn, and null when the context window is unknown (0)', () => {
    expect(deriveContextGauge([user('u'), assistant('a')], 8000)).toBeNull();
    expect(deriveContextGauge([assistant('a', 4000)], 0)).toBeNull();
    expect(deriveContextGauge([], 8000)).toBeNull();
  });
});

/**
 * R14 A5 — the ring reflects pi's OWN accounting (harness `contextPercent` from
 * `ctx.getContextUsage()`), so it updates on every provider and is no longer
 * stuck to needing both a launched llama window AND provider-reported tokens.
 */
describe('contextGaugeFromPercent', () => {
  it('drives the ring straight from pi’s percent, window-independent', () => {
    // No local llama window (0) but pi reports 42% → the ring still renders.
    expect(contextGaugeFromPercent(42, 0)).toEqual({ value: 0.42, usedTokens: 0 });
    // With a known window, used tokens are derived for the tooltip.
    expect(contextGaugeFromPercent(50, 8000)).toEqual({ value: 0.5, usedTokens: 4000 });
  });

  it('clamps to 0..1 and ignores a null/undefined/NaN percent', () => {
    expect(contextGaugeFromPercent(140, 8000)?.value).toBe(1);
    expect(contextGaugeFromPercent(-5, 8000)?.value).toBe(0);
    expect(contextGaugeFromPercent(null, 8000)).toBeNull();
    expect(contextGaugeFromPercent(undefined, 8000)).toBeNull();
    expect(contextGaugeFromPercent(Number.NaN, 8000)).toBeNull();
  });
});

describe('resolveContextGauge', () => {
  const assistantMsg = (id: string, totalTokens: number): ChatMsg => ({
    kind: 'assistant',
    id,
    blocks: [],
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  it('PREFERS pi’s harness percent over the token/window fallback', () => {
    // Harness says 30% even though token math over the window would say ~50%.
    const gauge = resolveContextGauge({
      contextPercent: 30,
      messages: [assistantMsg('a', 4000)],
      contextWindow: 8000,
    });
    expect(gauge).toEqual({ value: 0.3, usedTokens: 2400 });
  });

  it('falls back to token/window math when the harness has NOT reported a percent', () => {
    const gauge = resolveContextGauge({
      contextPercent: null,
      messages: [assistantMsg('a', 4000)],
      contextWindow: 8000,
    });
    expect(gauge).toEqual({ value: 0.5, usedTokens: 4000 });
  });

  it('renders from the harness percent even with NO launched window (the stuck-ring case)', () => {
    // Remote/AFM provider: window 0, no usage tokens — the old ring was null here.
    const gauge = resolveContextGauge({
      contextPercent: 12,
      messages: [{ kind: 'user', id: 'u', text: 'hi', timestamp: 0 }],
      contextWindow: 0,
    });
    expect(gauge).toEqual({ value: 0.12, usedTokens: 0 });
  });

  it('is null when neither source has anything to show', () => {
    expect(
      resolveContextGauge({ contextPercent: null, messages: [], contextWindow: 0 }),
    ).toBeNull();
  });
});
