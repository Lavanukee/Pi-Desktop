/**
 * Static data for the Bobble 3D studio — the model roster per pipeline stage,
 * animation presets, and export formats. No fixtures, no promos: assets are
 * live store state (see store.ts) and every list here backs a functional
 * control.
 *
 * Model names are the REAL open models this studio is built around (roadmap):
 * generation = Hunyuan 3D Omni / TRELLIS-2, segmentation = CubePart
 * (Roblox/cubepart), retopology = AutoRemesher, rigging = SkinTokens,
 * animation = ARDY. The demo pipeline is sample-asset-backed until the live
 * engines are wired; the names label the intended engine per stage.
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
export const RETOPO_MODEL = 'AutoRemesher';
export const TEXTURE_MODEL = 'Hunyuan Paint';
export const RIG_MODEL = 'SkinTokens';
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
