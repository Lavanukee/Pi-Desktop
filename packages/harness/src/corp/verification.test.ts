import { describe, expect, it } from 'vitest';
import {
  classifyVerification,
  extractClaims,
  finalCheck,
  verificationBriefing,
} from './verification.js';

describe('classifyVerification', () => {
  it('sees a game as visual, functional, drivable, and needing its engine', () => {
    const p = classifyVerification('Build a 2D platformer game in Godot 4 with a coin counter');
    expect(p).toMatchObject({ visual: true, functional: true, ui: true, runtime: 'godot' });
  });

  it('does not call a parser visual', () => {
    const p = classifyVerification('Write a script that converts a CSV to JSON');
    expect(p.visual).toBe(false);
    expect(p.functional).toBe(true);
  });

  it('names no runtime when none is implied', () => {
    expect(classifyVerification('summarise this document').runtime).toBeNull();
  });
});

describe('verificationBriefing', () => {
  it('says what checking means, and names the runtime to establish first', () => {
    const text = verificationBriefing(classifyVerification('a Godot game'));
    expect(text).toContain('LOOK at');
    expect(text).toContain('`godot`');
    expect(text).toContain('before you build');
  });

  /* A briefing that says nothing teaches the role to skim the next one. */
  it('is empty when the text implies nothing in particular', () => {
    expect(
      verificationBriefing({ visual: false, functional: false, ui: false, runtime: null }),
    ).toBe('');
  });
});

describe('extractClaims', () => {
  it('splits bullets and sentences, and drops headings', () => {
    const claims = extractClaims(
      '## Status Update\n- Built the player controller in player.gd\n- Created four sprite files',
      'The scene opens in Godot and the coin counter increments.',
    );
    expect(claims).toContain('Built the player controller in player.gd');
    expect(claims).toContain('Created four sprite files');
    expect(claims.some((c) => c.startsWith('The scene opens in Godot'))).toBe(true);
    expect(claims.some((c) => c.includes('Status Update'))).toBe(false);
  });

  it('drops fragments too short to be an assertion, and de-duplicates', () => {
    expect(extractClaims('Done\n✓\nok')).toEqual([]);
    expect(extractClaims('The build passes cleanly', 'The build passes cleanly')).toHaveLength(1);
  });
});

describe('finalCheck', () => {
  const profile = { visual: true, functional: true, ui: true, runtime: 'godot' };

  it('numbers the claims back and refuses to let one stand undischarged', () => {
    const text = finalCheck({
      claims: ['Created four sprite files', 'The scene opens in Godot'],
      profile,
      perspective: 'engineer',
    });
    expect(text).toContain('1. Created four sprite files');
    expect(text).toContain('2. The scene opens in Godot');
    expect(text).toContain('comes OUT of your report, or you go and make it true');
  });

  it('asks the manager to read it as the CEO, and the CEO as the user', () => {
    const mgr = finalCheck({ claims: ['x is done'], profile, perspective: 'manager' });
    expect(mgr).toContain('as THE CEO will');
    expect(mgr).toContain('gave you the vision');

    const ceo = finalCheck({
      claims: ['x is done'],
      profile,
      perspective: 'ceo',
      vision: 'build me a platformer',
    });
    expect(ceo).toContain('as THE USER will');
    expect(ceo).toContain('Did this work out, in the end, as they asked?');
    expect(ceo).toContain('build me a platformer');
  });

  /* The failure this exists for: asserting a project runs in an engine that was
   * never launched. Run 6 did exactly that with Godot installed and briefed. */
  it('demands the work actually be opened in its runtime', () => {
    const text = finalCheck({ claims: ['it opens'], profile, perspective: 'engineer' });
    expect(text).toContain('OPEN THE WORK IN IT');
    expect(text).toContain('never launched');
  });

  it('offers specialists always, and drops the checks that do not apply', () => {
    const plain = finalCheck({
      claims: ['it parses'],
      profile: { visual: false, functional: true, ui: false, runtime: null },
      perspective: 'engineer',
    });
    expect(plain).toContain('USE THE SPECIALISTS');
    expect(plain).not.toContain('ANYTHING VISUAL');
    expect(plain).not.toContain('ANY UI');
  });
});
