/**
 * The modality catalog — the verified, Apple-Silicon-filtered set of generation
 * models (round-13 research), typed so the model viewer + the pi generate tool
 * can enumerate what runs, on which backend, and under which license.
 *
 * Phase 1 ships the IMAGE entries as fully wired (mflux/MLX, verified on this M5
 * Pro). Audio / video / 3d entries are RESERVED — present so the catalog shape,
 * the license-gating, and the modality enumeration are complete and tested now,
 * but marked `{ reserved: true }` until their backends land in later phases.
 *
 * License gating is first-class: `commercialUse=false` marks NC / community-EULA
 * weights (Voxtral CC-BY-NC, LTX-2 Community, Tencent community, …) that the
 * installer must gate and never auto-enable for commercial use.
 */
import type { Backend, Modality } from './protocol.js';

/** SPDX-ish license id (the ones the round-13 catalog actually uses). */
export type License =
  | 'apache-2.0'
  | 'mit'
  | 'cc-by-nc-4.0'
  | 'ltx-2-community'
  | 'tencent-community'
  | 'stability-community'
  | 'research-nc';

/** mflux console entrypoint per image family — the unified `mflux-generate` only
 * drives the FLUX pipeline, so Z-Image / FLUX.2 / Qwen need their DEDICATED
 * command (verified: `mflux-generate --model z-image-turbo` mis-routes to FLUX
 * weight loading and fails; `mflux-generate-z-image-turbo` is required). */
export interface MfluxBackendConfig {
  readonly kind: 'mflux';
  /** Console script to spawn (e.g. `mflux-generate-z-image-turbo`). */
  readonly command: string;
  /** `--model` arg when the command multiplexes families (flux2 variants, schnell/dev). */
  readonly model?: string;
}

/** A catalog entry for one generation model. */
export interface ModalityModel {
  /** Stable catalog id (what the tool/app references). */
  readonly id: string;
  readonly modality: Modality;
  readonly label: string;
  readonly backend: Backend;
  /** HuggingFace repo (provenance / download surfacing). */
  readonly repo?: string;
  readonly license: License;
  /** Whether the license permits commercial use without a gate. Drives install-EULA gating. */
  readonly commercialUse: boolean;
  /** Approx on-disk size (GB) at the listed quantization. */
  readonly approxSizeGB: number;
  /** Runs locally on Apple Silicon (Metal/MLX). `false` → remote-GPU only. */
  readonly runsLocally: boolean;
  /**
   * Heavy = must hold the unified-memory budget mostly to itself; the JobQueue
   * serialises heavy jobs (one at a time). Light models may run alongside.
   */
  readonly heavy: boolean;
  /** Extra `uv --with` deps beyond the base backend package (e.g. codecs). */
  readonly auxDeps?: readonly string[];
  /** mflux wiring (image phase-1 models only). */
  readonly mflux?: MfluxBackendConfig;
  /** Sensible default denoising steps for this model. */
  readonly defaultSteps?: number;
  /** Default quantization to request (mflux `-q`). */
  readonly defaultQuantize?: 3 | 4 | 5 | 6 | 8;
  /** RESERVED entry: enumerated + gated now, backend lands in a later phase. */
  readonly reserved?: boolean;
  readonly notes?: string;
}

/**
 * The catalog. Ordered image-first; the first image entry is the app default.
 * Newer/heavier variants and reserved modalities follow.
 */
