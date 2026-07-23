/**
 * The gen3d model catalog — the single TypeScript source of truth for which
 * repos each engine model needs, their REAL download sizes (verified against
 * the HF API, 2026-07-23), and how installed-ness is detected on disk.
 *
 * The Python sidecar receives this registry as JSON at startup (written by
 * gen3d-main via {@link toSidecarRegistry}), so repo lists / allow-patterns /
 * byte totals are never duplicated in Python.
 *
 * Notable engineering facts encoded here (see packages/gen3d-engine/FEASIBILITY.md):
 *  - TRELLIS.2's true structure presets are 512 / 1024 / 1536 (the checkpoint
 *    set ships 512+1024 DiTs; 1536 runs as the `1536_cascade` pipeline type).
 *  - `facebook/dinov3-*` and `briaai/RMBG-2.0` are GATED on HF. When the user
 *    has no HF token we download byte-identical public mirrors instead
 *    (camenduru / 1038lab — sizes verified equal) and patch the cached
 *    pipeline.json to reference them.
 *  - The Hunyuan Paint download is ONLY the paintpbr subfolders of
 *    tencent/Hunyuan3D-2.1 (6.9 GB), not the whole 14.9 GB repo.
 *  - AutoRemesher is the official 1.0.0 arm64 release binary (17 MB), driven
 *    headlessly via its CLI — no weights.
 */
import * as os from 'node:os';
import * as path from 'node:path';

export type Gen3dModelId = 'trellis2' | 'mageflow' | 'hunyuan-paint' | 'cubepart' | 'autoremesher';
export type Gen3dRole = 'geometry' | 'image' | 'texture' | 'segment' | 'retopo';
export type Gen3dResolution = 'low' | 'medium' | 'high';

/** One HF repo (or subset of it) a model needs on disk. */
export interface Gen3dRepoSpec {
  readonly repo: string;
  /** hf snapshot allow-patterns; undefined = whole repo. */
  readonly allowPatterns?: readonly string[];
  /** Byte total for exactly the allowed patterns (HF API, blobs=true). */
  readonly bytes: number;
}

export interface Gen3dModelSpec {
  readonly id: Gen3dModelId;
  readonly label: string;
  readonly role: Gen3dRole;
  readonly note: string;
  readonly repos: readonly Gen3dRepoSpec[];
  /** Which runtime environment the sidecar must provision for this model. */
  readonly env: 'trellis' | 'mageflow' | 'cubepart' | 'paint' | 'binary';
}

/**
 * TRELLIS.2's VERIFIED structure-resolution presets. The repo's checkpoints
 * are `*_512` and `*_1024` DiTs; upstream `pipeline_type` accepts
 * '512' | '1024' | '1024_cascade' | '1536_cascade' (trellis2_image_to_3d.py).
 * So low/medium/high = 512/1024/1536 — NOT 768/1024/1536.
 */
export const TRELLIS_RESOLUTIONS: Readonly<Record<Gen3dResolution, number>> = {
  low: 512,
  medium: 1024,
  high: 1536,
};

/** How each preset maps onto an upstream pipeline type on this hardware.
 * medium uses `1024_cascade` (the upstream default — better quality than the
 * direct 1024 path at similar cost); high is `1536_cascade`, which is the
 * true 1536 preset but is memory-hungry — the engine attempts it and reports an
 * honest error if the 24 GB watchdog kills it. */
export const TRELLIS_PIPELINE_TYPES: Readonly<Record<Gen3dResolution, string>> = {
  low: '512',
  medium: '1024_cascade',
  high: '1536_cascade',
};

/** Gated-repo → public substitutions used when the machine has no HF token
 * (patched into the cached pipeline.json). DINOv3 uses a byte-identical
 * mirror. For rembg, RMBG-2.0's remote code is stale against modern
 * transformers ('Config' lacks model_type/get_text_config — VERIFIED broken
 * with both 5.14.1 and 4.57.1 here), so we substitute the original author's
 * maintained ZhengPeng7/BiRefNet (same architecture RMBG-2.0 trains from,
 * MIT, not gated) — verified loading cleanly under transformers 4.57.1. */
export const GATED_MIRRORS: Readonly<Record<string, string>> = {
  'facebook/dinov3-vitl16-pretrain-lvd1689m': 'camenduru/dinov3-vitl16-pretrain-lvd1689m',
  'briaai/RMBG-2.0': 'ZhengPeng7/BiRefNet',
};

/** Official AutoRemesher 1.0.0 release (native arm64 binary, MIT). */
export const AUTOREMESHER_DMG_URL =
  'https://github.com/huxingyi/autoremesher/releases/download/1.0.0/autoremesher-1.0.0.dmg';
export const AUTOREMESHER_DMG_BYTES = 17_259_387;

