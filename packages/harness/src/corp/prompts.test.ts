import { describe, expect, it } from 'vitest';
import {
  CORE_ROLES,
  composeNodePrompt,
  DIVISION_ARCHETYPES,
  ENGINEERING_HANDBOOK,
  getArchetypePrompt,
  getPromptById,
  getRolePrompt,
  isCoreRole,
  isDivisionArchetype,
  isSpecialistKind,
  PROMPT_LIBRARY,
  type PromptLibraryId,
  SPECIALIST_KINDS,
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

  it('returns the base prompt unchanged when there is no extension', () => {
    expect(composeNodePrompt(base)).toBe(base.prompt);
  });

  it('treats a blank/whitespace extension as no extension', () => {
    expect(composeNodePrompt(base, '')).toBe(base.prompt);
    expect(composeNodePrompt(base, '   \n  ')).toBe(base.prompt);
  });

  it('appends a real extension without dropping the base (and keeps the base first)', () => {
    const out = composeNodePrompt(base, 'Prefer Godot connectors.');
    expect(out.startsWith(base.prompt)).toBe(true);
    expect(out).toContain('Prefer Godot connectors.');
    expect(out).toContain('the contract still governs'); // the guard framing is preserved
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
