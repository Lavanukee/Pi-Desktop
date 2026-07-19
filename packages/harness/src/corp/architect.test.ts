import { describe, expect, it } from 'vitest';
import {
  ARCHITECT_PROMPT,
  buildArchitectPrompt,
  COARSE_MAX_CONTRACTS_PER_DIVISION,
  COARSE_MAX_DIVISIONS,
  capArchitecture,
  capDivisions,
  DEFAULT_DECOMPOSITION_GRANULARITY,
  decompositionGuidanceLines,
  maxContractsPerDivisionFor,
  maxDivisionsFor,
  parseArchitecture,
} from './architect.js';
import type { Architecture } from './org-chart.js';
import type { HierarchyDivisionSpec } from './promotion.js';

describe('ARCHITECT_PROMPT', () => {
  it('names the two deliverables (module map + interfaces) and the no-overlap rule', () => {
    expect(ARCHITECT_PROMPT.length).toBeGreaterThan(0);
    expect(ARCHITECT_PROMPT.toLowerCase()).toContain('module map');
    expect(ARCHITECT_PROMPT.toLowerCase()).toContain('interface');
    expect(ARCHITECT_PROMPT.toLowerCase()).toContain('one clear area per division');
    expect(ARCHITECT_PROMPT.toLowerCase()).toContain('no overlaps');
  });

  it('makes each region a DIRECTORY namespace, not a single file', () => {
    // The granularity fix: a single-file region traps a division into piling
    // every contract onto one slot. Regions are directories a division fills.
    expect(ARCHITECT_PROMPT).toContain('DIRECTORY');
    expect(ARCHITECT_PROMPT.toLowerCase()).toContain('not a single file');
  });

  it('reserves the runnable ENTRY as a dedicated final integration step (spec §5/§8)', () => {
    // The architect must account for how it all RUNS: a single runnable entry that
    // wires the divisions into a working product, owned by an integration step — not
    // folded into a feature division.
    expect(ARCHITECT_PROMPT).toContain('runnable ENTRY');
    expect(ARCHITECT_PROMPT.toLowerCase()).toContain('index.html');
    expect(ARCHITECT_PROMPT).toContain('FINAL INTEGRATION');
  });
});

describe('buildArchitectPrompt', () => {
  const divisions = [
    { name: 'Gameplay', purpose: 'movement + rules' },
    { name: 'UI', purpose: 'the HUD and menus' },
  ];
  const prompt = buildArchitectPrompt('  Build a browser game.  ', divisions);

  it('carries the trimmed vision and every division name + purpose', () => {
    expect(prompt).toContain('Build a browser game.');
    expect(prompt).not.toContain('  Build a browser game.  '); // trimmed
    expect(prompt).toContain('Gameplay');
    expect(prompt).toContain('movement + rules');
    expect(prompt).toContain('UI');
    expect(prompt).toContain('the HUD and menus');
  });

  it('asks for the exact Architecture JSON shape and a terminator', () => {
    expect(prompt).toContain('"moduleMap"');
    expect(prompt).toContain('"interfaces"');
    for (const field of ['"path"', '"owner"', '"purpose"']) expect(prompt).toContain(field);
    for (const field of ['"name"', '"exposedBy"', '"summary"', '"consumedBy"']) {
      expect(prompt).toContain(field);
    }
    expect(prompt.toLowerCase()).toContain('json object');
    expect(prompt).toContain('then STOP');
  });

  it('does NOT splice the delivery constraint for a plain (non-openable) vision', () => {
    // "Build a browser game." is web but not openable-no-build → no delivery constraint.
    expect(prompt).not.toContain('DELIVERY CONSTRAINT');
  });
});

describe('buildArchitectPrompt — delivery constraint (spec §5/§8, Part B)', () => {
  const divisions = [
    { name: 'Engine', purpose: 'game loop + state' },
    { name: 'UI', purpose: 'the HUD and menus' },
  ];

  it('threads the openable/no-build constraint from a single-file vision', () => {
    const prompt = buildArchitectPrompt(
      'A playable Snake game — ONE index.html that opens directly in a browser without Node.js/npm/build.',
      divisions,
    );
    expect(prompt).toContain('DELIVERY CONSTRAINT');
    expect(prompt).toContain('opens DIRECTLY');
    expect(prompt.toLowerCase()).toContain('no build');
    expect(prompt).toContain('SELF-CONTAINED');
    // It steers AWAY from a bundler-dependent module graph.
    expect(prompt.toLowerCase()).toContain('bundler-dependent module graph');
  });

  it('is derived from the vision text — a neutral vision splices nothing', () => {
    const prompt = buildArchitectPrompt('Build a CLI tool that sorts numbers.', divisions);
    expect(prompt).not.toContain('DELIVERY CONSTRAINT');
  });
});

