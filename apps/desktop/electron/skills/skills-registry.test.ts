import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_SKILLS,
  BUNDLED_SKILLS_BY_ID,
  getBundledSkill,
  isSafeSkillId,
} from './skills-registry';

// resources/skills lives at apps/desktop/resources/skills; this test file is at
// apps/desktop/electron/skills, so the source dir is ../../resources/skills.
const RESOURCES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../resources/skills',
);

describe('bundled skills registry', () => {
  it('has a healthy, well-formed catalog', () => {
    expect(BUNDLED_SKILLS.length).toBeGreaterThanOrEqual(10);
    const ids = BUNDLED_SKILLS.map((s) => s.id);
    expect(new Set(ids).size, 'ids are unique').toBe(ids.length);
    for (const skill of BUNDLED_SKILLS) {
      expect(isSafeSkillId(skill.id), `${skill.id} is a safe path segment`).toBe(true);
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(10);
    }
  });

  it('every registry id maps to a bundled folder with a SKILL.md', () => {
    for (const skill of BUNDLED_SKILLS) {
      const md = path.join(RESOURCES, skill.id, 'SKILL.md');
      expect(existsSync(md), `${skill.id}/SKILL.md is bundled`).toBe(true);
      expect(statSync(md).isFile()).toBe(true);
    }
  });

  it('every bundled Apache-2.0 skill keeps its upstream LICENSE.txt', () => {
    for (const skill of BUNDLED_SKILLS) {
      if (skill.license !== 'Apache-2.0') continue;
      const lic = path.join(RESOURCES, skill.id, 'LICENSE.txt');
      expect(existsSync(lic), `${skill.id}/LICENSE.txt (Apache attribution)`).toBe(true);
    }
  });

  it('carries an ATTRIBUTION file for the bundle', () => {
    expect(existsSync(path.join(RESOURCES, 'ATTRIBUTION.md'))).toBe(true);
  });

  it('BY_ID + getBundledSkill resolve, and reject unknowns', () => {
    for (const skill of BUNDLED_SKILLS) {
      expect(BUNDLED_SKILLS_BY_ID[skill.id]).toBe(skill);
      expect(getBundledSkill(skill.id)).toBe(skill);
    }
    expect(getBundledSkill('does-not-exist')).toBeUndefined();
  });

  it('isSafeSkillId rejects traversal and unsafe names', () => {
    expect(isSafeSkillId('code-review')).toBe(true);
    expect(isSafeSkillId('..')).toBe(false);
    expect(isSafeSkillId('../evil')).toBe(false);
    expect(isSafeSkillId('a/b')).toBe(false);
    expect(isSafeSkillId('.hidden')).toBe(false);
    expect(isSafeSkillId('Upper')).toBe(false);
    expect(isSafeSkillId('')).toBe(false);
  });
});
