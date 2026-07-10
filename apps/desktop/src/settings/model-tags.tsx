/**
 * Round-10 Wave C (#20b): the Model Manager's capability/attribute PILL TAGS.
 *
 * Every model surface (curated {@link ModelCard}, HF {@link HfResultCard}, the
 * Recommended banner, and the Apple card) renders its attributes as larger,
 * COLORED pills instead of the old tiny grey text — one distinct hue per
 * attribute so a card's capabilities read at a glance:
 *   vision → violet · recommended → green · audio → amber · MTP → blue ·
 *   EAGLE-3 → teal · gated → neutral/locked · size & quant → neutral.
 * (MTP + EAGLE-3 are the speculative-decoding "fast" pills; both use the bolt.)
 * The pill chrome + per-hue colours live app-locally in `styles/global.css`
 * (`.pd-mm-pill*`) — deliberately NOT in @pi-desktop/ui (Wave B owns that) — and
 * are tuned for AA contrast in both light and dark modes.
 */
import type { ReactNode } from 'react';
import type { HfModelHitDTO } from '../../electron/ipc-contract';
import { IconBolt, IconEye, IconLock, IconSparkle, IconWaveform } from './icons';

/** The attribute a pill represents; drives its colour class + default glyph. */
export type ModelTagKind =
  | 'vision'
  | 'recommended'
  | 'audio'
  | 'mtp'
  | 'eagle3'
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
      return <IconBolt size={12} />;
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
