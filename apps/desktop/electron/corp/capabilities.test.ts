/**
 * The ledger's job is to turn "we assumed" into "we checked". What matters is
 * that it PROBES rather than guesses, that a missing thing produces a concrete
 * instruction a small model can act on, and that it never claims something is
 * present because a path happened to exist.
 */
import { describe, expect, it } from 'vitest';
import { blockedCapabilities, capabilityBriefing, probeCapabilities } from './capabilities';

describe('probing the machine', () => {
  it('always checks the universal toolchains, and finds the ones that are here', () => {
    const caps = probeCapabilities('build me a small tool');
    const names = caps.map((c) => c.name);
    expect(names).toContain('python3');
    expect(names).toContain('node');
    // node is running this test, so it is unarguably present — and the probe must
    // say so with a real version string, not an assumption.
    const node = caps.find((c) => c.name === 'node');
    expect(node?.present).toBe(true);
    expect(node?.detail).toMatch(/^v?\d+\./);
  });

  it('only probes what the task is plausibly about', () => {
    const plain = probeCapabilities('write me a CSV tool').map((c) => c.name);
    expect(plain).not.toContain('godot');

    const game = probeCapabilities('build a flight sim in Godot 4').map((c) => c.name);
    expect(game).toContain('godot');
  });

  it('probes YAML and test tooling for the converter task', () => {
    const names = probeCapabilities('convert between JSON, CSV and YAML, and include a test').map(
      (c) => c.name,
    );
    expect(names).toContain('pyyaml');
    expect(names).toContain('pytest');
  });
});

describe('what the team is told', () => {
  it('states present things as fact and missing things as instructions', () => {
    const briefing = capabilityBriefing([
      { name: 'python3', present: true, detail: 'Python 3.12.0' },
      {
        name: 'pytest',
        present: false,
        ifMissing: 'Write tests as a plain script that runs with `python3 <file>`.',
      },
    ]);
    expect(briefing).toContain('Python 3.12.0');
    expect(briefing).toContain('NOT AVAILABLE');
    // The actionable instruction must survive into the briefing verbatim — a
    // small model acts on "write a plain script", not on a table of booleans.
    expect(briefing).toContain('plain script');
    expect(briefing).toContain('Do not pretend');
  });

  it('says nothing when there is nothing to say', () => {
    expect(capabilityBriefing([])).toBe('');
  });

  it('omits the missing section entirely when everything is present', () => {
    const briefing = capabilityBriefing([{ name: 'node', present: true, detail: 'v22' }]);
    expect(briefing).toContain('node');
    expect(briefing).not.toContain('NOT AVAILABLE');
  });

  it('reports blocked capabilities for the human who reads the run afterwards', () => {
    const blocked = blockedCapabilities([
      { name: 'node', present: true },
      { name: 'godot', present: false, ifMissing: 'Godot is not installed.' },
      { name: 'git', present: false }, // no advice → not worth surfacing
    ]);
    expect(blocked).toEqual(['godot']);
  });
});
