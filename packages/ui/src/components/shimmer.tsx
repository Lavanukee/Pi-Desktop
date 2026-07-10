import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef, useState } from 'react';
import { IconChevronRight } from './icons.tsx';
import { Markdown } from './markdown.tsx';

export interface ShimmerTextProps extends HTMLAttributes<HTMLSpanElement> {
  /** Set false to render resting text without the sweep. */
  active?: boolean;
}

/**
 * The flavor-split thinking shimmer (spec-thinking-block: THE flavor split).
 * Gradient-clipped text driven entirely by --pd-shimmer-* tokens: claude
 * sweeps smoothly (2.25s ease-in-out), codex quantizes at steps(48, end).
 * Hover un-shimmers (codex nicety, flavor-neutral); reduced-motion disables.
 */
export const ShimmerText = forwardRef<HTMLSpanElement, ShimmerTextProps>(function ShimmerText(
  { active = true, className, ...rest },
  ref,
) {
  return <span ref={ref} className={clsx(active && 'pd-shimmer', className)} {...rest} />;
});

/** Char count past which a single thought gets the long treatment (fade + show-more). */
export const LONG_THINKING_THRESHOLD = 280;

/** True when a single thought is long enough to warrant fade + show-more chrome. */
export function isLongThought(
  text: string | undefined,
  threshold = LONG_THINKING_THRESHOLD,
): boolean {
  return typeof text === 'string' && text.trim().length > threshold;
}

function formatThinkingDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Thinking label: present tense while running ("Thinking…"), past tense on
 * completion ("Thought for 12s" / "Thought"). THEME 3 past-tense-on-done.
 */
export function thinkingLabel(status: 'running' | 'done', durationMs?: number): string {
  if (status === 'running') return 'Thinking…';
  if (durationMs !== undefined) return `Thought for ${formatThinkingDuration(durationMs)}`;
  return 'Thought';
}

export interface ThinkingBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Header label; defaults to the past-tense-on-done label from status/durationMs. */
  label?: ReactNode;
  /** Running shimmers the label; done flips it to past tense. */
  status?: 'running' | 'done';
  /** Deprecated alias for status==='running'. */
  streaming?: boolean;
  durationMs?: number;
  /** Force the long treatment; otherwise auto-detected from string children length. */
  long?: boolean;
  /** Char threshold for auto long-detection. */
  threshold?: number;
  /** Hide the header/pill entirely (brief inline thoughts render as bare dim text). */
  hideLabel?: boolean;
  /**
   * Controlled dropdown expansion (collapsed "Thought for X" pill <-> open
   * content). DEFAULTS TO COLLAPSED (jedd round-5 #3) — the standalone thought
   * no longer auto-expands; a caller that wants it open (e.g. in-chain) passes
   * `defaultExpanded`/`expanded`.
   */
  expanded?: boolean;
  defaultExpanded?: boolean;
  /**
   * Streaming/live: while true the block is FORCE-EXPANDED with its content
   * un-clamped (watch it generate); the moment it flips false the block collapses
   * back to the "Thought for X" pill. Overrides `defaultExpanded`/user toggles.
   */
  active?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Thought content (usually a string). */
  children?: ReactNode;
}

/**
 * Reasoning block (jedd round-5 #3 rework). A standalone thought defaults to a
 * COLLAPSED pill reading "Thought for <time>"; clicking rolls it open like any
 * dropdown (smooth height roll). Once open, a LONG thought clamps with a bottom
 * fade + a small "Show more" below the fade (never a scrollbar). Brief thoughts
 * open to plain dim text. Labels flip to past tense on completion.
 */