export const MODALITY_CATALOG: readonly ModalityModel[] = [
  // ---- IMAGE (phase 1, all local + verified) ----------------------------
  {
    id: 'flux2-klein-4b',
    modality: 'image',
    label: 'FLUX.2 klein (4B)',
    backend: 'mflux',
    repo: 'black-forest-labs/FLUX.2-klein-4B',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 4.3,
    runsLocally: true,
    heavy: false,
    mflux: { kind: 'mflux', command: 'mflux-generate-flux2', model: 'flux2-klein-4b' },
    defaultSteps: 4,
    defaultQuantize: 4,
    notes:
      'Default. Apache, mflux auto-fetches text-enc+VAE (no manual aux). ~5-6s/512 · ~85s/1024.',
  },
  {
    id: 'z-image-turbo',
    modality: 'image',
    label: 'Z-Image Turbo',
    backend: 'mflux',
    repo: 'Tongyi-MAI/Z-Image-Turbo',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 3.5,
    runsLocally: true,
    heavy: false,
    mflux: { kind: 'mflux', command: 'mflux-generate-z-image-turbo' },
    defaultSteps: 8,
    defaultQuantize: 4,
    notes: 'Fast / smoke model. Few-step turbo; seconds per 1024. Verified end-to-end on M5 Pro.',
  },
  {
    id: 'qwen-image-2512',
    modality: 'image',
    label: 'Qwen-Image 2512',
    backend: 'mflux',
    repo: 'Qwen/Qwen-Image',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 24,
    runsLocally: true,
    heavy: true,
    mflux: { kind: 'mflux', command: 'mflux-generate-qwen' },
    defaultSteps: 20,
    defaultQuantize: 4,
    notes: 'Quality tier. ~24GB 4-bit — tight on 24GB unified memory; runs one-at-a-time (heavy).',
  },
  {
    id: 'flux1-schnell',
    modality: 'image',
    label: 'FLUX.1 schnell',
    backend: 'mflux',
    repo: 'black-forest-labs/FLUX.1-schnell',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 8,
    runsLocally: true,
    heavy: false,
    mflux: { kind: 'mflux', command: 'mflux-generate', model: 'schnell' },
    defaultSteps: 4,
    defaultQuantize: 4,
    notes: 'Proven fallback (unified mflux-generate FLUX pipeline).',
  },

  // ---- AUDIO (reserved; phase 3) ----------------------------------------
  {
    id: 'qwen3-tts-1.7b',
    modality: 'audio',
    label: 'Qwen3-TTS (1.7B)',
    backend: 'mlx-audio',
    repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 4.5,
    runsLocally: true,
    heavy: false,
    auxDeps: ['mlx-audio'],
    reserved: true,
    notes: 'Best default TTS: Apache, self-contained codec, 3s zero-shot voice clone.',
  },
  {
    id: 'kokoro-82m',
    modality: 'audio',
    label: 'Kokoro-82M',
    backend: 'mlx-audio',
    repo: 'hexgrad/Kokoro-82M',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 0.3,
    runsLocally: true,
    heavy: false,
    auxDeps: ['mlx-audio'],
    reserved: true,
    notes: 'Tiny narration presets (no clone).',
  },
  {
    id: 'voxtral-4b-tts',
    modality: 'audio',
    label: 'Voxtral 4B TTS',
    backend: 'mlx-audio',
    repo: 'mistralai/Voxtral-4B-TTS-2603',
    license: 'cc-by-nc-4.0',
    commercialUse: false,
    approxSizeGB: 8,
    runsLocally: true,
    heavy: false,
    auxDeps: ['mlx-audio'],
    reserved: true,
    notes:
      'NON-COMMERCIAL (CC BY-NC). Audio encoder withheld → presets-only unless clone repo added. Gated.',
  },

  // ---- VIDEO (reserved; phase 4) ----------------------------------------
  {
    id: 'hyperframes',
    modality: 'video',
    label: 'HyperFrames (motion graphics)',
    backend: 'hyperframes',
    repo: 'heygen-com/hyperframes',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 0,
    runsLocally: true,
    heavy: false,
    auxDeps: ['ffmpeg', 'headless-chrome'],
    reserved: true,
    notes:
      'Only genuinely-local video path: Node+ffmpeg+headless-Chrome, agent authors HTML/CSS/JS→MP4. Deterministic, CPU. Not photoreal.',
  },
  {
    id: 'ltx-2',
    modality: 'video',
    label: 'LTX-2 (diffusion video)',
    backend: 'hyperframes',
    repo: 'Lightricks/LTX-2',
    license: 'ltx-2-community',
    commercialUse: false,
    approxSizeGB: 64,
    runsLocally: false,
    heavy: true,
    reserved: true,
    notes:
      'REMOTE-GPU only (64GB+, FP8 fails on Metal, multi-file aux). LTX-2 Community EULA gate.',
  },

  // ---- 3D (reserved; phase 5) -------------------------------------------
  {
    id: 'triposr',
    modality: '3d',
    label: 'TripoSR',
    backend: 'triposr',
    repo: 'stabilityai/TripoSR',
    license: 'mit',
    commercialUse: true,
    approxSizeGB: 1.6,
    runsLocally: true,
    heavy: false,
    reserved: true,
    notes: 'Fast image→geometry (OBJ), sub-second, MPS.',
  },
  {
    id: 'trellis-2-4b',
    modality: '3d',
    label: 'TRELLIS.2 (4B)',
    backend: 'trellis',
    repo: 'microsoft/TRELLIS',
    license: 'mit',
    commercialUse: true,
    approxSizeGB: 12,
    runsLocally: true,
    heavy: true,
    reserved: true,
    notes: 'Flagship image→GLB+PBR via community mac port; ~5min/24GB.',
  },
];

/** Index by id for O(1) lookup. */
const BY_ID: ReadonlyMap<string, ModalityModel> = new Map(MODALITY_CATALOG.map((m) => [m.id, m]));

/** Look up a model by catalog id. */
export function getModel(id: string): ModalityModel | undefined {
  return BY_ID.get(id);
}

/** All models for a modality (in catalog order). */
export function modelsForModality(modality: Modality): ModalityModel[] {
  return MODALITY_CATALOG.filter((m) => m.modality === modality);
}

/** Models that are actually wired + runnable now (not reserved, run locally). */
export function activeModels(): ModalityModel[] {
  return MODALITY_CATALOG.filter((m) => m.reserved !== true && m.runsLocally);
}

/** The default image model (the first image entry). */
export function defaultImageModel(): ModalityModel {
  const first = modelsForModality('image')[0];
  if (first === undefined) throw new Error('catalog has no image model');
  return first;
}

/** Whether a model needs an install-EULA / commercial gate before use. */
export function requiresLicenseGate(model: ModalityModel): boolean {
  return model.commercialUse === false;
}
