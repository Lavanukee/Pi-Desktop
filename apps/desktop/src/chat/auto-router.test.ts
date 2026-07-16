/**
 * Round-12 Auto router (W3) — pure core. Covers the tier resolution
 * (classify → tier), the sticky-up / lazy-down hysteresis, the same-model no-op
 * guard, the not-downloaded → download-prompt rule, the debounce, and the
 * friendly auto-download card copy.
 */
import { describe, expect, it } from 'vitest';
import type { LlmTierPick } from '../../electron/ipc-contract';
import {
  DOWNGRADE_TURNS,
  decideRoute,
  downloadPromptView,
  explicitSwitchAction,
  formatTierBytes,
  pickPreloadModel,
  type RouteInputs,
  type RouterMemory,
  SWITCH_DEBOUNCE_MS,
  tierForModelId,
  tierForPrompt,
  tierSpeed,
} from './auto-router';

const FRESH: RouterMemory = { pendingDowngrade: null, lastSwitchAt: 0 };
// A `now` far past the debounce window so switches are never debounced by default.
const LATE = SWITCH_DEBOUNCE_MS * 100;

function pick(modelId: string, over: Partial<LlmTierPick> = {}): LlmTierPick {
  return {
    modelId,
    displayName: modelId,
    quant: 'Q4_K_M',
    launchMode: 'fast-text',
    vision: false,
    bytes: 8e9,
    downloaded: true,
    ...over,
  };
}

describe('tierForPrompt (classify → tier)', () => {
  it('routes a short knowledge question to fast', () => {
    expect(tierForPrompt('what is the capital of France?')).toBe('fast');
  });
  it('routes a coding task to intelligent', () => {
    expect(tierForPrompt('refactor this module and fix the failing unit test')).toBe('intelligent');
  });
  it('routes a web lookup to balanced', () => {
    expect(tierForPrompt('search the web for today’s weather in Tokyo')).toBe('balanced');
  });

  // Composer "+" force-actions carry a forcedClass through the classify path so
  // the routed model matches the pinned task class regardless of the prompt.
  it('honors forcedClass — advanced-video pins intelligent, overriding a fast prompt', () => {
    // Same prompt that routes to fast above…
    expect(tierForPrompt('what is the capital of France?')).toBe('fast');
    // …is overridden to advanced-video's tier when the "+" action forces it.
    expect(tierForPrompt('what is the capital of France?', { forcedClass: 'advanced-video' })).toBe(
      'intelligent',
    );
  });

  it('honors forcedClass — perception pins balanced', () => {
    expect(tierForPrompt('hello', { forcedClass: 'perception' })).toBe('balanced');
  });
});

// The app router must classify a task the SAME way the harness does, or the two
// disagree on the model mid-task. The seam: the harness's published `activeClass`
// is threaded back in as the continuity prior (+ a non-zero turnIndex), so a terse
// follow-up inherits the task class instead of being reclassified from scratch.
describe('tierForPrompt — harness continuity (app ↔ harness agreement)', () => {
  it('a bare "continue" with no prior class falls back to its own weak class', () => {
    expect(tierForPrompt('continue')).toBe('balanced');
  });

  it('inherits the harness prior class on a terse follow-up (matches harness tier-1)', () => {
    // Fed the harness's activeClass=coding as the prior, "continue" inherits the
    // coding task → intelligent, so the app router agrees with the harness.
    expect(tierForPrompt('continue', { priorClass: 'coding', turnIndex: 1 })).toBe('intelligent');
  });

  it('turnIndex 0 (first turn of a session) ignores the prior — no spurious continuation', () => {
    expect(tierForPrompt('continue', { priorClass: 'coding', turnIndex: 0 })).toBe('balanced');
  });
});

describe('tierForModelId', () => {
  const models = {
    fast: pick('gemma-4-e2b-it'),
    balanced: pick('gemma-4-12b-it'),
    intelligent: pick('qwen3.6-27b-mtp'),
  };
  it('maps a running model id back to its tier', () => {
    expect(tierForModelId(models, 'gemma-4-12b-it')).toBe('balanced');
    expect(tierForModelId(models, 'qwen3.6-27b-mtp')).toBe('intelligent');
  });
  it('is null for an unknown / absent model', () => {
    expect(tierForModelId(models, 'some-other-model')).toBeNull();
    expect(tierForModelId(models, null)).toBeNull();
    expect(tierForModelId(undefined, 'gemma-4-12b-it')).toBeNull();
  });
});