export const ThinkingBlock = forwardRef<HTMLDivElement, ThinkingBlockProps>(function ThinkingBlock(
  {
    label,
    status,
    streaming = false,
    durationMs,
    long,
    threshold,
    hideLabel = false,
    expanded,
    defaultExpanded = false,
    active = false,
    onExpandedChange,
    children,
    className,
    ...rest
  },
  ref,
) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  // While streaming (active), force open; when the thought ends it falls back to
  // internalExpanded (collapsed by default) → it collapses to the pill.
  const isExpanded = expanded ?? (active ? true : internalExpanded);
  const [showMore, setShowMore] = useState(false);
  const toggleExpanded = () => {
    // No manual toggle while streaming — a live thought stays open until done.
    if (active) return;
    const next = !isExpanded;
    if (expanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  };

  const resolvedStatus: 'running' | 'done' = status ?? (streaming ? 'running' : 'done');
  const running = resolvedStatus === 'running';
  const headerLabel = label ?? thinkingLabel(resolvedStatus, durationMs);

  const isLong = long ?? (typeof children === 'string' && isLongThought(children, threshold));

  const well =
    children === undefined ? null : (
      // While live, show it all (showMore forced) so the newest tokens stay visible.
      <ThoughtWell
        long={isLong}
        showMore={showMore || active}
        live={active}
        onShowMore={() => setShowMore((v) => !v)}
      >
        {children}
      </ThoughtWell>
    );

  // hideLabel: no pill to toggle — render the thought as bare dim text (still
  // fades + shows-more when long). Used for brief thoughts nested inline in prose.
  if (hideLabel) {
    return (
      <div ref={ref} className={clsx('pd-thinking', 'pd-thinking--bare', className)} {...rest}>
        {well}
      </div>
    );
  }

  return (
    <div ref={ref} className={clsx('pd-thinking', className)} data-expanded={isExpanded} {...rest}>
      <button
        type="button"
        className="pd-thinking-pill pd-focusable"
        aria-expanded={isExpanded}
        onClick={toggleExpanded}
      >
        <span className="pd-thinking-pill-label">
          {running ? <ShimmerText>{headerLabel}</ShimmerText> : headerLabel}
        </span>
        {children !== undefined ? (
          <span className="pd-thinking-pill-chevron" data-expanded={isExpanded}>
            <IconChevronRight size={12} />
          </span>
        ) : null}
      </button>
      {children !== undefined ? (
        <div className="pd-thinking-reveal" data-open={isExpanded}>
          <div className="pd-thinking-reveal-inner">{well}</div>
        </div>
      ) : null}
    </div>
  );
});

interface ThoughtWellProps {
  long: boolean;
  showMore: boolean;
  /** Streaming live — hide the Show-more affordance (the full thought is shown). */
  live?: boolean;
  onShowMore: () => void;
  children: ReactNode;
}

/**
 * The thought body: dim reasoning prose. When long and not yet expanded it
 * clamps with a bottom fade and offers a small "Show more" below the fade
 * (never a scrollbar) — the round-5 #4 affordance shared with in-chain thoughts.
 *
 * jedd round-8 #9: a string thought is rendered through the shared {@link Markdown}
 * component (markdown + KaTeX + syntax-highlight + hex swatches — the same pipeline
 * as responses), so thoughts get **bold**, code, lists and $math$. Non-string
 * children (a caller passing its own JSX) fall back to rendering as-is. The dim
 * "secondary" voice is preserved by `.pd-thinking-content` (see shimmer.css).
 */
function ThoughtWell({ long, showMore, live = false, onShowMore, children }: ThoughtWellProps) {
  const isMarkdown = typeof children === 'string';
  return (
    <div className="pd-thinking-well">
      <div
        className="pd-thinking-content"
        data-clamped={long && !showMore}
        data-md={isMarkdown || undefined}
      >
        {isMarkdown ? <Markdown className="pd-thinking-md">{children}</Markdown> : children}
      </div>
      {long && !live ? (
        <button
          type="button"
          className="pd-showmore pd-focusable"
          aria-expanded={showMore}
          onClick={onShowMore}
        >
          {showMore ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