describe('decomposition granularity (I1 — coarse xhigh vs fine max)', () => {
  const divisions = [
    { name: 'Engine', purpose: 'game loop' },
    { name: 'UI', purpose: 'the HUD' },
  ];

  it('DEFAULTS to COARSE (xhigh): the default lever is fewer, larger contracts', () => {
    expect(DEFAULT_DECOMPOSITION_GRANULARITY).toBe('xhigh');
  });

  it('decompositionGuidanceLines(xhigh) steers to CONSOLIDATE into a handful of big modules', () => {
    const [line] = decompositionGuidanceLines('xhigh');
    expect(line).toContain('COARSE');
    expect(line?.toLowerCase()).toContain('consolidate');
    expect(line?.toLowerCase()).toContain('handful');
    expect(line?.toLowerCase()).toContain('over-decompose');
  });

  it('decompositionGuidanceLines(max) restores the FINE full decomposition', () => {
    const [line] = decompositionGuidanceLines('max');
    expect(line).toContain('FINE');
    expect(line?.toLowerCase()).toContain('decompose the work fully');
  });

  it('buildArchitectPrompt defaults to the COARSE steer (== explicit xhigh)', () => {
    const prompt = buildArchitectPrompt('Build a browser game.', divisions);
    expect(prompt).toContain('DECOMPOSITION — COARSE (xhigh)');
    expect(prompt.toLowerCase()).toContain('consolidate');
    expect(prompt).not.toContain('DECOMPOSITION — FINE');
    // The unspecified default matches an explicit xhigh (coarser than the old behaviour).
    expect(prompt).toBe(buildArchitectPrompt('Build a browser game.', divisions, 'xhigh'));
  });

  it('buildArchitectPrompt(..., "max") splices the FINE steer instead', () => {
    const prompt = buildArchitectPrompt('Build a browser game.', divisions, 'max');
    expect(prompt).toContain('DECOMPOSITION — FINE (max)');
    expect(prompt).not.toContain('DECOMPOSITION — COARSE');
  });
});

describe('parseArchitecture', () => {
  it('extracts a fenced, prose-wrapped architecture object', () => {
    const reply = `Here is the architecture:

\`\`\`json
{
  "moduleMap": [
    { "path": "src/game/state.ts", "owner": "Gameplay", "purpose": "the shared game state" },
    { "path": "src/ui/hud.tsx", "owner": "UI", "purpose": "the HUD" }
  ],
  "interfaces": [
    {
      "name": "GameState",
      "exposedBy": "Gameplay",
      "path": "src/game/state.ts",
      "summary": "the typed game-state store",
      "consumedBy": ["UI"]
    }
  ]
}
\`\`\`

Let me know if you want more.`;
    const arch = parseArchitecture(reply);
    expect(arch.moduleMap).toHaveLength(2);
    expect(arch.moduleMap[0]?.owner).toBe('Gameplay');
    expect(arch.interfaces).toHaveLength(1);
    expect(arch.interfaces[0]?.name).toBe('GameState');
    expect(arch.interfaces[0]?.consumedBy).toEqual(['UI']);
  });

  it('parses a bare object with no fence', () => {
    const bare = JSON.stringify({
      moduleMap: [{ path: 'p', owner: 'A', purpose: 'x' }],
      interfaces: [],
    });
    const arch = parseArchitecture(bare);
    expect(arch.moduleMap).toHaveLength(1);
    expect(arch.interfaces).toHaveLength(0);
  });

  it('tolerates common field-name variants and defaults a missing consumedBy to []', () => {
    const reply = `{
      "modules": [ { "slot": "src/a.ts", "division": "A", "description": "region a" } ],
      "interfaces": [ { "id": "IfaceA", "producedBy": "A", "slot": "src/a.ts", "description": "the seam" } ]
    }`;
    const arch = parseArchitecture(reply);
    expect(arch.moduleMap).toHaveLength(1);
    expect(arch.moduleMap[0]).toEqual({ path: 'src/a.ts', owner: 'A', purpose: 'region a' });
    expect(arch.interfaces).toHaveLength(1);
    expect(arch.interfaces[0]).toEqual({
      name: 'IfaceA',
      exposedBy: 'A',
      path: 'src/a.ts',
      summary: 'the seam',
      consumedBy: [],
    });
  });

  it('drops elements that are not valid entries, keeping the good ones', () => {
    const reply = `{
      "moduleMap": [ { "nope": true }, { "path": "src/ok.ts", "owner": "A", "purpose": "ok" } ],
      "interfaces": [ { "missing": "fields" } ]
    }`;
    const arch = parseArchitecture(reply);
    expect(arch.moduleMap).toHaveLength(1);
    expect(arch.moduleMap[0]?.path).toBe('src/ok.ts');
    expect(arch.interfaces).toHaveLength(0);
  });

  it('repairs an unterminated string closed by a raw newline (salvage rung)', () => {
    // The `purpose` of the sole module is left unterminated — the model dropped the
    // closing quote, so a raw newline lands inside the string (illegal JSON).
    const reply = `{
  "moduleMap": [
    { "path": "src/a.ts", "owner": "A", "purpose": "region a
    } ],
  "interfaces": []
}`;
    const arch = parseArchitecture(reply);
    expect(arch.moduleMap).toHaveLength(1);
    expect(arch.moduleMap[0]?.path).toBe('src/a.ts');
    expect(arch.moduleMap[0]?.purpose).toBe('region a');
  });

  it('returns an empty architecture (never throws) when there is no usable object', () => {
    expect(parseArchitecture('I could not produce an architecture.')).toEqual({
      moduleMap: [],
      interfaces: [],
    });
    expect(parseArchitecture('')).toEqual({ moduleMap: [], interfaces: [] });
    expect(parseArchitecture('{ not json }')).toEqual({ moduleMap: [], interfaces: [] });
  });
});

