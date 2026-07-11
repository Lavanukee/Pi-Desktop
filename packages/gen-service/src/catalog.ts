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
import type { Backend, ComfyBackendConfig, Modality } from './protocol.js';

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
  /**
   * Minimum unified-memory (GB) hint to hold this entry at its listed quant
   * (≈ weights + ~1GB headroom). The model manager uses it to auto-prefer the
   * GGUF/MLX tier a machine can hold and to hide tiers it can't. Advisory, not a
   * hard gate.
   */
  readonly minUnifiedMemoryGB?: number;
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
  /** ComfyUI wiring (`comfyui`-backed video / music / advanced-image entries). */
  readonly comfy?: ComfyBackendConfig;
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
  // ---- IMAGE (mflux fast-paths: active + verified) ----------------------
  {
    id: 'flux2-klein-4b',
    modality: 'image',
    label: 'FLUX.2 klein (4B)',
    backend: 'mflux',
    repo: 'black-forest-labs/FLUX.2-klein-4B',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 4.3,
    minUnifiedMemoryGB: 6,
    runsLocally: true,
    heavy: false,
    mflux: { kind: 'mflux', command: 'mflux-generate-flux2', model: 'flux2-klein-4b' },
    defaultSteps: 4,
    defaultQuantize: 4,
    notes:
      'Default. Apache, mflux auto-fetches text-enc+VAE (no manual aux). ~5-6s/512 · ~85s/1024 [measured].',
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
    minUnifiedMemoryGB: 5,
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
    minUnifiedMemoryGB: 24,
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
    minUnifiedMemoryGB: 10,
    runsLocally: true,
    heavy: false,
    mflux: { kind: 'mflux', command: 'mflux-generate', model: 'schnell' },
    defaultSteps: 4,
    defaultQuantize: 4,
    notes: 'Proven fallback (unified mflux-generate FLUX pipeline).',
  },
  {
    id: 'flux1-dev-gguf',
    modality: 'image',
    label: 'FLUX.1-dev GGUF Q6_K (advanced)',
    backend: 'comfyui',
    repo: 'city96/FLUX.1-dev-gguf',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 10,
    minUnifiedMemoryGB: 16,
    runsLocally: true,
    heavy: true,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'flux1-dev-gguf-q6k', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        width: '5.inputs.width',
        height: '5.inputs.height',
        steps: '17.inputs.steps',
        guidance: '26.inputs.guidance',
        seed: '25.inputs.noise_seed',
      },
    },
    notes:
      'Advanced ComfyUI graph (Q6_K + ControlNet/upscale) beyond what mflux one-shots. Q6_K sweet spot, <=6% loss [measured, community]. fp8 checkpoints gated OFF on darwin. Reserved until the ComfyUI backend (Phase A/B) lands. Workflow id/node paths [fwd].',
  },

  // ---- AUDIO · TTS (mlx-audio fast-path: active, NOT ComfyUI) ------------
  {
    id: 'qwen3-tts-1.7b',
    modality: 'audio',
    label: 'Qwen3-TTS (1.7B)',
    backend: 'mlx-audio',
    repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 4.5,
    minUnifiedMemoryGB: 6,
    runsLocally: true,
    heavy: false,
    notes:
      'Default TTS: Apache, self-contained codec, 3s zero-shot voice clone. MLX fast-path (uv worker run_audio), NOT ComfyUI. Base uv --with is mlx-audio (per backend).',
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
    minUnifiedMemoryGB: 2,
    runsLocally: true,
    heavy: false,
    notes:
      'Fast TTS: tiny (0.3GB) narration presets (no clone), ~1500 words <1min [measured]. MLX fast-path, NOT ComfyUI.',
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
    minUnifiedMemoryGB: 10,
    runsLocally: true,
    heavy: false,
    notes:
      'Quality TTS — NON-COMMERCIAL (CC BY-NC), gated. Audio encoder withheld → presets-only unless clone repo added. MLX fast-path, NOT ComfyUI.',
  },

  // ---- AUDIO · Music / SFX (ComfyUI native core nodes; reserved) --------
  {
    id: 'ace-step',
    modality: 'audio',
    label: 'ACE-Step (3.5B)',
    backend: 'comfyui',
    repo: 'ACE-Step/ACE-Step',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 7,
    minUnifiedMemoryGB: 8,
    runsLocally: true,
    heavy: true,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'ace-step-music', // [fwd]
      paramMap: {
        prompt: '14.inputs.tags',
        lyrics: '14.inputs.lyrics',
        seconds: '17.inputs.seconds',
        steps: '3.inputs.steps',
        seed: '3.inputs.seed',
      },
    },
    notes:
      'Default music/SFX via native ComfyUI nodes (EmptyAceStepLatentAudio / TextEncodeAceStepAudio / SaveAudio). Apache, no gate. Loader auto-selects MPS; functional, slower on Mac [measured, qualitative]. Reserved until the ComfyUI backend lands. Workflow id/node paths [fwd].',
  },
  {
    id: 'stable-audio-open',
    modality: 'audio',
    label: 'Stable Audio Open 1.0',
    backend: 'comfyui',
    repo: 'stabilityai/stable-audio-open-1.0',
    license: 'stability-community',
    commercialUse: false,
    approxSizeGB: 5,
    minUnifiedMemoryGB: 6,
    runsLocally: true,
    heavy: false,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'stable-audio-open', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        seconds: '11.inputs.seconds',
        steps: '3.inputs.steps',
        seed: '3.inputs.seed',
      },
    },
    notes:
      'Quality/SFX music via native ComfyUI nodes (+t5_base). stability-community EULA — NON-COMMERCIAL, gated. Reserved until the ComfyUI backend lands. Workflow id/node paths [fwd].',
  },

  // ---- VIDEO (LTX via ComfyUI + the Node/ffmpeg path; reserved) ---------
  {
    id: 'hyperframes',
    modality: 'video',
    label: 'HyperFrames (motion graphics)',
    backend: 'hyperframes',
    repo: 'heygen-com/hyperframes',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 0,
    minUnifiedMemoryGB: 2,
    runsLocally: true,
    heavy: false,
    auxDeps: ['ffmpeg', 'headless-chrome'],
    reserved: true,
    notes:
      'Only genuinely-local non-diffusion video path: Node+ffmpeg+headless-Chrome, agent authors HTML/CSS/JS→MP4. Deterministic, CPU. Not photoreal.',
  },
  {
    id: 'ltx-video-2b-distilled',
    modality: 'video',
    label: 'LTX-Video 2B distilled GGUF (fast)',
    backend: 'comfyui',
    repo: 'Lightricks/LTX-Video',
    license: 'ltx-2-community',
    commercialUse: false,
    approxSizeGB: 8,
    minUnifiedMemoryGB: 16,
    runsLocally: true,
    heavy: true,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'ltx-video-2b-distilled-gguf', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        width: '70.inputs.width',
        height: '70.inputs.height',
        length: '70.inputs.length',
        steps: '72.inputs.steps',
        seed: '73.inputs.noise_seed',
      },
    },
    notes:
      'Safe 16GB video pick: real LTX-Video 2B distilled GGUF Q4, ~2-4s @480-512p, ~15min M1 / ~3-5min M3-M4 [measured]. LTX-2 Community EULA — gated. fp8 hard-excluded on darwin; Euler sampler + --force-upcast-attention. Reserved until the ComfyUI backend lands. Workflow id/node paths [fwd].',
  },
  {
    id: 'ltx-2',
    modality: 'video',
    label: 'LTX-2 distilled GGUF (default)',
    backend: 'comfyui',
    repo: 'Lightricks/LTX-2',
    license: 'ltx-2-community',
    commercialUse: false,
    approxSizeGB: 24,
    minUnifiedMemoryGB: 24,
    runsLocally: true,
    heavy: true,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'ltx-2-distilled-gguf', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        width: '70.inputs.width',
        height: '70.inputs.height',
        length: '70.inputs.length',
        steps: '72.inputs.steps',
        seed: '73.inputs.noise_seed',
      },
    },
    notes:
      'Default video — flipped from mis-tagged remote-only hyperframes to local ComfyUI with tier gating. LTX-2 distilled GGUF Q4_K_M stack ~24GB on disk [projected fwd]; 24GB needs ComfyUI weight-offload (a 24GB Mac addresses ~16-18GB on-GPU), 32GB+ comfortable. tech-demo, minutes/clip; Euler, fp8-excluded. LTX-2 Community EULA — gated. Reserved until the ComfyUI backend lands.',
  },
  {
    id: 'ltx-2-22b',
    modality: 'video',
    label: 'LTX-2 22B (quality · 64GB / remote)',
    backend: 'comfyui',
    repo: 'Lightricks/LTX-2',
    license: 'ltx-2-community',
    commercialUse: false,
    approxSizeGB: 44,
    minUnifiedMemoryGB: 64,
    runsLocally: false,
    heavy: true,
    reserved: true,
    comfy: {
      kind: 'comfyui',
      workflowTemplate: 'ltx-2-22b-gguf', // [fwd]
      paramMap: {
        prompt: '6.inputs.text',
        negativePrompt: '7.inputs.text',
        width: '70.inputs.width',
        height: '70.inputs.height',
        length: '70.inputs.length',
        steps: '72.inputs.steps',
        seed: '73.inputs.noise_seed',
      },
    },
    notes:
      'Quality tier: 22B bf16 / GGUF Q6-Q8. runsLocally:false below 64GB → routes to a remote ComfyUI (same adapter, http://host:port). 22B reliability is tech-demo (2-stage VAE decode hit NaN on analogue). LTX-2 Community EULA — gated.',
  },

  // ---- 3D (direct MLX/uv workers, NOT ComfyUI on Mac; reserved) ---------
  {
    id: 'triposr',
    modality: '3d',
    label: 'TripoSR',
    backend: 'triposr',
    repo: 'stabilityai/TripoSR',
    license: 'mit',
    commercialUse: true,
    approxSizeGB: 1.6,
    minUnifiedMemoryGB: 4,
    runsLocally: true,
    heavy: false,
    reserved: true,
    notes:
      'Fast / 16GB fallback: image→geometry, vertex colors, no PBR. uv worker one-shot (PYTORCH_ENABLE_MPS_FALLBACK=1). Seconds-to-low-minutes on Mac [unverified — MPS-fallback].',
  },
  {
    id: 'trellis-2-4b',
    modality: '3d',
    label: 'TRELLIS.2 (4B)',
    backend: 'trellis',
    repo: 'microsoft/TRELLIS',
    license: 'mit',
    commercialUse: true,
    approxSizeGB: 15,
    minUnifiedMemoryGB: 24,
    runsLocally: true,
    heavy: true,
    reserved: true,
    notes:
      'Default/quality image→textured GLB with full PBR. DIRECT MLX worker (trellis2-mlx), NOT ComfyUI — the community ComfyUI TRELLIS nodes are CUDA-bound. ~15GB weights, persistent worker, ~3.5-5min / ~18GB peak @512³ [measured on analogue]. Resolution knob: 512³ ≤24GB, 1024³ ≥32GB. 16GB unvalidated → use TripoSR. Experimental (sparse-MPS texture sampling; Fast Repair not guaranteed watertight). [fwd slug]',
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
