import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_TIERS,
  CORE_ROLES,
  composeNodePrompt,
  DIVISION_ARCHETYPES,
  ENGINEERING_HANDBOOK,
  getArchetypePrompt,
  getPromptById,
  getRolePrompt,
  HARNESS_PREAMBLE,
  isCapabilityTier,
  isCoreRole,
  isDivisionArchetype,
  isSpecialistKind,
  PROMPT_LIBRARY,
  type PromptLibraryId,
  ROLE_THINKING,
  ROLE_TIER,
  roleThinkingEnabled,
  SPECIALIST_KINDS,
  tierForRole,
} from './prompts.js';

describe('id type guards', () => {
  it('isCoreRole / isSpecialistKind / isDivisionArchetype accept their members only', () => {
    for (const r of CORE_ROLES) expect(isCoreRole(r)).toBe(true);
    for (const s of SPECIALIST_KINDS) expect(isSpecialistKind(s)).toBe(true);
    for (const a of DIVISION_ARCHETYPES) expect(isDivisionArchetype(a)).toBe(true);
    // Cross-family + junk rejected.
    expect(isCoreRole('security')).toBe(false);
    expect(isSpecialistKind('engineer')).toBe(false);
    expect(isDivisionArchetype('ceo')).toBe(false);
    for (const v of ['', 'nope', 5, null, undefined]) {
      expect(isCoreRole(v)).toBe(false);
      expect(isSpecialistKind(v)).toBe(false);
      expect(isDivisionArchetype(v)).toBe(false);
    }
  });
});

describe('PROMPT_LIBRARY', () => {
  it('keys every entry by its own id and gives each a non-empty prompt + title', () => {
    for (const [id, entry] of Object.entries(PROMPT_LIBRARY)) {
      expect(entry.id).toBe(id);
      expect(entry.prompt.length).toBeGreaterThan(0);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(['role', 'specialist', 'archetype']).toContain(entry.kind);
    }
  });
});

describe('getRolePrompt', () => {
  it('returns the "role" entry for every core role', () => {
    for (const role of CORE_ROLES) {
      const p = getRolePrompt(role);
      expect(p.id).toBe(role);
      expect(p.kind).toBe('role');
    }
  });

  it('returns the "specialist" entry for every specialist kind', () => {
    for (const kind of SPECIALIST_KINDS) {
      const p = getRolePrompt(kind);
      expect(p.id).toBe(kind);
      expect(p.kind).toBe('specialist');
    }
  });
});

describe('getArchetypePrompt', () => {
  it('returns the "archetype" entry for every division archetype', () => {
    for (const a of DIVISION_ARCHETYPES) {
      const p = getArchetypePrompt(a);
      expect(p.id).toBe(a);
      expect(p.kind).toBe('archetype');
    }
  });
});

describe('getPromptById', () => {
  it('resolves any known library id (e.g. a persisted OrgNode.promptId)', () => {
    for (const id of Object.keys(PROMPT_LIBRARY) as PromptLibraryId[]) {
      expect(getPromptById(id)?.id).toBe(id);
    }
  });

  it('returns undefined for an unknown id', () => {
    expect(getPromptById('not-a-role')).toBeUndefined();
    expect(getPromptById('')).toBeUndefined();
  });
});

describe('composeNodePrompt', () => {
  const base = getRolePrompt('engineer');

  it('prepends the shared harness preamble, then the base, when there is no extension', () => {
    const out = composeNodePrompt(base);
    expect(out.startsWith(HARNESS_PREAMBLE)).toBe(true);
    expect(out).toContain(base.prompt);
  });

  it('treats a blank/whitespace extension as no extension (still preamble + base)', () => {
    const expected = composeNodePrompt(base);
    expect(composeNodePrompt(base, '')).toBe(expected);
    expect(composeNodePrompt(base, '   \n  ')).toBe(expected);
  });

  it('appends a real extension without dropping the base (preamble first, then base)', () => {
    const out = composeNodePrompt(base, 'Prefer Godot connectors.');
    expect(out.startsWith(HARNESS_PREAMBLE)).toBe(true);
    expect(out).toContain(base.prompt);
    expect(out).toContain('Prefer Godot connectors.');
    expect(out).toContain('the contract still governs'); // the guard framing is preserved
  });
});

describe('MANAGER_PROMPT (via the library)', () => {
  it('invites using the contract notes field for the un-captured remainder', () => {
    const manager = getRolePrompt('manager').prompt;
    expect(manager).toContain('notes');
    // The invitation names the kinds of thing notes is for.
    expect(manager).toContain('failed');
    expect(manager.toLowerCase()).toContain('constraint');
  });

  it('bounds contract granularity (6–12) and names the split-into-sub-divisions signal', () => {
    const manager = getRolePrompt('manager').prompt;
    expect(manager).toMatch(/6[–-]12/); // the bounded range, not "100"
    expect(manager).not.toContain('100');
    expect(manager.toLowerCase()).toContain('sub-division');
  });
});

