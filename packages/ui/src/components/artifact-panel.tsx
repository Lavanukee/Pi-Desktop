import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { Spinner } from './spinner.tsx';

export type ArtifactPanelState = 'loading' | 'ready' | 'error';

export interface ArtifactPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  /** Trust byline ("Content is user-generated…"), 12px muted, ellipsized. */
  byline?: ReactNode;
  /** 24px logo chip with hairline ring. */
  logo?: ReactNode;
  /** Header right cluster. */
  controls?: ReactNode;
  state?: ArtifactPanelState;
  errorMessage?: ReactNode;
}

/**
 * Artifact / canvas panel chrome — spec-artifact-panel.md, built on claude's
 * frame-shell template (●●● self-contained source): 36px header, floating
 * content pane with top-only radius + hairline/soft shadow, skeleton header
 * while loading, centered error grid. Codex flavor = token re-skin (its analog
 * panels are MED evidence). Children = the hosted content (iframe/pane).
 */
export const ArtifactPanel = forwardRef<HTMLDivElement, ArtifactPanelProps>(function ArtifactPanel(
  { title, byline, logo, controls, state = 'ready', errorMessage, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(
        'pd-artifact',
        state === 'loading' && 'pd-artifact--loading',
        state === 'error' && 'pd-artifact--error',
        className,
      )}
      {...rest}
    >
      {state === 'error' ? null : (
        <div className="pd-artifact-header">
          {state === 'loading' ? (
            <>
              <span className="pd-skeleton pd-skeleton--logo" />
              <span className="pd-skeleton pd-skeleton--title" />
            </>
          ) : (
            <>
              {logo !== undefined ? <span className="pd-artifact-logo">{logo}</span> : null}
              {title !== undefined ? <span className="pd-artifact-title">{title}</span> : null}
              {byline !== undefined ? <span className="pd-artifact-byline">{byline}</span> : null}
            </>
          )}
          {controls !== undefined ? <span className="pd-artifact-controls">{controls}</span> : null}
        </div>
      )}
      <div className="pd-artifact-content">
        {children}
        {state === 'loading' ? (
          <div className="pd-artifact-status">
            <Spinner size={24} />
          </div>
        ) : null}
        {state === 'error' ? (
          <div className="pd-artifact-status">
            {errorMessage ?? 'Something went wrong loading this content.'}
          </div>
        ) : null}
      </div>
    </div>
  );
});