export const GEN3D_MODEL_SPECS: readonly Gen3dModelSpec[] = [
  {
    id: 'trellis2',
    label: 'TRELLIS-2 (4B)',
    role: 'geometry',
    note: 'Image → 3D with native PBR texturing (microsoft/TRELLIS.2-4B, Metal/MPS port)',
    env: 'trellis',
    repos: [
      { repo: 'microsoft/TRELLIS.2-4B', bytes: 16_237_485_044 },
      {
        repo: 'microsoft/TRELLIS-image-large',
        allowPatterns: ['ckpts/ss_dec_conv3d_16l8_fp16*'],
        bytes: 147_592_217,
      },
      // Public substitutes for the two gated aux models (see GATED_MIRRORS).
      { repo: 'camenduru/dinov3-vitl16-pretrain-lvd1689m', bytes: 1_212_584_680 },
      {
        repo: 'ZhengPeng7/BiRefNet',
        // Exactly what AutoModelForImageSegmentation(trust_remote_code) pulls —
        // a glob like '*.py' would demand handler.py, which is never fetched.
        allowPatterns: ['config.json', 'birefnet.py', 'BiRefNet_config.py', 'model.safetensors'],
        bytes: 444_566_195,
      },
    ],
  },
  {
    id: 'mageflow',
    label: 'Mage-Flow Turbo',
    role: 'image',
    note: 'Text → image in 4 steps, the first hop of text → 3D (microsoft/Mage-Flow-Turbo, MIT)',
    env: 'mageflow',
    repos: [
      {
        repo: 'microsoft/Mage-Flow-Turbo',
        allowPatterns: ['transformer/*', 'text_encoder/*', 'vae/*', 'scheduler/*', '*.json'],
        bytes: 17_463_920_534,
      },
    ],
  },
  {
    id: 'hunyuan-paint',
    label: 'Hunyuan Paint',
    role: 'texture',
    note: 'PBR texture painting for existing meshes (tencent/Hunyuan3D-2.1 paintpbr subset)',
    env: 'paint',
    repos: [
      {
        repo: 'tencent/Hunyuan3D-2.1',
        allowPatterns: ['hunyuan3d-paintpbr-v2-1/*', 'hy3dpaint/*'],
        bytes: 6_887_601_302,
      },
    ],
  },
  {
    id: 'cubepart',
    label: 'CubePart',
    role: 'segment',
    note: 'Mesh + part names → per-part meshes (Roblox/cubepart, OpenRAIL)',
    env: 'cubepart',
    repos: [{ repo: 'Roblox/cubepart', bytes: 9_903_730_587 }],
  },
  {
    id: 'autoremesher',
    label: 'AutoRemesher',
    role: 'retopo',
    note: 'Quad retopology CLI (huxingyi/autoremesher 1.0.0, MIT, native arm64)',
    env: 'binary',
    repos: [],
  },
];

/** Total bytes the download dialog shows for a model (weights only; the
 * AutoRemesher binary is its release dmg). */
export function specTotalBytes(spec: Gen3dModelSpec): number {
  if (spec.id === 'autoremesher') return AUTOREMESHER_DMG_BYTES;
  return spec.repos.reduce((sum, r) => sum + r.bytes, 0);
}

/** Root for everything the engine stores: weights (hf/), tool sources+venvs
 * (src/), binaries (bin/), install stamps (installed/). */
export function engineCacheDir(home: string = os.homedir()): string {
  return path.join(home, '.cache', 'pi-desktop', 'gen3d');
}

/** Job artifacts must live inside the renderer-readable sandbox fence:
 * `~/.pi/desktop/sandbox/gen3d/<jobId>/` (see fs-handlers allowedWriteRoots). */
export function gen3dSandboxDir(home: string = os.homedir()): string {
  return path.join(home, '.pi', 'desktop', 'sandbox', 'gen3d');
}

/** The sidecar writes `installed/<id>.json` after weights + env are verified;
 * this is the cheap TS-side installed probe used before the sidecar is up. */
export function installStampPath(cacheDir: string, id: Gen3dModelId): string {
  return path.join(cacheDir, 'installed', `${id}.json`);
}

/** Pure installed-state reducer over an injectable exists() (tests). */
export function detectInstalled(
  existsFn: (p: string) => boolean,
  cacheDir: string,
): Record<Gen3dModelId, boolean> {
  const out = {} as Record<Gen3dModelId, boolean>;
  for (const spec of GEN3D_MODEL_SPECS) {
    out[spec.id] = existsFn(installStampPath(cacheDir, spec.id));
  }
  return out;
}

/** The JSON registry handed to the Python sidecar (single source of truth —
 * Python never hardcodes repos/sizes). */
export function toSidecarRegistry(): {
  models: {
    id: Gen3dModelId;
    env: Gen3dModelSpec['env'];
    totalBytes: number;
    repos: { repo: string; allowPatterns?: readonly string[]; bytes: number }[];
  }[];
  gatedMirrors: Record<string, string>;
  autoremesher: { dmgUrl: string; dmgBytes: number };
  pipelineTypes: Record<Gen3dResolution, string>;
} {
  return {
    models: GEN3D_MODEL_SPECS.map((s) => ({
      id: s.id,
      env: s.env,
      totalBytes: specTotalBytes(s),
      repos: s.repos.map((r) => ({
        repo: r.repo,
        ...(r.allowPatterns !== undefined ? { allowPatterns: r.allowPatterns } : {}),
        bytes: r.bytes,
      })),
    })),
    gatedMirrors: { ...GATED_MIRRORS },
    autoremesher: { dmgUrl: AUTOREMESHER_DMG_URL, dmgBytes: AUTOREMESHER_DMG_BYTES },
    pipelineTypes: { ...TRELLIS_PIPELINE_TYPES },
  };
}
