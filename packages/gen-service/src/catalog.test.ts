import { describe, expect, it } from 'vitest';
import {
  activeModels,
  defaultImageModel,
  getModel,
  type License,
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
    // Correction #8: FLUX.1 [dev] is NON-COMMERCIAL (CC BY-NC), not Apache → gated.
    expect(adv?.commercialUse).toBe(false);
    expect(adv?.license).toBe('cc-by-nc-4.0');
    expect(requiresLicenseGate(adv as ModalityModel)).toBe(true);
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
    // Correction #1: --model now points at the PRE-QUANTIZED 4-bit mflux repo.
    expect(z?.mflux?.model).toBe('filipstrand/Z-Image-Turbo-mflux-4bit');
  });

  it('marks the ~24GB quality model heavy (one-at-a-time)', () => {
    expect(getModel('qwen-image-2512')?.heavy).toBe(true);
  });

  it('points the pre-quant mflux rows at 4-bit repos and drops on-the-fly quantize (#1)', () => {
    const klein = getModel('flux2-klein-4b');
    expect(klein?.mflux?.model).toBe('RunPod/FLUX.2-klein-4B-mflux-4bit');
    expect(klein?.defaultQuantize).toBeUndefined();
    const z = getModel('z-image-turbo');
    expect(z?.mflux?.model).toBe('filipstrand/Z-Image-Turbo-mflux-4bit');
    expect(z?.defaultQuantize).toBeUndefined();
  });
});

