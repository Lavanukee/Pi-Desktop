/**
 * Pure presentation logic for the model browser's GENERATION category tabs —
 * kept React-free so the modality→category mapping, the Recommended-first
 * ordering, and the gate rule are unit-testable and can't drift from
 * gen-service. Mirrors {@link ./model-manager-logic} for the LLM catalog.
 */
import type { ModalityCatalogEntry } from '../../electron/gen/gen-ipc-contract';

/**
 * A model-browser category tab. The gen-service catalog only carries four
 * modalities (image/audio/video/3d), so `music` is DERIVED — an `audio` row on
 * the ComfyUI backend (ACE-Step, Stable Audio) is music/SFX, everything else
 * `audio` is TTS/voice. `perception` has no catalog rows yet (arrives with the
 * perception phase) — its tab renders empty with only the Browse-HF escape hatch.
 */
export type ModalityCategory = 'image' | 'video' | 'audio' | 'music' | '3d' | 'perception';

export interface ModalityCategoryDef {
  readonly id: ModalityCategory;
  readonly label: string;
  /** One-line description shown atop the category grid. */
  readonly blurb: string;
}

/** The category tabs, in browser order (Language lives outside this list — it is
 * the existing LLM catalog). */
export const MODALITY_CATEGORIES: readonly ModalityCategoryDef[] = [
  {
    id: 'image',
    label: 'Image',
    blurb: 'Text-to-image generation (mflux / MLX, Apple-Silicon native).',
  },
  { id: 'video', label: 'Video', blurb: 'Text-to-video and motion graphics.' },
  { id: 'audio', label: 'Audio', blurb: 'Text-to-speech and voice cloning.' },
  { id: 'music', label: 'Music', blurb: 'Music and sound-effect generation.' },
  { id: '3d', label: '3D', blurb: 'Image-to-3D and text-to-3D mesh generation.' },
  {
    id: 'perception',
    label: 'Perception',
    blurb: 'Detection, segmentation and grounding — arriving in a later update.',
  },
];

const CATEGORY_LABELS = new Map(MODALITY_CATEGORIES.map((c) => [c.id, c.label]));

/** The human label for a category (falls back to the id). */
export function categoryLabel(category: ModalityCategory): string {
  return CATEGORY_LABELS.get(category) ?? category;
}

/** Which browser category a catalog entry belongs to. */
export function categoryOf(entry: ModalityCatalogEntry): ModalityCategory {
  switch (entry.modality) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case '3d':
      return '3d';
    case 'audio':
      // ComfyUI-backed audio = music / SFX synthesis; the rest is TTS/voice.
      return entry.backend === 'comfyui' ? 'music' : 'audio';
    default:
      return 'image';
  }
}

/**
 * The entries for one category, RECOMMENDED-first, then smallest-first (by
 * approx size), then alphabetical — a fresh, stable array (never mutates input).
 */
export function entriesForCategory(
  entries: readonly ModalityCatalogEntry[],
  category: ModalityCategory,
): ModalityCatalogEntry[] {
  return entries
    .filter((e) => categoryOf(e) === category)
    .sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.approxSizeGB - b.approxSizeGB || a.label.localeCompare(b.label);
    });
}

/**
 * Whether a modality entry needs a commercial/EULA gate before use — the exact
 * mirror of gen-service `requiresLicenseGate` (commercialUse === false). Drives
 * the gated lock pill.
 */
export function modalityRequiresGate(entry: ModalityCatalogEntry): boolean {
  return entry.commercialUse === false;
}

/** Approx on-disk size for a card, humanised (0 GB = weightless, e.g. HyperFrames). */
export function formatApproxSize(gb: number): string {
  if (gb <= 0) return 'No weights';
  return gb >= 10 ? `~${Math.round(gb)} GB` : `~${gb} GB`;
}
