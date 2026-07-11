import { describe, expect, it } from 'vitest';
import {
  activeModels,
  defaultImageModel,
  getModel,
  MODALITY_CATALOG,
  type ModalityModel,
  modelsForModality,
  requiresLicenseGate,
} from './catalog.ts';

describe('MODALITY_CATALOG shape', () => {
  it('every entry has the required typed fields', () => {
    for (const m of MODALITY_CATALOG) {
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
      expect(['image', 'audio', 'video', '3d']).toContain(m.modality);
      expect(typeof m.label).toBe('string');
      expect(typeof m.commercialUse).toBe('boolean');
      expect(typeof m.runsLocally).toBe('boolean');
      expect(typeof m.heavy).toBe('boolean');
      expect(m.approxSizeGB).toBeGreaterThanOrEqual(0);
    }
  });

  it('has unique ids', () => {
    const ids = MODALITY_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers all four modalities (pluggable catalog)', () => {
    const modalities = new Set(MODALITY_CATALOG.map((m) => m.modality));
    expect(modalities).toEqual(new Set(['image', 'audio', 'video', '3d']));
  });
});

describe('image models are phase-1 wired', () => {
  const images = modelsForModality('image');

  it('every image model carries a DEDICATED mflux command (not reserved)', () => {
    expect(images.length).toBeGreaterThanOrEqual(3);
    for (const m of images) {
      expect(m.reserved).not.toBe(true);
      expect(m.backend).toBe('mflux');
      expect(m.mflux?.kind).toBe('mflux');
      expect(m.mflux?.command).toMatch(/^mflux-generate/);
      expect(m.runsLocally).toBe(true);
    }
  });

  it('default image model is FLUX.2 klein and permits commercial use', () => {
    const def = defaultImageModel();
    expect(def.id).toBe('flux2-klein-4b');
    expect(def.commercialUse).toBe(true);
    expect(def.license).toBe('apache-2.0');
  });

  it('includes the verified fast/smoke model z-image-turbo with its own command', () => {
    const z = getModel('z-image-turbo');
    expect(z?.mflux?.command).toBe('mflux-generate-z-image-turbo');
    // The dedicated command is required — no `--model` multiplex needed.
    expect(z?.mflux?.model).toBeUndefined();
  });

  it('marks the ~24GB quality model heavy (one-at-a-time)', () => {
    expect(getModel('qwen-image-2512')?.heavy).toBe(true);
  });
});

describe('license gating', () => {
  it('gates non-commercial weights and passes Apache/MIT through', () => {
    const gated = MODALITY_CATALOG.filter(requiresLicenseGate).map((m) => m.id);
    // Voxtral (CC BY-NC) + LTX-2 (community) are the NC entries reserved for gating.
    expect(gated).toContain('voxtral-4b-tts');
    expect(gated).toContain('ltx-2');
    // No Apache/MIT image model should be gated.
    for (const m of modelsForModality('image')) {
      expect(requiresLicenseGate(m)).toBe(false);
    }
  });

  it('commercialUse=false iff a license gate is required', () => {
    for (const m of MODALITY_CATALOG) {
      expect(requiresLicenseGate(m)).toBe(!m.commercialUse);
    }
  });
});

describe('reserved future modalities', () => {
  it('audio/video/3d entries are present but reserved', () => {
    const reserved: ModalityModel[] = MODALITY_CATALOG.filter((m) => m.reserved === true);
    const modalities = new Set(reserved.map((m) => m.modality));
    expect(modalities).toContain('audio');
    expect(modalities).toContain('video');
    expect(modalities).toContain('3d');
  });

  it('activeModels excludes reserved + remote-only entries', () => {
    const active = activeModels();
    expect(active.every((m) => m.reserved !== true && m.runsLocally)).toBe(true);
    expect(active.map((m) => m.id)).not.toContain('ltx-2'); // remote-only
    expect(active.map((m) => m.id)).toContain('z-image-turbo');
  });
});