describe('ROLE_THINKING (per-role thinking control knob)', () => {
  it('runs structured-output roles thinking-OFF and judgment roles thinking-ON', () => {
    // Manager + division-head emit contract JSON — thinking off (runaway <think>).
    expect(roleThinkingEnabled('manager')).toBe(false);
    expect(roleThinkingEnabled('division-head')).toBe(false);
    // CEO + engineer + specialists reason for judgment — thinking on.
    expect(roleThinkingEnabled('ceo')).toBe(true);
    expect(roleThinkingEnabled('engineer')).toBe(true);
    for (const kind of SPECIALIST_KINDS) expect(roleThinkingEnabled(kind)).toBe(true);
  });

  it('has an explicit boolean entry for every core role and specialist', () => {
    for (const role of CORE_ROLES) expect(typeof ROLE_THINKING[role]).toBe('boolean');
    for (const kind of SPECIALIST_KINDS) expect(typeof ROLE_THINKING[kind]).toBe('boolean');
  });
});

describe('ROLE_TIER (role → capability tier, model-agnostic)', () => {
  it('maps reasoning/judgment roles to intelligent and code-execution roles to balanced', () => {
    // Reasoning/judgment: CEO, manager, architect, and every advisory specialist —
    // EXCEPT the tester, which is tool-heavy (build/run/screenshot) → balanced.
    expect(tierForRole('ceo')).toBe('intelligent');
    expect(tierForRole('manager')).toBe('intelligent');
    expect(tierForRole('architect')).toBe('intelligent');
    for (const kind of SPECIALIST_KINDS) {
      expect(tierForRole(kind)).toBe(kind === 'tester' ? 'balanced' : 'intelligent');
    }
    // Code execution: engineer + division-head (+ the tool-heavy tester).
    expect(tierForRole('engineer')).toBe('balanced');
    expect(tierForRole('division-head')).toBe('balanced');
    expect(tierForRole('tester')).toBe('balanced');
  });

  it('only ever names a tier, never a concrete model', () => {
    for (const tier of Object.values(ROLE_TIER)) expect(isCapabilityTier(tier)).toBe(true);
  });

  it('has a tier entry for every core role, specialist, and the architect', () => {
    for (const role of CORE_ROLES) expect(isCapabilityTier(ROLE_TIER[role])).toBe(true);
    for (const kind of SPECIALIST_KINDS) expect(isCapabilityTier(ROLE_TIER[kind])).toBe(true);
    expect(isCapabilityTier(ROLE_TIER.architect)).toBe(true);
  });

  it('CAPABILITY_TIERS is exactly the three tiers', () => {
    expect([...CAPABILITY_TIERS]).toEqual(['fast', 'balanced', 'intelligent']);
    for (const t of CAPABILITY_TIERS) expect(isCapabilityTier(t)).toBe(true);
    for (const v of ['huge', '', 3, null]) expect(isCapabilityTier(v)).toBe(false);
  });
});

describe('ROLE_THINKING — the architect', () => {
  it('runs the architect thinking-OFF like the manager (it emits structured JSON)', () => {
    expect(roleThinkingEnabled('architect')).toBe(false);
    expect(ROLE_THINKING.architect).toBe(false);
  });
});

describe('the two measuring specialists — tester + auditor (spec §4/§8)', () => {
  it('both are registered specialist kinds', () => {
    expect(isSpecialistKind('tester')).toBe(true);
    expect(isSpecialistKind('auditor')).toBe(true);
    expect(SPECIALIST_KINDS).toContain('tester');
    expect(SPECIALIST_KINDS).toContain('auditor');
  });

  it('resolve tier + thinking: tester=balanced (tool-heavy), auditor=intelligent, both thinking-ON', () => {
    expect(tierForRole('tester')).toBe('balanced');
    expect(tierForRole('auditor')).toBe('intelligent');
    expect(roleThinkingEnabled('tester')).toBe(true);
    expect(roleThinkingEnabled('auditor')).toBe(true);
  });

  it('resolve a PROMPT_LIBRARY entry framing what they MEASURE', () => {
    const tester = getRolePrompt('tester');
    expect(tester.kind).toBe('specialist');
    // The tester builds + runs + screenshots and blocks on a missing runnable entry.
    expect(tester.prompt).toContain('BUILD');
    expect(tester.prompt).toContain('RUN');
    expect(tester.prompt).toContain('SCREENSHOT');
    expect(tester.prompt.toLowerCase()).toContain('runnable entry');

    const auditor = getRolePrompt('auditor');
    expect(auditor.kind).toBe('specialist');
    // The auditor reads the WHOLE tree and traces a cross-module root cause.
    expect(auditor.prompt).toContain('ENTIRE product tree');
    expect(auditor.prompt).toContain('ROOT CAUSE');
    // Both resolve by untyped id too (persisted OrgNode.promptId path).
    expect(getPromptById('tester')?.id).toBe('tester');
    expect(getPromptById('auditor')?.id).toBe('auditor');
  });
});

describe('MANAGER_PROMPT — merge-time verify (spec §8)', () => {
  it('confirms workability from tester evidence and names the auditor escape hatch', () => {
    const manager = getRolePrompt('manager').prompt;
    expect(manager).toContain('At MERGE');
    expect(manager.toLowerCase()).toContain('tester');
    expect(manager).toContain('auditor');
  });
});

describe('ENGINEERING_HANDBOOK', () => {
  it('is present and carries the one governing rule', () => {
    expect(typeof ENGINEERING_HANDBOOK).toBe('string');
    expect(ENGINEERING_HANDBOOK.length).toBeGreaterThan(0);
    expect(ENGINEERING_HANDBOOK).toContain('legible to a worker who does not share your context');
    expect(ENGINEERING_HANDBOOK).toContain('Your contract is law');
  });
});