describe('decideRoute — hysteresis', () => {
  it('UPGRADE happens immediately (fast → intelligent)', () => {
    const d = decideRoute(FRESH, {
      currentTier: 'fast',
      desiredTier: 'intelligent',
      targetModelId: 'big',
      currentModelId: 'small',
      downloaded: true,
      now: LATE,
    });
    expect(d.action).toBe('switch');
    expect(d.memory.lastSwitchAt).toBe(LATE);
  });

  it('initial routing (no current tier) switches straight away', () => {
    const d = decideRoute(FRESH, {
      currentTier: null,
      desiredTier: 'balanced',
      targetModelId: 'mid',
      currentModelId: null,
      downloaded: true,
      now: LATE,
    });
    expect(d.action).toBe('switch');
    expect(d.reason).toBe('initial');
  });

  it(`DOWNGRADE waits ${DOWNGRADE_TURNS} turns, then switches`, () => {
    const inputs = {
      currentTier: 'intelligent' as const,
      desiredTier: 'fast' as const,
      targetModelId: 'small',
      currentModelId: 'big',
      downloaded: true,
      now: LATE,
    };
    // Turn 1: wants fast, but holds (lazy-down not satisfied yet).
    const t1 = decideRoute(FRESH, inputs);
    expect(t1.action).toBe('none');
    expect(t1.reason).toBe('lazy-down-waiting');
    expect(t1.memory.pendingDowngrade).toEqual({ tier: 'fast', count: 1 });

    // Turn 2: still wants fast → now the downgrade fires.
    const t2 = decideRoute(t1.memory, inputs);
    expect(t2.action).toBe('switch');
    expect(t2.memory.pendingDowngrade).toBeNull();
  });

  it('a re-upgrade during a pending downgrade cancels the lazy-down', () => {
    // One turn wanted to drop to fast…
    const t1 = decideRoute(FRESH, {
      currentTier: 'intelligent',
      desiredTier: 'fast',
      targetModelId: 'small',
      currentModelId: 'big',
      downloaded: true,
      now: LATE,
    });
    expect(t1.action).toBe('none');
    // …then the next turn wants intelligent again (same as current) → no switch,
    // and the pending downgrade is cleared.
    const t2 = decideRoute(t1.memory, {
      currentTier: 'intelligent',
      desiredTier: 'intelligent',
      targetModelId: 'big',
      currentModelId: 'big',
      downloaded: true,
      now: LATE,
    });
    expect(t2.action).toBe('none');
    expect(t2.reason).toBe('same-model');
    expect(t2.memory.pendingDowngrade).toBeNull();
  });

  it('NEVER switches when the target model already runs (two tiers share a model)', () => {
    const d = decideRoute(FRESH, {
      currentTier: 'balanced',
      desiredTier: 'intelligent',
      targetModelId: 'gemma-4-12b-it', // same id as what is running
      currentModelId: 'gemma-4-12b-it',
      downloaded: true,
      now: LATE,
    });
    expect(d.action).toBe('none');
    expect(d.reason).toBe('same-model');
  });

  it('never auto-switches to an undownloaded model → download-prompt', () => {
    const d = decideRoute(FRESH, {
      currentTier: 'fast',
      desiredTier: 'intelligent',
      targetModelId: 'big',
      currentModelId: 'small',
      downloaded: false,
      now: LATE,
    });
    expect(d.action).toBe('download-prompt');
  });

  it('debounces a warranted switch inside the debounce window', () => {
    const d = decideRoute(
      { pendingDowngrade: null, lastSwitchAt: 1000 },
      {
        currentTier: 'fast',
        desiredTier: 'intelligent',
        targetModelId: 'big',
        currentModelId: 'small',
        downloaded: true,
        now: 1000 + SWITCH_DEBOUNCE_MS - 1,
      },
    );
    expect(d.action).toBe('none');
    expect(d.reason).toBe('debounced');
  });
});

describe('decideRoute — in-flight lock (never switch mid-task)', () => {
  // A warranted upgrade that WOULD switch at a clean idle boundary.
  const upgrade: RouteInputs = {
    currentTier: 'fast',
    desiredTier: 'intelligent',
    targetModelId: 'big',
    currentModelId: 'small',
    downloaded: true,
    now: LATE,
  };

  it('an in-flight send does NOT switch — the model is locked for the task', () => {
    // Baseline: the exact same inputs switch when the turn is idle…
    expect(decideRoute(FRESH, upgrade).action).toBe('switch');
    // …but hold when a turn is in flight.
    const busy = decideRoute(FRESH, { ...upgrade, inFlight: true });
    expect(busy.action).toBe('none');
    expect(busy.reason).toBe('in-flight');
  });

  it('leaves cross-turn memory UNTOUCHED (a queued send is not a routing decision)', () => {
    const mem: RouterMemory = { pendingDowngrade: { tier: 'fast', count: 1 }, lastSwitchAt: 4242 };
    // No debounce stamp advanced, no lazy-down counted while in flight.
    expect(decideRoute(mem, { ...upgrade, inFlight: true }).memory).toEqual(mem);
  });

  it('fresh-task Auto still routes: an idle initial pick switches straight away', () => {
    const fresh = decideRoute(FRESH, {
      currentTier: null,
      desiredTier: 'balanced',
      targetModelId: 'mid',
      currentModelId: null,
      downloaded: true,
      now: LATE,
      inFlight: false,
    });
    expect(fresh.action).toBe('switch');
    expect(fresh.reason).toBe('initial');
  });
});

