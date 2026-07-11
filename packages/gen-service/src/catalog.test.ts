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
  const mfluxImages = images.filter((m) => m.backend === 'mflux');

  it('every mflux image model carries a DEDICATED command + is active (not reserved)', () => {
    expect(mfluxImages.length).toBeGreaterThanOrEqual(3);
    for (const m of mfluxImages) {
      expect(m.reserved).not.toBe(true);
      expect(m.mflux?.kind).toBe('mflux');
      expect(m.mflux?.command).toMatch(/^mflux-generate/);
      expect(m.runsLocally).toBe(true);
    }
  });

  it('exposes the advanced ComfyUI FLUX-GGUF image entry (reserved, no mflux command)', () => {
    const adv = getModel('flux1-dev-gguf');
    expect(adv?.modality).toBe('image');
    expect(adv?.backend).toBe('comfyui');
    expect(adv?.mflux).toBeUndefined();
    expect(adv?.comfy?.kind).toBe('comfyui');
    expect(adv?.reserved).toBe(true);
    // Advanced graph is still Apache / commercial-OK per the plan.
    expect(adv?.commercialUse).toBe(true);
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
    expect(active.map((m) => m.id)).not.toContain('ltx-2'); // reserved (ComfyUI backend pending)
    expect(active.map((m) => m.id)).toContain('z-image-turbo');
  });
});

describe('ComfyUI-backed entries', () => {
  const comfyEntries = MODALITY_CATALOG.filter((m) => m.backend === 'comfyui');

  it('every comfyui entry carries a comfy config with a non-empty paramMap', () => {
    expect(comfyEntries.length).toBeGreaterThanOrEqual(5);
    for (const m of comfyEntries) {
      expect(m.comfy?.kind).toBe('comfyui');
      expect(typeof m.comfy?.workflowTemplate).toBe('string');
      expect(m.comfy?.workflowTemplate.length).toBeGreaterThan(0);
      expect(Object.keys(m.comfy?.paramMap ?? {}).length).toBeGreaterThan(0);
      // prompt is the one param every generative graph binds.
      expect(m.comfy?.paramMap.prompt).toBeDefined();
    }
  });

  it('comfy entries never carry an mflux config (distinct backend seam)', () => {
    for (const m of comfyEntries) expect(m.mflux).toBeUndefined();
  });
});

describe('minUnifiedMemoryGB hint', () => {
  it('is present, positive, and never below the on-disk size for every entry', () => {
    for (const m of MODALITY_CATALOG) {
      expect(typeof m.minUnifiedMemoryGB).toBe('number');
      const min = m.minUnifiedMemoryGB ?? 0;
      expect(min).toBeGreaterThan(0);
      // The memory floor is weights + headroom, so it must cover the weights.
      expect(min).toBeGreaterThanOrEqual(m.approxSizeGB);
    }
  });
});

describe('TTS is un-reserved (mlx-audio fast-path, active)', () => {
  it('qwen3-tts / kokoro / voxtral are active mlx-audio entries', () => {
    for (const id of ['qwen3-tts-1.7b', 'kokoro-82m', 'voxtral-4b-tts']) {
      const m = getModel(id);
      expect(m?.backend).toBe('mlx-audio');
      expect(m?.reserved).not.toBe(true);
      expect(m?.runsLocally).toBe(true);
    }
    const active = activeModels().map((m) => m.id);
    expect(active).toContain('qwen3-tts-1.7b');
    expect(active).toContain('kokoro-82m');
  });

  it('default TTS is Apache; Voxtral is NC-gated', () => {
    expect(getModel('qwen3-tts-1.7b')?.commercialUse).toBe(true);
    expect(requiresLicenseGate(getModel('voxtral-4b-tts') as ModalityModel)).toBe(true);
  });
});

describe('Music / SFX rows (ComfyUI)', () => {
  it('ACE-Step is Apache, commercial-OK, heavy, comfyui', () => {
    const ace = getModel('ace-step');
    expect(ace?.modality).toBe('audio');
    expect(ace?.backend).toBe('comfyui');
    expect(ace?.license).toBe('apache-2.0');
    expect(ace?.commercialUse).toBe(true);
    expect(ace?.heavy).toBe(true);
  });

  it('Stable Audio Open is stability-community + NC-gated', () => {
    const sa = getModel('stable-audio-open');
    expect(sa?.backend).toBe('comfyui');
    expect(sa?.license).toBe('stability-community');
    expect(sa?.commercialUse).toBe(false);
    expect(requiresLicenseGate(sa as ModalityModel)).toBe(true);
  });
});

describe('LTX video flip (hyperframes → comfyui, local with tier gating)', () => {
  it('the default ltx-2 entry is now local ComfyUI (was remote-only hyperframes)', () => {
    const ltx = getModel('ltx-2');
    expect(ltx?.backend).toBe('comfyui');
    expect(ltx?.runsLocally).toBe(true);
    expect(ltx?.comfy?.kind).toBe('comfyui');
    expect(ltx?.minUnifiedMemoryGB).toBeGreaterThanOrEqual(24);
  });

  it('adds the 16GB-safe distilled fast pick and the 64GB/remote 22B quality pick', () => {
    const fast = getModel('ltx-video-2b-distilled');
    expect(fast?.backend).toBe('comfyui');
    expect(fast?.runsLocally).toBe(true);
    expect(fast?.minUnifiedMemoryGB).toBeLessThanOrEqual(16);

    const quality = getModel('ltx-2-22b');
    expect(quality?.runsLocally).toBe(false); // routes remote below 64GB
    expect(quality?.minUnifiedMemoryGB).toBeGreaterThanOrEqual(64);
  });

  it('all LTX entries stay LTX-2-Community gated', () => {
    for (const id of ['ltx-2', 'ltx-video-2b-distilled', 'ltx-2-22b']) {
      const m = getModel(id);
      expect(m?.license).toBe('ltx-2-community');
      expect(requiresLicenseGate(m as ModalityModel)).toBe(true);
    }
  });
});

describe('3D backends are direct workers, NOT ComfyUI on Mac', () => {
  it('TRELLIS.2 stays on its own MLX `trellis` worker with ~15GB weights', () => {
    const t = getModel('trellis-2-4b');
    expect(t?.backend).toBe('trellis');
    expect(t?.backend).not.toBe('comfyui');
    expect(t?.approxSizeGB).toBeGreaterThanOrEqual(15);
    expect(t?.notes).toMatch(/NOT ComfyUI/i);
  });

  it('TripoSR remains the fast/16GB fallback on its own worker', () => {
    const tri = getModel('triposr');
    expect(tri?.backend).toBe('triposr');
    expect(tri?.modality).toBe('3d');
    expect(tri?.minUnifiedMemoryGB ?? 0).toBeLessThanOrEqual(16);
  });
});
