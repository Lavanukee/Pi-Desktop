import { clsx } from 'clsx';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { forwardRef, useState } from 'react';
import { IconChevronDown } from './icons.tsx';
import { ShimmerText } from './shimmer.tsx';
import { Spinner } from './spinner.tsx';

/*
 * Tool-call rows — spec-tool-call-row.md. Built on the codex structure (the
 * fully-evidenced flavor, ●●● runtime+css). The CLAUDE flavor re-skin is a
 * RECONSTRUCTION from adjacent collapsible/code-block CSS (●○○, _gaps.md §5)
 * — verify against live claude.ai tool UI before pixel-polish.
 */

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Rolling-digit counter (codex diffstat; kept for both flavors). */
export function RollingNumber({ value }: { value: number }) {
  const text = String(Math.max(0, Math.floor(value)));
  const cells = text.split('').map((digit, index) => ({
    digit,
    place: text.length - index,
  }));
  return (
    <span className="pd-rolling-number">
      <span className="pd-visually-hidden">{text}</span>
      {cells.map((cell) => (
        <span key={cell.place} className="pd-rolling-digit" aria-hidden="true">
          <span
            className="pd-rolling-digit-stack"
            style={{ '--pd-roll': cell.digit } as CSSProperties}
          >
            {DIGITS.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}

export interface DiffStatProps extends HTMLAttributes<HTMLSpanElement> {
  added?: number;
  deleted?: number;
  /** Animate digits with the rolling columns. */
  rolling?: boolean;
}

/**
 * "+N −M" change counts. Zero (and undefined) sides are OMITTED (jedd round-5
 * #12): renders "+27", "−5", or "+27 −5" — never "+0"/"−0". Nothing at all when
 * both sides are zero/absent, so it drops cleanly into a step label.
 */
export const DiffStat = forwardRef<HTMLSpanElement, DiffStatProps>(function DiffStat(
  { added, deleted, rolling = false, className, ...rest },
  ref,
) {
  const showAdded = typeof added === 'number' && added > 0;
  const showDeleted = typeof deleted === 'number' && deleted > 0;
  if (!showAdded && !showDeleted) return null;
  return (
    <span
      ref={ref}
      className={clsx('pd-diff-stat', className)}
      style={{ display: 'inline-flex', gap: 6 }}
      {...rest}
    >
      {showAdded ? (
        <span className="pd-diff-count pd-diff-count--added">
          +{rolling ? <RollingNumber value={added} /> : added}
        </span>
      ) : null}
      {showDeleted ? (
        <span className="pd-diff-count pd-diff-count--deleted">
          −{rolling ? <RollingNumber value={deleted} /> : deleted}
        </span>
      ) : null}
    </span>
  );
});

export interface ActivityRowProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: ReactNode;
  label: ReactNode;
  /** Shimmer the label + spinner while the tool call runs. */
  running?: boolean;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Per-file / per-call rows inserted in place when expanded. */
  children?: ReactNode;
}

/** Inline activity row ("Edited a file") with click-to-expand detail. */
export const ActivityRow = forwardRef<HTMLButtonElement, ActivityRowProps>(function ActivityRow(
  {
    icon,
    label,
    running = false,
    expanded,
    defaultExpanded = false,
    onExpandedChange,
    children,
    className,
    ...rest
  },
  ref,
) {
  const [internal, setInternal] = useState(defaultExpanded);
  const isExpanded = expanded ?? internal;
  const toggle = () => {
    const next = !isExpanded;
    if (expanded === undefined) setInternal(next);
    onExpandedChange?.(next);
  };
  return (
    <div>
      <button
        ref={ref}
        type="button"
        className={clsx('pd-activity-row pd-focusable', className)}
        aria-expanded={isExpanded}
        onClick={toggle}
        {...rest}
      >
        <span className="pd-activity-row-icon">{running ? <Spinner size={13} /> : icon}</span>
        {running ? <ShimmerText>{label}</ShimmerText> : <span>{label}</span>}
        <span className="pd-activity-row-chevron">
          <IconChevronDown size={12} />
        </span>
      </button>
      {isExpanded && children !== undefined ? (
        <div className="pd-activity-detail">{children}</div>
      ) : null}
    </div>
  );
});

export interface ActivityFile {
  path: string;
  added?: number;
  deleted?: number;
}

export interface ActivityGroupCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  added?: number;
  deleted?: number;
  /** Codex hover swap: subtitle becomes this on header hover ("Review changes"). */
  hoverSubtitle?: ReactNode;
  /** Header trailing actions (Undo / Review buttons). */
  actions?: ReactNode;
  files?: ActivityFile[];
  /** Rows shown before the "Show N more" expander. */
  visibleFiles?: number;
  onFileClick?: (path: string) => void;
  onHeaderClick?: () => void;
}

function splitPath(path: string): { prefix: string; name: string } {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return { prefix: '', name: path };
  return { prefix: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/**
 * Grouped turn-diff card: header + 36px file rows with right-aligned ±counts
 * (flavor-neutral grid; colors/radius/hover from tokens). Children slot hosts
 * a DiffView body.
 */
export const ActivityGroupCard = forwardRef<HTMLDivElement, ActivityGroupCardProps>(
  function ActivityGroupCard(
    {
      icon,
      title,
      added,
      deleted,
      hoverSubtitle,
      actions,
      files,
      visibleFiles = 5,
      onFileClick,
      onHeaderClick,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const [showAll, setShowAll] = useState(false);
    const shown = files === undefined || showAll ? files : files.slice(0, visibleFiles);
    const hidden = (files?.length ?? 0) - (shown?.length ?? 0);
    return (
      <div ref={ref} className={clsx('pd-activity-card', className)} {...rest}>
        <button type="button" className="pd-activity-card-header" onClick={onHeaderClick}>
          {icon !== undefined ? <span className="pd-activity-icon-tile">{icon}</span> : null}
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span className="pd-activity-title">{title}</span>
            <span className="pd-activity-subtitle">
              <span className="pd-activity-subtitle--default">
                <DiffStat added={added} deleted={deleted} />
              </span>
              {hoverSubtitle !== undefined ? (
                <span className="pd-activity-subtitle--hover">{hoverSubtitle}</span>
              ) : null}
            </span>
          </span>
          <span className="pd-activity-spacer" />
          {actions}
        </button>
        {shown?.map((file) => {
          const { prefix, name } = splitPath(file.path);
          return (
            <button
              key={file.path}
              type="button"
              className="pd-activity-file-row"
              onClick={() => onFileClick?.(file.path)}
            >
              <span className="pd-activity-path">
                <span className="pd-activity-path-prefix">{prefix}</span>
                {name}
              </span>
              <span className="pd-activity-spacer" />
              <DiffStat added={file.added} deleted={file.deleted} />
            </button>
          );
        })}
        {hidden > 0 ? (
          <button
            type="button"
            className="pd-activity-file-row pd-activity-expander"
            onClick={() => setShowAll(true)}
          >
            Show {hidden} more {hidden === 1 ? 'file' : 'files'}
            <IconChevronDown size={12} />
          </button>
        ) : null}
        {children}
      </div>
    );
  },
);