describe('COARSE (xhigh) enforcement caps (J7)', () => {
  const div = (name: string): HierarchyDivisionSpec => ({ name, purpose: `${name} purpose` });

  it('exposes the granularity-keyed cap values (xhigh capped, max uncapped)', () => {
    expect(maxDivisionsFor('xhigh')).toBe(COARSE_MAX_DIVISIONS);
    expect(maxContractsPerDivisionFor('xhigh')).toBe(COARSE_MAX_CONTRACTS_PER_DIVISION);
    expect(maxDivisionsFor('max')).toBe(Number.POSITIVE_INFINITY);
    expect(maxContractsPerDivisionFor('max')).toBe(Number.POSITIVE_INFINITY);
    // The two caps multiply to a handful — the whole point of coarse mode.
    expect(COARSE_MAX_DIVISIONS * COARSE_MAX_CONTRACTS_PER_DIVISION).toBeLessThanOrEqual(8);
  });

  describe('capDivisions', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(div);

    it('xhigh trims divisions past the cap, keeping the first, and reports the trimmed', () => {
      const { divisions, trimmed } = capDivisions(six, 'xhigh');
      expect(divisions).toHaveLength(COARSE_MAX_DIVISIONS);
      expect(divisions.map((d) => d.name)).toEqual(['a', 'b', 'c', 'd']);
      expect(trimmed.map((d) => d.name)).toEqual(['e', 'f']);
    });

    it('max leaves every division in place (uncapped)', () => {
      const { divisions, trimmed } = capDivisions(six, 'max');
      expect(divisions).toHaveLength(6);
      expect(trimmed).toEqual([]);
    });

    it('is a no-op when already at/under the cap', () => {
      const { divisions, trimmed } = capDivisions(six.slice(0, 3), 'xhigh');
      expect(divisions).toHaveLength(3);
      expect(trimmed).toEqual([]);
    });
  });

  describe('capArchitecture', () => {
    const arch = (): Architecture => ({
      moduleMap: [
        { path: 'src/a1/', owner: 'A', purpose: 'a one' },
        { path: 'src/a2/', owner: 'A', purpose: 'a two — extra region for the same owner' },
        { path: 'src/b/', owner: 'B', purpose: 'b' },
        { path: 'src/c/', owner: 'C', purpose: 'c' },
        { path: 'src/d/', owner: 'D', purpose: 'd' },
        { path: 'src/e/', owner: 'E', purpose: 'e — past the division cap' },
      ],
      interfaces: [
        { name: 'I', exposedBy: 'A', path: 'src/a1/i.ts', summary: 's', consumedBy: ['B'] },
      ],
    });

    it('xhigh keeps one region per owner and ≤ the division cap, trimming the rest', () => {
      const { architecture, trimmedPaths } = capArchitecture(arch(), 'xhigh');
      // A's second region is merged away; E is past the 4-division cap.
      expect(architecture.moduleMap.map((m) => m.path)).toEqual([
        'src/a1/',
        'src/b/',
        'src/c/',
        'src/d/',
      ]);
      expect(trimmedPaths).toEqual(['src/a2/', 'src/e/']);
      expect(architecture.interfaces).toHaveLength(1); // interfaces untouched
    });

    it('max returns the architecture unchanged with no trims', () => {
      const original = arch();
      const { architecture, trimmedPaths } = capArchitecture(original, 'max');
      expect(architecture).toBe(original);
      expect(trimmedPaths).toEqual([]);
    });
  });
});
