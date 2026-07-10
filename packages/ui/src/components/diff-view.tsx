import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { DiffStat } from './activity.tsx';

/*
 * Diff view — spec-diff-view.md. ONE renderer with the codex variable API:
 * flavors only supply the 6 knobs (surface, fg, added/deleted/modified hues)
 * via --pd-* tokens; the row-tint color-mix math lives in diff.css.
 * CLAUDE flavor composition is DERIVED (no source diff UI, _gaps.md §5);
 * its token values are HIGH (own status ramps + code-block chrome).
 */

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffFileData {
  path: string;
  added?: number;
  deleted?: number;
  lines: DiffLine[];
}

export interface DiffViewProps extends HTMLAttributes<HTMLDivElement> {
  files: DiffFileData[];
  /** Leading +/− markers inside the text column. */
  showMarkers?: boolean;
}

const ROW_CLASS: Record<Exclude<DiffLineKind, 'hunk'>, string> = {
  add: 'pd-diff-row pd-diff-row--add',
  del: 'pd-diff-row pd-diff-row--del',
  context: 'pd-diff-row pd-diff-row--context',
};

const MARKERS: Record<Exclude<DiffLineKind, 'hunk'>, string> = {
  add: '+',
  del: '−',
  context: ' ',
};

export const DiffView = forwardRef<HTMLDivElement, DiffViewProps>(function DiffView(
  { files, showMarkers = true, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={clsx('pd-diff', className)} {...rest}>
      {files.map((file) => {
        let rowIndex = 0;
        return (
          <section key={file.path}>
            <header className="pd-diff-file-header">
              <span>{file.path}</span>
              <DiffStat added={file.added} deleted={file.deleted} />
            </header>
            <div className="pd-diff-body">
              {file.lines.map((line) => {
                rowIndex += 1;
                const key = `${file.path}#${rowIndex}`;
                if (line.kind === 'hunk') {
                  return (
                    <div key={key} className="pd-diff-row pd-diff-row--hunk">
                      {line.text}
                    </div>
                  );
                }
                return (
                  <div key={key} className={ROW_CLASS[line.kind]}>
                    <span
                      className="pd-diff-gutter"
                      data-line-number={line.newNumber ?? line.oldNumber ?? ''}
                    />
                    <span className="pd-diff-text">
                      {showMarkers ? (
                        <span className="pd-diff-marker">{MARKERS[line.kind]}</span>
                      ) : null}
                      {line.text}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
});
