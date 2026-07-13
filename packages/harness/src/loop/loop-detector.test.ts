import { describe, expect, it } from 'vitest';
import { effortKnobs } from '../effort/effort.js';
import {
  createLoopDetector,
  DEFAULT_LOOP_ABORT_AFTER,
  DEFAULT_LOOP_STEER_AFTER,
  DEFAULT_WANDER_ABORT_AFTER,
  DEFAULT_WANDER_STEER_AFTER,
  isExplorationTool,
  type LoopDetectorConfig,
  loopDetectorConfig,
  toolCallSignature,
} from './loop-detector.js';

const CFG: LoopDetectorConfig = { steerAfter: 3, abortAfter: 5, maxSteps: 20 };

describe('toolCallSignature', () => {
  it('is stable across argument key order', () => {
    expect(toolCallSignature('read', { path: '/a', mode: 'r' })).toBe(
      toolCallSignature('read', { mode: 'r', path: '/a' }),
    );
  });

  it('differs on tool name, args, or nested values', () => {
    expect(toolCallSignature('read', { path: '/a' })).not.toBe(
      toolCallSignature('write', { path: '/a' }),
    );
    expect(toolCallSignature('read', { path: '/a' })).not.toBe(
      toolCallSignature('read', { path: '/b' }),
    );
    expect(toolCallSignature('x', { a: [1, 2] })).not.toBe(toolCallSignature('x', { a: [2, 1] }));
  });

  it('tolerates undefined / null args', () => {
    expect(toolCallSignature('t', undefined)).toBe(toolCallSignature('t', null));
  });
});

describe('identical-call streak', () => {
  it('steers once at steerAfter, then aborts at abortAfter', () => {
    const d = createLoopDetector(CFG);
    const call = () => d.onToolCall('bash', { command: 'ls' });
    expect(call().kind).toBe('none'); // 1
    expect(call().kind).toBe('none'); // 2
    const third = call(); // 3 → steer
    expect(third.kind).toBe('steer');
    if (third.kind === 'steer') {
      expect(third.cause).toBe('identical');
      expect(third.message.length).toBeGreaterThan(0);
    }
    expect(call().kind).toBe('none'); // 4 — already steered, no repeat steer
    const fifth = call(); // 5 → abort
    expect(fifth.kind).toBe('abort');
    if (fifth.kind === 'abort') expect(fifth.cause).toBe('identical');
  });

  it('resets the streak when a different call interrupts it', () => {
    const d = createLoopDetector(CFG);
    d.onToolCall('bash', { command: 'ls' });
    d.onToolCall('bash', { command: 'ls' });
    expect(d.snapshot().identicalStreak).toBe(2);
    d.onToolCall('bash', { command: 'pwd' }); // different → streak resets to 1
    expect(d.snapshot().identicalStreak).toBe(1);
    // A fresh run of the same call must climb again from 1 (no early abort).
    expect(d.onToolCall('bash', { command: 'pwd' }).kind).toBe('none');
    expect(d.onToolCall('bash', { command: 'pwd' }).kind).toBe('steer');
  });
});

describe('consecutive-error streak', () => {
  it('steers once at steerAfter, then aborts at abortAfter', () => {
    const d = createLoopDetector(CFG);
    expect(d.onToolResult(true).kind).toBe('none'); // 1
    expect(d.onToolResult(true).kind).toBe('none'); // 2
    const third = d.onToolResult(true); // 3 → steer
    expect(third.kind).toBe('steer');
    if (third.kind === 'steer') expect(third.cause).toBe('error');
    expect(d.onToolResult(true).kind).toBe('none'); // 4 — already steered
    expect(d.onToolResult(true).kind).toBe('abort'); // 5 → abort
  });

  it('a success resets the error streak', () => {
    const d = createLoopDetector(CFG);
    d.onToolResult(true);
    d.onToolResult(true);
    d.onToolResult(false); // success → reset
    expect(d.snapshot().errorStreak).toBe(0);
    expect(d.onToolResult(true).kind).toBe('none'); // back to 1
  });

  it('only steers ONCE per turn across BOTH causes', () => {
    const d = createLoopDetector(CFG);
    // Trip the identical-call steer first.
    d.onToolCall('bash', { command: 'ls' });
    d.onToolCall('bash', { command: 'ls' });
    expect(d.onToolCall('bash', { command: 'ls' }).kind).toBe('steer');
    // Now trip an error streak — the single steer is already spent, so no 2nd steer.
    d.onToolResult(true);
    d.onToolResult(true);
    expect(d.onToolResult(true).kind).toBe('none');
    // …but the error streak still aborts past the 2nd threshold.
    d.onToolResult(true);
    expect(d.onToolResult(true).kind).toBe('abort');
  });
});

