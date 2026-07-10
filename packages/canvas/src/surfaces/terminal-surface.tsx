import { IconTerminal } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { type ContentSlotOptions, useContentSlot } from './content-slot.ts';

export interface TerminalSurfaceProps extends ContentSlotOptions {
  title?: string;
  /**
   * Static scrollback shown when the app hasn't mounted a live terminal — handy
   * for demos/tests. Ignored once the app fills the slot with xterm.
   */
  children?: ReactNode;
  className?: string;
}

/**
 * TerminalSurface — the CHROME + scrollback CONTENT SLOT for a terminal tab. The
 * app mounts an xterm.js instance (backed by a PTY) into the slot element via
 * `onMount(el)` and detaches on `onMount(null)`; `onRectChange` is provided for
 * the same reasons as BrowserSurface should the app prefer a native overlay.
 */
export function TerminalSurface({
  title = 'Terminal',
  onMount,
  onRectChange,
  children,
  className,
}: TerminalSurfaceProps) {
  const slotRef = useContentSlot({ onMount, onRectChange });
  const rootClass = ['pd-terminal', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      <div className="pd-terminal-header">
        <IconTerminal size={14} />
        <span className="pd-terminal-title">{title}</span>
      </div>
      <div ref={slotRef} className="pd-terminal-scroll pd-scroll" data-native-slot="terminal">
        {children}
      </div>
    </div>
  );
}
