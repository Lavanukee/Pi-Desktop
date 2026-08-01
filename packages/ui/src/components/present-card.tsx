/**
 * The card `present` puts in the thread: here is the finished thing.
 *
 * Modelled on the reference jedd gave — an icon tile, the artefact's name, a
 * quiet `Kind · EXT` line under it, and the action on the right. The reference
 * is a DOWNLOAD list; ours is not, because the file is already on this machine.
 * The useful verbs here are OPEN (in the canvas, beside the conversation, where
 * a page renders and a game runs) and REVEAL (in Finder), so those are the
 * actions and Open is the primary one.
 *
 * One row per artefact, and the row itself is the open affordance — the same
 * shape as the web-search result rows, which is the pattern this app already
 * teaches people.
 */

import clsx from 'clsx';
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

/** What kind of thing was presented — drives the glyph and the `Kind · EXT` line. */
export type PresentKind = 'image' | 'page' | 'code' | 'document' | 'project' | 'media' | 'file';

export interface PresentedItem {
  /** Absolute path — the identity, and the tooltip. */
  path: string;
  /** Display name; defaults to the basename of `path`. */
  name?: string;
  kind: PresentKind;
  /** One line from the model about what this is. */
  note?: string;
  /** A thumbnail (data URI) when we have one — an image, a rendered page. */
  thumbnailUrl?: string;
}

const KIND_LABEL: Record<PresentKind, string> = {
  image: 'Image',
  page: 'Page',
  code: 'Code',
  document: 'Document',
  project: 'Project',
  media: 'Media',
  file: 'File',
};

/** basename without assuming a platform separator. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** `Document · MD` — the reference's second line, from our own metadata. */
export function kindLine(item: PresentedItem): string {
  const base = baseName(item.path);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toUpperCase() : '';
  const label = KIND_LABEL[item.kind];
  return ext === '' ? label : `${label} · ${ext}`;
}

/** Glyphs, one per kind. Inline so the card needs no icon dependency. */
function KindGlyph({ kind }: { kind: PresentKind }): ReactNode {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (kind) {
    case 'image':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="M21 16l-5-5-9 9" />
        </svg>
      );
    case 'page':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
        </svg>
      );
    case 'code':
      return (
        <svg {...common}>
          <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
        </svg>
      );
    case 'project':
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        </svg>
      );
    case 'media':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M10 9.5l5 2.5-5 2.5z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
          <path d="M14 3v5h5" />
        </svg>
      );
  }
}

export interface PresentCardProps extends Omit<HTMLAttributes<HTMLElement>, 'onSelect'> {
  item: PresentedItem;
  /** Open it in the canvas beside the conversation. The row's own action. */
  onOpen?: (item: PresentedItem) => void;
  /** Show it in Finder. Secondary. */
  onReveal?: (item: PresentedItem) => void;
}

/**
 * One presented artefact.
 *
 * The whole row is the Open affordance so the target is large and obvious;
 * Reveal is a separate, quieter button beside it. `title` carries the full path,
 * because the name alone is not enough to know WHICH file this is.
 */
export const PresentCard = forwardRef<HTMLDivElement, PresentCardProps>(function PresentCard(
  { item, onOpen, onReveal, className, ...rest },
  ref,
) {
  const name = item.name ?? baseName(item.path);
  return (
    <div ref={ref} className={clsx('pd-present-card', className)} {...rest}>
      <button
        type="button"
        className="pd-present-main pd-focusable"
        title={item.path}
        onClick={onOpen === undefined ? undefined : () => onOpen(item)}
      >
        <span className="pd-present-thumb" aria-hidden>
          {item.thumbnailUrl !== undefined ? (
            <img className="pd-present-thumb-img" src={item.thumbnailUrl} alt="" />
          ) : (
            <KindGlyph kind={item.kind} />
          )}
        </span>
        <span className="pd-present-text">
          <span className="pd-present-name">{name}</span>
          {/*
           * The note shares the meta LINE rather than adding a third one. With
           * it stacked, a list of four artefacts rendered at three different
           * heights and read as ragged — the reference is uniform, and uniform
           * is what makes a list scannable. Two lines, always.
           */}
          <span className="pd-present-meta">
            {kindLine(item)}
            {item.note !== undefined && item.note !== '' ? (
              <span className="pd-present-note"> · {item.note}</span>
            ) : null}
          </span>
        </span>
      </button>
      <div className="pd-present-actions">
        {onReveal !== undefined ? (
          <button
            type="button"
            className="pd-present-action pd-focusable"
            onClick={() => onReveal(item)}
          >
            Reveal
          </button>
        ) : null}
        {onOpen !== undefined ? (
          <button
            type="button"
            className="pd-present-action pd-present-action--primary pd-focusable"
            onClick={() => onOpen(item)}
          >
            Open
          </button>
        ) : null}
      </div>
    </div>
  );
});