describe('explicitSwitchAction (explicit user pick — bypasses the in-flight gate)', () => {
  // The explicit path takes NO `inFlight` argument by design: a user model change
  // is always honored, even mid-stream (the one thing allowed to switch mid-task).
  it('switches to a different downloaded model', () => {
    expect(
      explicitSwitchAction({ downloaded: true, targetModelId: 'big', currentModelId: 'small' }),
    ).toBe('switch');
  });

  it('is a no-op when the target model already runs', () => {
    expect(
      explicitSwitchAction({ downloaded: true, targetModelId: 'big', currentModelId: 'big' }),
    ).toBe('none');
  });

  it('opens the download flow for an undownloaded model instead of switching', () => {
    expect(
      explicitSwitchAction({ downloaded: false, targetModelId: 'big', currentModelId: 'small' }),
    ).toBe('download-prompt');
  });
});

describe('downloadPromptView + formatTierBytes', () => {
  it('formats GB with one decimal under 10, none at/above; empty when unknown', () => {
    expect(formatTierBytes(2.53e9)).toBe('2.5 GB');
    expect(formatTierBytes(16e9)).toBe('16 GB');
    expect(formatTierBytes(0)).toBe('');
  });

  it('builds friendly, jargon-free copy for an undownloaded tier', () => {
    const view = downloadPromptView({
      tier: 'intelligent',
      pick: pick('qwen3.6-27b-mtp', { displayName: 'qwen3.6 27b', bytes: 16e9, downloaded: false }),
    });
    expect(view).toEqual({
      title: 'Download intelligent model',
      detail: 'qwen3.6 27b · 16 GB',
      modelId: 'qwen3.6-27b-mtp',
      quant: 'Q4_K_M',
    });
  });

  it('is null when nothing is pending', () => {
    expect(downloadPromptView(null)).toBeNull();
  });
});

describe('tierSpeed', () => {
  it('maps each capability tier to its felt-speed word (smarter = slower)', () => {
    expect(tierSpeed('fast')).toBe('fast');
    expect(tierSpeed('balanced')).toBe('balanced');
    expect(tierSpeed('intelligent')).toBe('slow');
  });
});

describe('pickPreloadModel (startup — a model is ALWAYS loaded)', () => {
  const tierModels = {
    fast: pick('gemma-4-e2b-it'),
    balanced: pick('gemma-4-12b-it'),
    intelligent: pick('qwen3.6-27b-mtp'),
  };

  it('preloads the FASTEST downloaded model (the fast tier wins when it is on disk)', () => {
    expect(
      pickPreloadModel({
        tierModels,
        downloadedModelIds: ['gemma-4-e2b-it', 'gemma-4-12b-it'],
        serverRunning: false,
        currentModelId: null,
      }),
    ).toEqual({ modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M' });
  });

  it('falls through to the next-fastest downloaded tier when fast is not on disk', () => {
    expect(
      pickPreloadModel({
        tierModels,
        downloadedModelIds: ['gemma-4-12b-it', 'qwen3.6-27b-mtp'],
        serverRunning: false,
        currentModelId: null,
      }),
    ).toEqual({ modelId: 'gemma-4-12b-it', quant: 'Q4_K_M' });
  });

  it('is null when a model is already resident (never preempts a running server)', () => {
    expect(
      pickPreloadModel({
        tierModels,
        downloadedModelIds: ['gemma-4-e2b-it'],
        serverRunning: true,
        currentModelId: 'gemma-4-e2b-it',
      }),
    ).toBeNull();
  });

  it('is null before the catalog loads, or when nothing is downloaded yet', () => {
    expect(
      pickPreloadModel({
        tierModels: undefined,
        downloadedModelIds: [],
        serverRunning: false,
        currentModelId: null,
      }),
    ).toBeNull();
    expect(
      pickPreloadModel({
        tierModels,
        downloadedModelIds: [],
        serverRunning: false,
        currentModelId: null,
      }),
    ).toBeNull();
  });
});