describe('hard step cap', () => {
  it('aborts once the per-turn tool-call cap is exceeded (varying calls, no streak)', () => {
    const d = createLoopDetector({ steerAfter: 3, abortAfter: 5, maxSteps: 4 });
    // Distinct calls each time → identical streak never trips.
    expect(d.onToolCall('bash', { command: 'a' }).kind).toBe('none'); // 1
    expect(d.onToolCall('bash', { command: 'b' }).kind).toBe('none'); // 2
    expect(d.onToolCall('bash', { command: 'c' }).kind).toBe('none'); // 3
    expect(d.onToolCall('bash', { command: 'd' }).kind).toBe('none'); // 4 (== cap, allowed)
    const over = d.onToolCall('bash', { command: 'e' }); // 5 (> cap) → abort
    expect(over.kind).toBe('abort');
    if (over.kind === 'abort') expect(over.cause).toBe('cap');
  });

  it('the cap takes priority over an identical-call abort', () => {
    const d = createLoopDetector({ steerAfter: 3, abortAfter: 99, maxSteps: 3 });
    d.onToolCall('t', { x: 1 });
    d.onToolCall('t', { x: 1 });
    d.onToolCall('t', { x: 1 }); // step 3 (== cap): identical streak=3 → steer
    const capped = d.onToolCall('t', { x: 1 }); // step 4 (> cap) → cap abort wins
    expect(capped).toMatchObject({ kind: 'abort', cause: 'cap' });
  });
});

