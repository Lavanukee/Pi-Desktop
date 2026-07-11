/**
 * ComfyUI workflow-JSON template registry + fill (round-13 synthesis §2/§5 Phase
 * A). ComfyUI's `/prompt` endpoint takes an **API-format** graph — a flat map of
 * `nodeId → { class_type, inputs }`. Each generation modality (LTX video,
 * ACE-Step music, FLUX-GGUF advanced image) ships as ONE parameterized template
 * here: a static graph whose per-job values (`prompt` / `width` / `steps` /
 * `seed` / …) are spliced in at run time from a {@link ComfyJobSpec}.
 *
 * The splice addresses are the template's `paramMap` — the SAME node-input paths
 * the catalog's {@link ../catalog!ModalityModel.comfy} config carries (e.g.
 * `prompt` → `"6.inputs.text"`). The registry is the runtime source of truth for
 * those paths (a {@link ComfyJobSpec} deliberately does NOT carry the map — it
 * stays catalog-free so a remote ComfyUI needs no TS catalog); a co-located test
 * cross-checks that every registry `paramMap` matches its catalog entry so the
 * two can't drift.
 *
 * NOTE (honesty): the node ids / class_types / connections below are the plan's
 * `[fwd]` placeholders — structurally valid API-format graphs finalised against
 * the real published graphs at build time. What is load-bearing NOW and tested
 * is the FILL mechanism (path-splice + per-candidate seed) and the paramMap ↔
 * catalog consistency, not the exact denoise wiring.
 */
import type { ComfyJobSpec } from './protocol.js';

/** One node in a ComfyUI API-format graph. */
export interface ComfyNode {
  readonly class_type: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly _meta?: { readonly title?: string };
}

/** A ComfyUI API-format graph: `nodeId → node`. This is exactly what `/prompt` takes. */
export type ComfyGraph = Readonly<Record<string, ComfyNode>>;

/** A parameterized workflow template: a base graph + where each catalog param splices in. */
export interface WorkflowTemplate {
  /** Template id (matches a catalog entry's `comfy.workflowTemplate`). */
  readonly id: string;
  /** API-format base graph with placeholder default values. */
  readonly graph: ComfyGraph;
  /** catalog param name → dotted node-input path (mirrors the catalog `comfy.paramMap`). */
  readonly paramMap: Readonly<Record<string, string>>;
}

// ── graph builders (one per modality family) ────────────────────────────────
// Kept as small factories so the three LTX variants share one graph shape and
// the file stays readable. Connections are `[nodeId, outputSlot]` refs, ComfyUI's
// API-format wire encoding.

/** LTX-Video (image/text → video). Shared by the 2B-distilled / default / 22B rows. */
function ltxVideoGraph(): ComfyGraph {
  return {
    '38': { class_type: 'CLIPLoader', inputs: { clip_name: 't5xxl.safetensors', type: 'ltxv' } },
    '44': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'ltxv-distilled-q4_k_m.gguf' } },
    '45': { class_type: 'VAELoader', inputs: { vae_name: 'ltxv-vae.safetensors' } },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Positive prompt' },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Negative prompt' },
    },
    '70': {
      class_type: 'EmptyLTXVLatentVideo',
      inputs: { width: 512, height: 512, length: 97, batch_size: 1 },
    },
    '72': {
      class_type: 'LTXVScheduler',
      inputs: { steps: 8, max_shift: 2.05, base_shift: 0.95, stretch: true, latent: ['70', 0] },
    },
    '73': {
      class_type: 'KSamplerSelect',
      inputs: {
        noise_seed: 0,
        sampler_name: 'euler', // Euler: uni_pc diverges → rainbow noise on MPS [measured]
        model: ['44', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['70', 0],
        sigmas: ['72', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['73', 0], vae: ['45', 0] } },
    '9': {
      class_type: 'SaveVideo',
      inputs: { images: ['8', 0], filename_prefix: 'pi-video', format: 'mp4', fps: 24 },
    },
  };
}

const LTX_PARAM_MAP = {
  prompt: '6.inputs.text',
  negativePrompt: '7.inputs.text',
  width: '70.inputs.width',
  height: '70.inputs.height',
  length: '70.inputs.length',
  steps: '72.inputs.steps',
  seed: '73.inputs.noise_seed',
} as const;