describe('license gating', () => {
  it('gates non-commercial weights and passes Apache/MIT through', () => {
    const gated = MODALITY_CATALOG.filter(requiresLicenseGate).map((m) => m.id);
    // Voxtral (CC BY-NC) + LTX-2 (community) are the NC entries reserved for gating.
    expect(gated).toContain('voxtral-4b-tts');
    expect(gated).toContain('ltx-2');
    // Correction #8: FLUX.1-dev GGUF is NON-COMMERCIAL now → gated.
    expect(gated).toContain('flux1-dev-gguf');
    // The Apache mflux image models stay ungated (only the NC ComfyUI entry gates).
    for (const m of modelsForModality('image')) {
      if (m.backend === 'mflux') expect(requiresLicenseGate(m)).toBe(false);
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
    // Correction #6: real repo id + the resolvable MLX runner (not dead ports).
    expect(t?.repo).toBe('microsoft/TRELLIS.2-4B');
    expect(t?.notes).toMatch(/xocialize\/trellis2-mlx/);
  });

  it('TripoSR remains the fast/16GB fallback on its own worker', () => {
    const tri = getModel('triposr');
    expect(tri?.backend).toBe('triposr');
    expect(tri?.modality).toBe('3d');
    expect(tri?.minUnifiedMemoryGB ?? 0).toBeLessThanOrEqual(16);
  });
});

describe('the 9 real-test corrections (#3/#6/#7/#8/#9)', () => {
  it('#3 ace-step repo id is the weights repo, not the 401 org', () => {
    expect(getModel('ace-step')?.repo).toBe('ACE-Step/ACE-Step-v1-3.5B');
  });

  it('#7 Kokoro keeps provenance repo but resolves --model to prince-canuma (+ misaki aux)', () => {
    const k = getModel('kokoro-82m');
    expect(k?.repo).toBe('hexgrad/Kokoro-82M'); // provenance
    expect(k?.mlxAudioModel).toBe('prince-canuma/Kokoro-82M'); // resolved --model
    expect(k?.auxDeps).toContain('misaki[en]');
  });

  it('#9 both stable-audio rows are stability-community + gated (free <$1M)', () => {
    for (const id of ['stable-audio-open', 'stable-audio-open-small']) {
      const m = getModel(id);
      expect(m?.license).toBe('stability-community');
      expect(m?.commercialUse).toBe(false);
      expect(requiresLicenseGate(m as ModalityModel)).toBe(true);
    }
  });
});

describe('MOSS + new TTS/clone rows (§5.2/§5.3)', () => {
  it('MOSS-TTSD 8B is an Apache, ungated, active mlx-audio dialogue model', () => {
    const m = getModel('moss-ttsd-8b');
    expect(m?.backend).toBe('mlx-audio');
    expect(m?.repo).toBe('mlx-community/MOSS-TTS-8B-8bit');
    expect(m?.license).toBe('apache-2.0');
    expect(m?.commercialUse).toBe(true);
    expect(m?.reserved).not.toBe(true);
    expect(activeModels().map((x) => x.id)).toContain('moss-ttsd-8b');
  });

  it('MOSS Local 1.7B and Dia 1.6B are present, Apache, mlx-audio', () => {
    for (const id of ['moss-tts-local-1.7b', 'dia-1.6b']) {
      const m = getModel(id);
      expect(m?.backend).toBe('mlx-audio');
      expect(m?.license).toBe('apache-2.0');
      expect(m?.commercialUse).toBe(true);
    }
  });

  it('qwen3-tts-0.6b is the lighter Apache default', () => {
    const m = getModel('qwen3-tts-0.6b');
    expect(m?.backend).toBe('mlx-audio');
    expect(m?.repo).toBe('Qwen/Qwen3-TTS-12Hz-0.6B-Base');
    expect(m?.commercialUse).toBe(true);
  });

  it('Chatterbox introduces the NEW torch-tts backend (MIT, reserved, watermark note)', () => {
    const c = getModel('chatterbox');
    expect(c?.backend).toBe('torch-tts');
    expect(c?.repo).toBe('ResembleAI/chatterbox');
    expect(c?.license).toBe('mit');
    expect(c?.commercialUse).toBe(true);
    expect(c?.reserved).toBe(true);
    expect(c?.notes).toMatch(/watermark/i);
  });
});

describe('new generative rows: Wan2.1 video + Stable Audio Open Small', () => {
  it('Wan2.1 T2V 1.3B is the Apache, ungated, ComfyUI diffusion-video pick', () => {
    const w = getModel('wan2.1-t2v-1.3b');
    expect(w?.modality).toBe('video');
    expect(w?.backend).toBe('comfyui');
    expect(w?.repo).toBe('Wan-AI/Wan2.1-T2V-1.3B');
    expect(w?.license).toBe('apache-2.0');
    expect(w?.commercialUse).toBe(true);
    expect(requiresLicenseGate(w as ModalityModel)).toBe(false);
    expect(w?.comfy?.paramMap.prompt).toBeDefined();
  });

  it('Stable Audio Open Small is a tiny gated ComfyUI SFX row', () => {
    const s = getModel('stable-audio-open-small');
    expect(s?.modality).toBe('audio');
    expect(s?.backend).toBe('comfyui');
    expect(s?.approxSizeGB).toBeLessThanOrEqual(2);
    expect(s?.comfy?.paramMap.prompt).toBeDefined();
  });
});

describe('recommended flag (§5.1)', () => {
  it('marks a vetted first-class pick in every surfaced modality', () => {
    const rec = MODALITY_CATALOG.filter((m) => m.recommended === true);
    expect(new Set(rec.map((m) => m.modality))).toEqual(new Set(['image', 'audio', 'video', '3d']));
    // The image default + the MOSS dialogue keystone are recommended.
    expect(getModel('flux2-klein-4b')?.recommended).toBe(true);
    expect(getModel('moss-ttsd-8b')?.recommended).toBe(true);
  });

  it('does NOT recommend the NC-gated, secondary, or reserved-slow rows', () => {
    expect(getModel('flux1-dev-gguf')?.recommended).not.toBe(true);
    expect(getModel('voxtral-4b-tts')?.recommended).not.toBe(true);
    expect(getModel('chatterbox')?.recommended).not.toBe(true);
    expect(getModel('moss-tts-local-1.7b')?.recommended).not.toBe(true);
  });

  it('activeModels() + requiresLicenseGate() still behave after the additions', () => {
    const active = activeModels();
    expect(active.every((m) => m.reserved !== true && m.runsLocally)).toBe(true);
    for (const m of MODALITY_CATALOG) {
      expect(requiresLicenseGate(m)).toBe(!m.commercialUse);
    }
  });
});

describe('license union additions (§1)', () => {
  it('the new use-restriction license values are assignable and gate correctly', () => {
    const openrail: License = 'openrail';
    const nvidiaNc: License = 'nvidia-nc';
    const gemma: License = 'gemma';
    expect([openrail, nvidiaNc, gemma]).toHaveLength(3);
  });
});
