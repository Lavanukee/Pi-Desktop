/**
 * Composer "+" force-action plans (spec §3.2): each modality key pins the right
 * harness class + a clean prompt scaffold. Pure, node-testable.
 */
import { describe, expect, it } from 'vitest';
import { CLASS_LABELS } from '../settings/panels/agent-presets';
import { GEN_ACTION_PLANS, type GenActionKey } from './composer-gen-actions';

const KEYS: GenActionKey[] = ['image', 'video', 'motion', 'perception'];

describe('GEN_ACTION_PLANS', () => {
  it('pins each "+" action to its harness task class', () => {
    expect(GEN_ACTION_PLANS.image.forcedClass).toBe('2d-art');
    expect(GEN_ACTION_PLANS.video.forcedClass).toBe('advanced-video');
    expect(GEN_ACTION_PLANS.motion.forcedClass).toBe('motion-graphics');
    expect(GEN_ACTION_PLANS.perception.forcedClass).toBe('perception');
  });

  it('only pins classes the harness taxonomy actually defines', () => {
    for (const key of KEYS) {
      expect(GEN_ACTION_PLANS[key].forcedClass in CLASS_LABELS).toBe(true);
    }
  });

  it('scaffolds are non-empty natural-language leads (never a `/slash` command)', () => {
    for (const key of KEYS) {
      const { scaffold } = GEN_ACTION_PLANS[key];
      expect(scaffold.trim().length).toBeGreaterThan(0);
      expect(scaffold.startsWith('/')).toBe(false);
      // Trailing space so the caret lands where the user types the subject.
      expect(scaffold.endsWith(' ')).toBe(true);
    }
  });
});