/**
 * Wan2.1 T2V (text → video) via native ComfyUI nodes. Shares the LTX node-id
 * skeleton (positive/negative encode, empty latent video, scheduler, sampler,
 * VAE decode, save) so the SAME `LTX_PARAM_MAP` binds it and the fill mechanism
 * is what's tested; exact Wan class_types / connections are `[fwd]` placeholders.
 */
function wanVideoGraph(): ComfyGraph {
  return {
    '38': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn.safetensors', type: 'wan' },
    },
    '44': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'wan2.1_t2v_1.3B_bf16.safetensors', weight_dtype: 'default' },
    },
    '45': { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Positive prompt' },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['38', 0] },
      _meta: { title: 'Negative prompt' },
    },
    '70': {
      class_type: 'EmptyHunyuanLatentVideo',
      inputs: { width: 480, height: 480, length: 33, batch_size: 1 },
    },
    '72': {
      class_type: 'BasicScheduler',
      inputs: { steps: 20, denoise: 1, scheduler: 'simple', model: ['44', 0], latent: ['70', 0] },
    },
    '73': {
      class_type: 'KSampler',
      inputs: {
        noise_seed: 0,
        sampler_name: 'euler',
        model: ['44', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['70', 0],
        sigmas: ['72', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['73', 0], vae: ['45', 0] } },
    '9': {
      class_type: 'SaveVideo',
      inputs: { images: ['8', 0], filename_prefix: 'pi-video', format: 'mp4', fps: 16 },
    },
  };
}

/** ACE-Step (text → music) via native ComfyUI core nodes. */
function aceStepGraph(): ComfyGraph {
  return {
    '40': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'ace_step_v1_3.5b.safetensors' },
    },
    '14': {
      class_type: 'TextEncodeAceStepAudio',
      inputs: { tags: '', lyrics: '', lyrics_strength: 0.99, clip: ['40', 1] },
    },
    '15': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['14', 0] } },
    '17': {
      class_type: 'EmptyAceStepLatentAudio',
      inputs: { seconds: 120, batch_size: 1 },
    },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 50,
        cfg: 5,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['40', 0],
        positive: ['14', 0],
        negative: ['15', 0],
        latent_image: ['17', 0],
      },
    },
    '18': { class_type: 'VAEDecodeAudio', inputs: { samples: ['3', 0], vae: ['40', 2] } },
    '19': { class_type: 'SaveAudio', inputs: { audio: ['18', 0], filename_prefix: 'pi-music' } },
  };
}

const ACE_STEP_PARAM_MAP = {
  prompt: '14.inputs.tags',
  lyrics: '14.inputs.lyrics',
  seconds: '17.inputs.seconds',
  steps: '3.inputs.steps',
  seed: '3.inputs.seed',
} as const;

/** Stable Audio Open (text → music/SFX) via native ComfyUI core nodes. */
function stableAudioGraph(): ComfyGraph {
  return {
    '40': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'stable_audio_open_1.0.safetensors' },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['40', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['40', 1] } },
    '11': { class_type: 'EmptyLatentAudio', inputs: { seconds: 47, batch_size: 1 } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 50,
        cfg: 5,
        sampler_name: 'dpmpp_3m_sde_gpu',
        scheduler: 'exponential',
        denoise: 1,
        model: ['40', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['11', 0],
      },
    },
    '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['3', 0], vae: ['40', 2] } },
    '13': { class_type: 'SaveAudio', inputs: { audio: ['12', 0], filename_prefix: 'pi-audio' } },
  };
}

const STABLE_AUDIO_PARAM_MAP = {
  prompt: '6.inputs.text',
  negativePrompt: '7.inputs.text',
  seconds: '11.inputs.seconds',
  steps: '3.inputs.steps',
  seed: '3.inputs.seed',
} as const;

