/**
 * Static data for the Bobble 3D studio — the model roster per pipeline stage,
 * animation presets, and export formats. No fixtures, no promos: assets are
 * live store state (see store.ts) and every list here backs a functional
 * control.
 *
 * Model names are the REAL engines behind each stage — they must name what
 * ACTUALLY runs, never an aspiration:
 *   generation   TRELLIS-2 (Hunyuan 3D Omni has no Metal port, and says so)
 *   segmentation CubePart (Roblox/cubepart)
 *   retopology   QuadriFlow (AutoRemesher is the fallback binary)
 *   rigging      SkinTokens. This comment used to claim the opposite — that
 *                SkinTokens "needs a >=14 GB NVIDIA GPU … cannot run on Apple
 *                Silicon at all" — while RIG_MODEL two screens down already
 *                said SkinTokens and catalog.ts said fp32-on-MPS in ~76s. The
 *                COMMENT was the stale half: skintokens_worker.py runs it here,
 *                and the end-to-end pipeline run MEASURED it rigging a real
 *                265,779-vertex mesh in 73s (14 joints). Naming the stage
 *                SkinTokens is therefore true, and stays.
 *   animation    ARDY is the skeleton TARGET. ARDY itself is Linux + NVIDIA
 *                only, so no motion is generated locally; the Animate panel
 *                says so rather than faking clips.
 */

export interface ModelVersion {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
}

/** Mesh-generation models (the AI Model dropdown in Generate). */
export const GEN_MODELS: readonly ModelVersion[] = [
  { id: 'trellis-2', label: 'TRELLIS-2', hint: 'Image or text to 3D — runs on Metal here' },
  {
    id: 'hunyuan-omni',
    label: 'Hunyuan 3D Omni',
    hint: 'No Metal/MPS port — unavailable on this Mac',
  },
];

/** One engine per downstream stage (shown as the stage's Model row). */
export const SEGMENT_MODEL = 'CubePart';
export const RETOPO_MODEL = 'QuadriFlow';
export const TEXTURE_MODEL = 'TRELLIS-2';
/**
 * Rigging has three, and which one runs is decided by the answered shape
 * question — so the panel names the one that ACTUALLY ran rather than a single
 * constant. The row that used to say "SkinTokens" for everything was wrong for
 * every humanoid, which is fitted to a template and never touches it.
 */
export const RIG_MODEL = 'Medial axis';
export const MEDIAL_MODEL = 'Medial axis';
export const TEMPLATE_RIG_MODEL = 'cskel27 template';
export const LEARNED_RIG_MODEL = 'SkinTokens';
export const ANIM_MODEL = 'ARDY';

/** Animation presets for the Animate panel grid (pose id → mannequin pose). */
export interface TripoAnim {
  readonly id: string;
  readonly kind: 'basic' | 'interactive';
}
export const TRIPO_ANIMS: readonly TripoAnim[] = [
  { id: 'angry_01', kind: 'basic' },
  { id: 'afraid', kind: 'basic' },
  { id: 'agree', kind: 'interactive' },
  { id: 'angry_02', kind: 'basic' },
  { id: 'cheer', kind: 'interactive' },
  { id: 'clap', kind: 'interactive' },
  { id: 'dance_01', kind: 'basic' },
  { id: 'hello', kind: 'interactive' },
  { id: 'idle', kind: 'basic' },
  { id: 'jump', kind: 'basic' },
  { id: 'kick', kind: 'basic' },
  { id: 'point', kind: 'interactive' },
  { id: 'run', kind: 'basic' },
  { id: 'sad_01', kind: 'basic' },
  { id: 'walk', kind: 'basic' },
  { id: 'wave', kind: 'interactive' },
];

/** Formats the Export dialog actually writes (three.js exporters — all real). */
export const EXPORT_FORMATS = ['GLB', 'OBJ', 'STL', 'USDZ'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
