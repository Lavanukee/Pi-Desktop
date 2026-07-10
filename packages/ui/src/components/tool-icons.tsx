import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import {
  IconClock,
  IconCompass,
  IconCursor,
  IconExternal,
  IconEye,
  IconFile,
  IconGlobe,
  IconKeyboard,
  IconPencil,
  IconSparkles,
  IconTerminal,
} from './icons.tsx';

/*
 * Individualized tool-step icons (THEME 3 / spec-tool-call-row). Claude's
 * signature is a per-tool glyph plus, for file steps, a small file-extension
 * badge tucked under a generic file sheet ("PY", "PNG", …). One helper —
 * toolIcon(kind, filename?) — picks the glyph so the chain, the app, and the
 * canvas all read files the same way.
 */

/** The kinds a tool/thinking step can be. Mirrors ActivityStepKind. */
export type ToolIconKind =
  | 'thinking'
  | 'bash'
  | 'edit'
  | 'read'
  | 'search'
  | 'file'
  // A SKILL / tool-instructions read (a SKILL.md under the pi skills dir):
  // reads distinctly as "Read a skill" with its own sparkle glyph — NOT the
  // generic file sheet — because its content is instructions, not a plain file.
  | 'skill'
  | 'image'
  | 'pdf'
  | 'canvas-open'
  // Browser-action steps (round-10 #17): each carries its own glyph.
  | 'browser-navigate'
  | 'browser-click'
  | 'browser-type'
  | 'browser-read';

/** Extract a short (<=4 char) uppercase extension from a filename/path. */
export function fileExt(filename: string | undefined): string {
  if (!filename) return '';
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base
    .slice(dot + 1)
    .slice(0, 4)
    .toUpperCase();
}

export interface FileExtIconProps extends HTMLAttributes<HTMLSpanElement> {
  /** Extension text (with or without leading dot); shown as an uppercase badge. */
  ext?: string;
  /** Glyph diameter in px. */
  size?: number;
}

/**
 * Generic file sheet with an extension badge (`FileExtIcon ext="py"`). The
 * badge sits on the sheet's lower edge, tabular and clipped to <=4 chars.
 */
export const FileExtIcon = forwardRef<HTMLSpanElement, FileExtIconProps>(function FileExtIcon(
  { ext, size = 20, className, style, ...rest },
  ref,
) {
  const label = (ext ?? '').replace(/^\./, '').slice(0, 4).toUpperCase();
  return (
    <span
      ref={ref}
      className={clsx('pd-file-ext-icon', className)}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
      {...rest}
    >
      <IconFile size={size} />
      {label ? <span className="pd-file-ext-badge">{label}</span> : null}
    </span>
  );
});

/**
 * Pick a step glyph by kind (+ filename for the ext badge). Media kinds
 * (image/pdf) and file kinds carry the badge; the rest get a bare glyph.
 */
export function toolIcon(kind: ToolIconKind, filename?: string, size = 16): ReactNode {
  switch (kind) {
    case 'thinking':
      return <IconClock size={size} />;
    case 'bash':
      return <IconTerminal size={size} />;
    case 'search':
      return <IconGlobe size={size} />;
    case 'skill':
      // The sparkle is the app's established "skills" mark (the add-menu Skills
      // entry uses it), so a skill read reads as a skill everywhere.
      return <IconSparkles size={size} />;
    case 'browser-navigate':
      return <IconCompass size={size} />;
    case 'browser-click':
      return <IconCursor size={size} />;
    case 'browser-type':
      return <IconKeyboard size={size} />;
    case 'browser-read':
      return <IconEye size={size} />;
    case 'canvas-open':
      return <IconExternal size={size} />;
    case 'edit':
      return filename ? (
        <FileExtIcon ext={fileExt(filename)} size={size + 4} />
      ) : (
        <IconPencil size={size} />
      );
    case 'read':
    case 'file':
      return filename ? (
        <FileExtIcon ext={fileExt(filename)} size={size + 4} />
      ) : (
        <IconFile size={size} />
      );
    case 'image':
      return <FileExtIcon ext={fileExt(filename) || 'PNG'} size={size + 4} />;
    case 'pdf':
      return <FileExtIcon ext={fileExt(filename) || 'PDF'} size={size + 4} />;
    default:
      return <IconFile size={size} />;
  }
}

export interface ToolIconProps {
  kind: ToolIconKind;
  filename?: string;
  size?: number;
}

/** Component wrapper around {@link toolIcon} for JSX ergonomics. */
export function ToolIcon({ kind, filename, size }: ToolIconProps) {
  return <>{toolIcon(kind, filename, size)}</>;
}