describe('unproductive-wandering cap (productivity heuristic)', () => {
  // A generous hard cap so the wander thresholds — not the step cap — do the work.
  const WCFG: LoopDetectorConfig = {
    steerAfter: 3,
    abortAfter: 5,
    maxSteps: 50,
    wanderSteerAfter: 4,
    wanderAbortAfter: 7,
  };

  it('classifies read-only exploration vs concrete-action tools', () => {
    for (const t of [
      'read',
      'read_file',
      'ls',
      'list',
      'find',
      'glob',
      'grep',
      'tool_search',
      'update_plan',
    ]) {
      expect(isExplorationTool(t)).toBe(true);
    }
    // Writes, edits, shell, connectors, gen, asking the user — all real actions.
    for (const t of [
      'write',
      'edit',
      'bash',
      'python_run',
      'calendar_list_events',
      'send_mail',
      'ask_user',
      'web_search',
      'image_generate',
      'spawn_subagent',
    ]) {
      expect(isExplorationTool(t)).toBe(false);
    }
  });

  it('steers once after N DIFFERENT read-only calls, then aborts — the case the signature streak misses', () => {
    const d = createLoopDetector(WCFG);
    // Ten DIFFERENT files → ten distinct signatures, so the identical-call streak
    // NEVER trips (stays at 1). Only the productivity cap can catch this wander.
    const readFile = (n: number) => d.onToolCall('read', { path: `/f${n}.txt` });
    expect(readFile(1).kind).toBe('none'); // 1
    expect(readFile(2).kind).toBe('none'); // 2
    expect(readFile(3).kind).toBe('none'); // 3
    const fourth = readFile(4); // 4 → wander steer
    expect(fourth.kind).toBe('steer');
    if (fourth.kind === 'steer') {
      expect(fourth.cause).toBe('wander');
      expect(fourth.message.length).toBeGreaterThan(0);
    }
    // Proof the identical-call streak stayed inert (all paths differ).
    expect(d.snapshot().identicalStreak).toBe(1);
    expect(d.snapshot().unproductiveStreak).toBe(4);
    expect(readFile(5).kind).toBe('none'); // 5 — already steered, no repeat steer
    expect(readFile(6).kind).toBe('none'); // 6
    const seventh = readFile(7); // 7 → wander abort
    expect(seventh.kind).toBe('abort');
    if (seventh.kind === 'abort') expect(seventh.cause).toBe('wander');
  });

  it('a concrete action resets the unproductive streak', () => {
    const d = createLoopDetector(WCFG);
    d.onToolCall('read', { path: '/a' });
    d.onToolCall('ls', { path: '/' });
    d.onToolCall('grep', { q: 'x' });
    expect(d.snapshot().unproductiveStreak).toBe(3);
    d.onToolCall('write', { path: '/out.md', content: 'hi' }); // progress → reset
    expect(d.snapshot().unproductiveStreak).toBe(0);
    // Exploration climbs again from scratch — no leaked streak causing an early trip.
    expect(d.onToolCall('read', { path: '/b' }).kind).toBe('none');
    expect(d.onToolCall('read', { path: '/c' }).kind).toBe('none');
    expect(d.onToolCall('read', { path: '/d' }).kind).toBe('none');
    expect(d.onToolCall('read', { path: '/e' }).kind).toBe('steer'); // 4th since reset
  });

  it('interleaving a real action every other call never trips (productive work)', () => {
    const d = createLoopDetector(WCFG);
    for (let i = 0; i < 12; i++) {
      expect(d.onToolCall('read', { path: `/r${i}` }).kind).toBe('none');
      expect(d.onToolCall('edit', { path: `/e${i}` }).kind).toBe('none');
    }
    expect(d.snapshot().unproductiveStreak).toBe(0);
    expect(d.snapshot().steered).toBe(false);
  });

  it('shares the single per-turn steer budget with the identical-call cause, yet still aborts on wander', () => {
    // identical trips the ONE steer first; the wander cause can no longer steer,
    // but it must still be able to ABORT once its own threshold is crossed.
    const d = createLoopDetector({
      steerAfter: 3,
      abortAfter: 99, // identical won't abort — only its steer fires
      maxSteps: 50,
      wanderSteerAfter: 4,
      wanderAbortAfter: 7,
    });
    d.onToolCall('read', { path: '/same' });
    d.onToolCall('read', { path: '/same' });
    expect(d.onToolCall('read', { path: '/same' }).kind).toBe('steer'); // identical steer (budget spent)
    d.onToolCall('read', { path: '/a' }); // wander=4 → would steer, but budget spent → none
    d.onToolCall('read', { path: '/b' }); // 5
    d.onToolCall('read', { path: '/c' }); // 6
    expect(d.onToolCall('read', { path: '/d' })).toMatchObject({ kind: 'abort', cause: 'wander' }); // 7
  });

  it('falls back to the default wander thresholds when the config omits them', () => {
    const d = createLoopDetector({ steerAfter: 3, abortAfter: 5, maxSteps: 100 });
    for (let i = 0; i < DEFAULT_WANDER_STEER_AFTER - 1; i++) {
      expect(d.onToolCall('read', { path: `/f${i}` }).kind).toBe('none');
    }
    expect(d.onToolCall('read', { path: '/final' }).kind).toBe('steer');
    // Climb the rest of the way to the default abort threshold.
    for (let i = DEFAULT_WANDER_STEER_AFTER; i < DEFAULT_WANDER_ABORT_AFTER - 1; i++) {
      expect(d.onToolCall('read', { path: `/g${i}` }).kind).toBe('none');
    }
    expect(d.onToolCall('read', { path: '/last' }).kind).toBe('abort');
  });
});

describe('reset', () => {
  it('clears all per-turn state', () => {
    const d = createLoopDetector(CFG);
    d.onToolCall('bash', { command: 'ls' });
    d.onToolResult(true);
    d.reset();
    expect(d.snapshot()).toMatchObject({
      steps: 0,
      identicalStreak: 0,
      errorStreak: 0,
      steered: false,
      lastSignature: null,
    });
    // After reset a repeat must climb from scratch (no leaked streak/steer state).
    d.onToolCall('bash', { command: 'ls' });
    d.onToolCall('bash', { command: 'ls' });
    expect(d.onToolCall('bash', { command: 'ls' }).kind).toBe('steer');
  });
});

describe('loopDetectorConfig from effort knobs', () => {
  it('uses fixed streak thresholds and the effort-scaled step cap', () => {
    const low = loopDetectorConfig(effortKnobs('low'));
    const max = loopDetectorConfig(effortKnobs('max'));
    expect(low.steerAfter).toBe(DEFAULT_LOOP_STEER_AFTER);
    expect(low.abortAfter).toBe(DEFAULT_LOOP_ABORT_AFTER);
    expect(max.steerAfter).toBe(DEFAULT_LOOP_STEER_AFTER);
    expect(low.maxSteps).toBe(effortKnobs('low').maxTurnSteps);
    expect(max.maxSteps).toBeGreaterThan(low.maxSteps);
  });
});
