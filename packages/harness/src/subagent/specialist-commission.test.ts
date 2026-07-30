import { describe, expect, it } from 'vitest';
import {
  capabilitiesForSpecialist,
  composeCommission,
  DEFAULT_IMAGE_ITERATIONS,
  imageLoopProtocol,
  MESH_SPECIALIST_KINDS,
  normalizeSpecialist,
} from './specialist-commission.js';

describe('normalizeSpecialist', () => {
  it('accepts the canonical names', () => {
    for (const k of MESH_SPECIALIST_KINDS) expect(normalizeSpecialist(k)).toBe(k);
  });

  it('is tolerant of how a model writes it', () => {
    expect(normalizeSpecialist('UI Critic')).toBe('ui-critic');
    expect(normalizeSpecialist('ui_critic')).toBe('ui-critic');
    expect(normalizeSpecialist('  Image  ')).toBe('image');
  });

  it('rejects an unknown kind rather than guessing', () => {
    expect(normalizeSpecialist('poet')).toBeUndefined();
  });
});

describe('capabilitiesForSpecialist', () => {
  it('names the browser for the specialists that must open something', () => {
    expect(capabilitiesForSpecialist('ui-critic')).toContain('browser');
    expect(capabilitiesForSpecialist('research')).toContain('browser');
  });

  it('names generation for the image specialist', () => {
    expect(capabilitiesForSpecialist('image')).toContain('generation');
  });
});

describe('imageLoopProtocol', () => {
  /* jedd's spec, clause by clause: "for n iterations, model generates an initial
   * image, decides, edit or try again from scratch at each iteration and also at
   * each iteration indicates if the newest one is better than the current best,
   * if so, replace it, otherwise discard (initial one from raw user prompt starts
   * as the current best)" */
  const p = imageLoopProtocol(3);

  it('starts the incumbent from the raw user prompt', () => {
    expect(p).toMatch(/prompt as given[\s\S]*CURRENT\s+BEST/i);
  });

  it('offers both moves each pass', () => {
    expect(p).toContain('EDIT the current best');
    expect(p).toContain('START OVER');
  });

  it('demands an explicit better/not-better verdict', () => {
    expect(p).toContain('BETTER than current best');
    expect(p).toContain('NOT better than current best');
  });

  it('replaces on better and discards otherwise', () => {
    expect(p).toMatch(/If BETTER: the candidate becomes the current best/);
    expect(p).toMatch(/If NOT: discard it/);
  });

  it('takes the pass count', () => {
    expect(imageLoopProtocol(1)).toContain('1 pass');
    expect(imageLoopProtocol(5)).toContain('5 passes');
  });

  it('clamps a nonsense count instead of emitting it', () => {
    expect(imageLoopProtocol(0)).toContain('1 pass');
    expect(imageLoopProtocol(999)).toContain('8 passes');
  });

  /* The loop is only real because tool-result images now reach the model. If a
   * child cannot see one, inventing the comparison is the failure mode. */
  it('stops the loop rather than inventing a comparison it could not make', () => {
    expect(p).toContain('BE HONEST ABOUT YOUR EYES');
    expect(p).toMatch(/cannot see it, SAY SO PLAINLY and stop/);
  });
});

describe('composeCommission', () => {
  it('puts the charter first and the commission last', () => {
    const out = composeCommission({ kind: 'ui-critic', goal: 'Judge the settings panel.' });
    expect(out).toContain('You are the UI CRITIC');
    expect(out.indexOf('You are the UI CRITIC')).toBeLessThan(out.indexOf('YOUR COMMISSION'));
    expect(out.trimEnd().endsWith('Judge the settings panel.')).toBe(true);
  });

  it('tells the child which capability to switch on', () => {
    const out = composeCommission({ kind: 'research', goal: 'Survey the docs.' });
    expect(out).toContain('capability');
    expect(out).toContain('browser');
  });

  it('adds the pass loop for the image specialist only', () => {
    const img = composeCommission({ kind: 'image', goal: 'A hero image.' });
    expect(img).toContain('YOUR WORKING LOOP');
    const critic = composeCommission({ kind: 'ui-critic', goal: 'Judge it.' });
    expect(critic).not.toContain('YOUR WORKING LOOP');
  });

  it('honours a caller-chosen pass count', () => {
    expect(composeCommission({ kind: 'image', goal: 'x', iterations: 5 })).toContain('5 passes');
    expect(composeCommission({ kind: 'image', goal: 'x' })).toContain(
      `${DEFAULT_IMAGE_ITERATIONS} passes`,
    );
  });

  it('passes an unknown kind straight through as a plain goal', () => {
    expect(composeCommission({ kind: 'poet', goal: 'Write a sonnet.' })).toBe('Write a sonnet.');
  });

  it('works for every kind we advertise', () => {
    for (const k of MESH_SPECIALIST_KINDS) {
      const out = composeCommission({ kind: k, goal: 'do the thing' });
      expect(out).toContain('YOUR COMMISSION');
      expect(out.length).toBeGreaterThan(200);
    }
  });
});