/** FLUX.1-dev GGUF Q6_K advanced image graph (beyond what mflux one-shots). */
function fluxGgufGraph(): ComfyGraph {
  return {
    '10': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '11': {
      class_type: 'DualCLIPLoader',
      inputs: {
        clip_name1: 't5xxl_fp16.safetensors',
        clip_name2: 'clip_l.safetensors',
        type: 'flux',
      },
    },
    '12': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q6_K.gguf' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['11', 0] } },
    '26': { class_type: 'FluxGuidance', inputs: { guidance: 3.5, conditioning: ['6', 0] } },
    '22': { class_type: 'BasicGuider', inputs: { model: ['12', 0], conditioning: ['26', 0] } },
    '16': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '17': {
      class_type: 'BasicScheduler',
      inputs: { scheduler: 'simple', steps: 20, denoise: 1, model: ['12', 0] },
    },
    '25': { class_type: 'RandomNoise', inputs: { noise_seed: 0 } },
    '13': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['25', 0],
        guider: ['22', 0],
        sampler: ['16', 0],
        sigmas: ['17', 0],
        latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['10', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pi-image' } },
  };
}

const FLUX_GGUF_PARAM_MAP = {
  prompt: '6.inputs.text',
  width: '5.inputs.width',
  height: '5.inputs.height',
  steps: '17.inputs.steps',
  guidance: '26.inputs.guidance',
  seed: '25.inputs.noise_seed',
} as const;

/**
 * The template registry, keyed by template id. Every id here is referenced by a
 * `comfyui`-backed catalog entry's `comfy.workflowTemplate`; the three LTX rows
 * share one graph shape (they differ only by which GGUF weights get downloaded,
 * not by graph topology).
 */
export const WORKFLOW_TEMPLATES: Readonly<Record<string, WorkflowTemplate>> = {
  'ltx-video-2b-distilled-gguf': {
    id: 'ltx-video-2b-distilled-gguf',
    graph: ltxVideoGraph(),
    paramMap: LTX_PARAM_MAP,
  },
  'ltx-2-distilled-gguf': {
    id: 'ltx-2-distilled-gguf',
    graph: ltxVideoGraph(),
    paramMap: LTX_PARAM_MAP,
  },
  'ltx-2-22b-gguf': {
    id: 'ltx-2-22b-gguf',
    graph: ltxVideoGraph(),
    paramMap: LTX_PARAM_MAP,
  },
  'wan2.1-t2v-1.3b': {
    id: 'wan2.1-t2v-1.3b',
    graph: wanVideoGraph(),
    paramMap: LTX_PARAM_MAP,
  },
  'ace-step-music': {
    id: 'ace-step-music',
    graph: aceStepGraph(),
    paramMap: ACE_STEP_PARAM_MAP,
  },
  'stable-audio-open': {
    id: 'stable-audio-open',
    graph: stableAudioGraph(),
    paramMap: STABLE_AUDIO_PARAM_MAP,
  },
  'stable-audio-open-small': {
    id: 'stable-audio-open-small',
    graph: stableAudioGraph(),
    paramMap: STABLE_AUDIO_PARAM_MAP,
  },
  'flux1-dev-gguf-q6k': {
    id: 'flux1-dev-gguf-q6k',
    graph: fluxGgufGraph(),
    paramMap: FLUX_GGUF_PARAM_MAP,
  },
};

/** Look up a template by id. */
export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES[id];
}

/** Set a value at a dotted node-input path (e.g. `"6.inputs.text"`), creating gaps. */
function setAtPath(root: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const segs = dottedPath.split('.');
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const key = segs[i];
    if (key === undefined) return;
    const next = cur[key];
    if (typeof next !== 'object' || next === null) {
      const created: Record<string, unknown> = {};
      cur[key] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  const last = segs[segs.length - 1];
  if (last !== undefined) cur[last] = value;
}

/**
 * Resolve a {@link ComfyJobSpec} + a single candidate seed into a concrete,
 * POST-able API-format graph: deep-clone the named template, splice each
 * `spec.inputs[param]` in at its `paramMap` path, then stamp THIS candidate's
 * `seed` at the template's seed path (the per-candidate seed always wins over any
 * `seed` in `inputs`). Pure — the adapter calls it once per seed.
 *
 * Throws on an unknown template id, or an input param the template has no binding
 * for (a catalog/template drift the caller should never produce).
 */
export function fillWorkflow(
  spec: ComfyJobSpec,
  seed: number,
  registry: Readonly<Record<string, WorkflowTemplate>> = WORKFLOW_TEMPLATES,
): ComfyGraph {
  const tmpl = registry[spec.workflowTemplate];
  if (tmpl === undefined) {
    throw new Error(`unknown ComfyUI workflow template: "${spec.workflowTemplate}"`);
  }
  const graph = structuredClone(tmpl.graph) as unknown as Record<string, unknown>;
  for (const [param, value] of Object.entries(spec.inputs)) {
    const path = tmpl.paramMap[param];
    if (path === undefined) {
      throw new Error(`template "${tmpl.id}" has no paramMap binding for input "${param}"`);
    }
    setAtPath(graph, path, value);
  }
  const seedPath = tmpl.paramMap.seed;
  if (seedPath !== undefined) setAtPath(graph, seedPath, seed);
  return graph as unknown as ComfyGraph;
}
