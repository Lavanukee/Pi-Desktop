import { describe, expect, it } from 'vitest';
import { MESH_SPECIALIST_KINDS } from '../corp/corp-mesh.js';
import { SPECIALIST_ENV, specialistFromEnv, specialistToolset } from './specialist-env.js';

describe('specialistFromEnv', () => {
  it('reads a kind off the environment', () => {
    expect(specialistFromEnv({ [SPECIALIST_ENV]: 'image' })).toBe('image');
    expect(specialistFromEnv({ [SPECIALIST_ENV]: ' UI-Critic ' })).toBe('ui-critic');
  });

  it('is undefined for a normal child', () => {
    expect(specialistFromEnv({})).toBeUndefined();
    expect(specialistFromEnv({ [SPECIALIST_ENV]: '' })).toBeUndefined();
  });

  /* An unrecognised value must not pin anything — otherwise a typo would produce
   * an agent with an empty or arbitrary tool set. */
  it('rejects a kind we have no charter for', () => {
    expect(specialistFromEnv({ [SPECIALIST_ENV]: 'poet' })).toBeUndefined();
  });
});

describe('specialistToolset', () => {
  it('gives the image specialist its generation kit', () => {
    const tools = specialistToolset('image', ['generate_image', 'read', 'write', 'bash', 'ls']);
    expect(tools).toContain('generate_image');
    expect(tools).toContain('write');
  });

  /* The whole point of pinning: a specialist holds ITS tools, not the preset. An
   * image specialist carrying the coding kit goes and reads source instead of
   * making the picture it was commissioned for. */
  it('excludes tools outside the role', () => {
    const tools = specialistToolset('image', ['generate_image', 'web_search', 'mcp_call']);
    expect(tools).not.toContain('web_search');
  });

  it('drops names this build never registered', () => {
    // `edit_image` exists in a real build; here it deliberately does not.
    const tools = specialistToolset('image', ['generate_image']);
    expect(tools).toEqual(['generate_image']);
  });

  /* Empty is the caller's signal to leave the preset alone — an agent pinned to
   * zero tools can do nothing at all, which is worse than a generic one. */
  it('returns empty when none of the role tools exist', () => {
    expect(specialistToolset('image', ['totally_unrelated'])).toEqual([]);
  });

  it('produces a non-empty kit for every kind in a full build', () => {
    const everything = new Set<string>();
    for (const k of MESH_SPECIALIST_KINDS) {
      for (const t of specialistToolset(k, [])) everything.add(t);
    }
    // With nothing available every kit is empty — the real assertion is that each
    // kind resolves to a non-empty list when its tools ARE present.
    for (const k of MESH_SPECIALIST_KINDS) {
      const all = specialistToolset(k, [
        'read',
        'write',
        'ls',
        'bash',
        'grep',
        'find',
        'generate_image',
        'generate_video',
        'web_search',
        'web_fetch',
        'mcp_list',
        'mcp_schema',
        'mcp_call',
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
      ]);
      expect(all.length, `${k} has no tools`).toBeGreaterThan(0);
    }
    expect(everything.size).toBe(0);
  });
});
