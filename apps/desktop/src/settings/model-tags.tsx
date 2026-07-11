/**
 * Round-10 Wave C (#20b): the Model Manager's capability/attribute PILL TAGS.
 *
 * Every model surface (curated {@link ModelCard}, HF {@link HfResultCard}, the
 * Recommended banner, and the Apple card) renders its attributes as larger,
 * COLORED pills instead of the old tiny grey text — one distinct hue per
 * attribute so a card's capabilities read at a glance:
 *   vision → violet · recommended → green · audio → amber · MTP → blue ·
 *   EAGLE-3 → teal · DFlash → indigo · reliable → green · engine → slate ·
 *   gated → neutral/locked · size & quant → neutral.
 * (MTP + EAGLE-3 + DFlash are the speculative-decoding "fast" pills; all use the
 * bolt. round-12: DFlash is real upstream now, reliable-publisher + engine pills.)
 * The pill chrome + per-hue colours live app-locally in `styles/global.css`
 * (`.pd-mm-pill*`) — deliberately NOT in @pi-desktop/ui (Wave B owns that) — and
 * are tuned for AA contrast in both light and dark modes.
 */
import type { ReactNode } from 'react';
import type { HfModelHitDTO } from '../../electron/ipc-contract';
import {
  IconBolt,
  IconCpu,
  IconCube,
  IconEye,
  IconFilm,
  IconImage,
  IconLock,
  IconMusic,
  IconShield,
  IconSparkle,
  IconWaveform,
} from './icons';
import type { ModalityCategory } from './modality-catalog-logic';
import { type SpecMethod, VARIANT_LABEL } from './model-manager-logic';

/** The attribute a pill represents; drives its colour class + default glyph. */
export type ModelTagKind =
  | 'vision'
  | 'recommended'
  | 'audio'
  | 'modality'
  | 'mtp'
  | 'eagle3'
  | 'dflash'
  | 'reliable'
  | 'engine'
  | 'gated'
  | 'size'
  | 'quant'
  | 'neutral';

/** Default glyph per kind (neutral/size/quant are glyph-less by design). */
function defaultIcon(kind: ModelTagKind): ReactNode {
  switch (kind) {
    case 'vision':
      return <IconEye size={12} />;
    case 'recommended':
      return <IconSparkle size={12} />;
    case 'audio':
      return <IconWaveform size={12} />;
    case 'mtp':
    case 'eagle3':
    case 'dflash':
      return <IconBolt size={12} />;
    case 'reliable':
      return <IconShield size={12} />;
    case 'engine':
      return <IconCpu size={12} />;
    case 'gated':
      return <IconLock size={11} />;
    default:
      return null;
  }
}

export interface ModelTagProps {
  kind: ModelTagKind;
  children: ReactNode;
  /** Override the default glyph; pass `null` to render a text-only pill. */
  icon?: ReactNode | null;
  title?: string;
  'data-testid'?: string;
}

/** One colored capability pill. */
export function ModelTag({ kind, children, icon, title, ...rest }: ModelTagProps) {
  const glyph = icon === undefined ? defaultIcon(kind) : icon;
  return (
    <span
      className={`pd-mm-pill pd-mm-pill--${kind}`}
      data-pill-kind={kind}
      title={title}
      data-testid={rest['data-testid']}
    >
      {glyph}
      {children}
    </span>
  );
}

/** Icon + label per generation category, for the modality pill. */
const MODALITY_PILL: Record<ModalityCategory, { label: string; icon: ReactNode }> = {
  image: { label: 'Image', icon: <IconImage size={12} /> },
  video: { label: 'Video', icon: <IconFilm size={12} /> },
  audio: { label: 'Audio', icon: <IconWaveform size={12} /> },
  music: { label: 'Music', icon: <IconMusic size={12} /> },
  '3d': { label: '3D', icon: <IconCube size={12} /> },
  perception: { label: 'Perception', icon: <IconEye size={12} /> },
};

/** The generation-modality pill (Image / Video / Audio / Music / 3D) — one hue,
 * a per-category glyph, so a modality card's kind reads at a glance. */
export function ModalityPill({
  category,
  ...rest
}: {
  category: ModalityCategory;
  'data-testid'?: string;
}) {
  const { label, icon } = MODALITY_PILL[category];
  return (
    <ModelTag kind="modality" icon={icon} data-testid={rest['data-testid']}>
      {label}
    </ModelTag>
  );
}

/** Human-readable title per speed method (hovered on the pill). */
const SPEC_TITLE: Record<SpecMethod, string> = {
  mtp: 'Multi-token prediction (faster decode)',
  eagle3: 'EAGLE-3 speculative decoding (faster)',
  dflash: 'DFlash speculative decoding (faster)',
};

/** A colored speed-method pill (MTP / DFlash / EAGLE-3). The `data-pill-kind`
 * matches the method so each hue reads at a glance. */
export function SpecPill({ method }: { method: SpecMethod }) {
  return (
    <ModelTag kind={method} title={SPEC_TITLE[method]}>
      {VARIANT_LABEL[method]}
    </ModelTag>
  );
}

/** Whether an HF hit looks multimodal (vision) from its pipeline/tags. */
export function hfHasVision(hit: HfModelHitDTO): boolean {
  const tags = hit.tags.map((t) => t.toLowerCase());
  return (
    (hit.pipelineTag ?? '').includes('image') ||
    tags.some((t) => t.includes('image-text') || t === 'vision' || t.includes('mmproj'))
  );
}

/** Whether an HF hit looks like an audio/speech model from its pipeline/tags. */
export function hfHasAudio(hit: HfModelHitDTO): boolean {
  const pipe = (hit.pipelineTag ?? '').toLowerCase();
  if (pipe.includes('audio') || pipe.includes('speech') || pipe.includes('asr')) return true;
  return hit.tags.some((t) => {
    const l = t.toLowerCase();
    return l.includes('audio') || l.includes('speech') || l === 'asr';
  });
}
