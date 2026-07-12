import { describe, expect, it } from 'vitest';
import { BUILTIN_CONNECTOR_IDS, BUILTIN_CONNECTORS } from './builtin-connectors';
import { BRANDED_CONNECTOR_IDS } from './connector-icons';
import { isBuiltinConnector, KNOWN_CONNECTORS, KNOWN_CONNECTORS_BY_ID } from './detect-apps';

describe('built-in connectors', () => {
  it('ships HyperFrames and Video editing', () => {
    expect(BUILTIN_CONNECTOR_IDS).toEqual(['hyperframes', 'video-editing']);
  });

  it('marks each builtin as kind:builtin with a sentinel empty command', () => {
    for (const c of BUILTIN_CONNECTORS) {
      expect(c.kind).toBe('builtin');
      // A sentinel empty command — a builtin never spawns a server.
      expect(c.template.command).toBe('');
    }
  });

  it('scopes "By us" (firstParty) to our OWN tool, not the bundled third-party one', () => {
    // Owner correction: HyperFrames is HeyGen's tool — bundled/preinstalled and
    // "Official", but NEVER "By us". Video editing is genuinely ours.
    const hf = KNOWN_CONNECTORS_BY_ID.hyperframes;
    const ve = KNOWN_CONNECTORS_BY_ID['video-editing'];
    expect(hf?.firstParty).toBe(false);
    expect(hf?.official).toBe(true);
    expect(hf?.homepage).toContain('heygen');
    expect(ve?.firstParty).toBe(true);
    expect(ve?.official).toBe(true);
  });

  it('carries a static tool list for the detail view', () => {
    const hf = KNOWN_CONNECTORS_BY_ID.hyperframes;
    expect(hf?.tools?.map((t) => t.name)).toEqual(['motion_graphics_render']);
    const ve = KNOWN_CONNECTORS_BY_ID['video-editing'];
    expect(ve?.tools?.map((t) => t.name)).toEqual(['video_edit', 'extract_frames', 'probe']);
    // Every tool has a one-line description.
    for (const c of BUILTIN_CONNECTORS) {
      for (const t of c.tools ?? []) expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('is merged to the FRONT of the exported catalog', () => {
    expect(KNOWN_CONNECTORS[0]?.id).toBe('hyperframes');
    expect(KNOWN_CONNECTORS[1]?.id).toBe('video-editing');
  });

  it('renders a neutral (non-brand, currentColor) inline SVG mark', () => {
    for (const id of BUILTIN_CONNECTOR_IDS) {
      expect(BRANDED_CONNECTOR_IDS).not.toContain(id);
      const svg = KNOWN_CONNECTORS_BY_ID[id]?.iconSvg ?? '';
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('stroke="currentColor"');
    }
  });

  it('isBuiltinConnector is true only for the builtins', () => {
    expect(isBuiltinConnector('hyperframes')).toBe(true);
    expect(isBuiltinConnector('video-editing')).toBe(true);
    expect(isBuiltinConnector('github')).toBe(false);
    expect(isBuiltinConnector('memory')).toBe(false);
    expect(isBuiltinConnector('does-not-exist')).toBe(false);
  });
});
