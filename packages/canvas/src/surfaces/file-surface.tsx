import type { ReactNode } from 'react';
import type { ArtifactContent } from '../model.ts';
import { CodeSurface } from './code-surface.tsx';
import { MarkdownSurface } from './markdown-surface.tsx';

export interface FileSurfaceProps {
  content: ArtifactContent;
  filename?: string;
  streaming?: boolean;
  onCopy?: (text: string) => void;
  /** Slot for future inline editing UI (overlaid below the viewer). */
  children?: ReactNode;
  className?: string;
}

/**
 * FileSurface — a file viewer that reuses the existing renderers: markdown files
 * render as Prose, everything else as the read-only CodeMirror viewer. The
 * `children` slot is reserved for the editing affordances a later phase adds.
 */
export function FileSurface({
  content,
  filename,
  streaming = false,
  onCopy,
  children,
  className,
}: FileSurfaceProps) {
  const rootClass = ['pd-file', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      {filename ? <div className="pd-file-name">{filename}</div> : null}
      <div className="pd-file-body">
        {content.kind === 'markdown' ? (
          <MarkdownSurface content={content} streaming={streaming} onCopy={onCopy} />
        ) : (
          <CodeSurface content={content} streaming={streaming} onCopy={onCopy} />
        )}
      </div>
      {children}
    </div>
  );
}
