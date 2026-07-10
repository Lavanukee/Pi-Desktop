import {
  ArtifactPanel,
  type ArtifactPanelState,
  IconArrowUp,
  IconButton,
  IconCopy,
  IconFile,
  IconSidebar,
  IconTerminal,
} from '@pi-desktop/ui';
import { type ReactNode, useMemo, useState } from 'react';
import { type CanvasConfig, CanvasConfigContext, defaultCanvasConfig } from './context.ts';
import { downloadArtifact } from './export-artifact.ts';
import type { Artifact, ArtifactContent } from './model.ts';
import { defaultSurfaceRegistry, type SurfaceRegistry } from './registry.ts';
import { CodeSurface, rawSourceContent } from './surfaces/code-surface.tsx';
import { ensureDefaultSurfaces } from './surfaces/register-builtins.tsx';

export type CanvasPlacement = 'inline' | 'side';

export interface CanvasProps {
  artifact: Artifact;
  /** Content is still streaming in (drives progressive surface behavior). */
  streaming?: boolean;
  /** Inline in the thread, or docked as a side canvas. Live-swappable. */
  placement?: CanvasPlacement;
  /** Registry to resolve against; defaults to the process-wide one. */
  registry?: SurfaceRegistry;
  /** Override the HTML surface harness URL (else `pd-preview://`). */
  harnessUrl?: string;
  /** Copy handler; defaults to the clipboard. */
  onCopy?: (text: string) => void;
  /** Export handler; defaults to a file download. */
  onExport?: (content: ArtifactContent) => void;
  /**
   * Pop-out affordance. The package only EMITS the intent — the app opens a
   * separate window. Omit to hide the button.
   */
  onPopOut?: (artifact: Artifact) => void;
  /** Inline↔side toggle. The app owns placement; omit to hide the button. */
  onPlacementChange?: (placement: CanvasPlacement) => void;
  className?: string;
}

/**
 * Canvas — ties `resolveSurface` to the shared `ArtifactPanel` chrome. Provides
 * the raw-code toggle, copy/export, inline↔side placement and pop-out
 * affordances (as host-handled events), and the harness URL to the HTML surface.
 * All motion belongs to the panel/surfaces, which are already reduced-motion
 * safe; Canvas adds none.
 */
export function Canvas({
  artifact,
  streaming = false,
  placement = 'inline',
  registry,
  harnessUrl,
  onCopy,
  onExport,
  onPopOut,
  onPlacementChange,
  className,
}: CanvasProps) {
  const [showRaw, setShowRaw] = useState(false);
  // Zero-config: the built-ins self-register on the default registry (idempotent)
  // so <Canvas> works without the app wiring registration first.
  if (!registry) ensureDefaultSurfaces();
  const activeRegistry = registry ?? defaultSurfaceRegistry;
  const resolved = activeRegistry.resolve(artifact);

  const config = useMemo<CanvasConfig>(
    () => ({ harnessUrl: harnessUrl ?? defaultCanvasConfig.harnessUrl }),
    [harnessUrl],
  );

  const copyText = (text: string): void => {
    if (onCopy) onCopy(text);
    else void navigator.clipboard?.writeText(text);
  };
  const exportContent = (content: ArtifactContent): void => {
    if (onExport) onExport(content);
    else downloadArtifact(artifact);
  };

  const title = artifact.title ?? artifact.filename ?? artifact.content.kind;
  const state: ArtifactPanelState = resolved ? 'ready' : 'error';

  const controls: ReactNode = (
    <>
      <IconButton
        size="sm"
        aria-label={showRaw ? 'Show preview' : 'Show source'}
        aria-pressed={showRaw}
        onClick={() => setShowRaw((value) => !value)}
      >
        <IconTerminal size={16} />
      </IconButton>
      <IconButton size="sm" aria-label="Copy" onClick={() => copyText(artifact.content.text)}>
        <IconCopy size={16} />
      </IconButton>
      <IconButton size="sm" aria-label="Export" onClick={() => exportContent(artifact.content)}>
        <IconFile size={16} />
      </IconButton>
      {onPlacementChange ? (
        <IconButton
          size="sm"
          aria-label={placement === 'inline' ? 'Move to side panel' : 'Show inline'}
          onClick={() => onPlacementChange(placement === 'inline' ? 'side' : 'inline')}
        >
          <IconSidebar size={16} />
        </IconButton>
      ) : null}
      {onPopOut ? (
        <IconButton size="sm" aria-label="Open in new window" onClick={() => onPopOut(artifact)}>
          <IconArrowUp size={16} />
        </IconButton>
      ) : null}
    </>
  );

  let body: ReactNode = null;
  if (resolved) {
    if (showRaw) {
      // Shared raw source editor — identical to the docked canvas's raw view.
      body = (
        <div className="pd-canvas-raw pd-scroll">
          <CodeSurface
            content={rawSourceContent(artifact.content)}
            streaming={streaming}
            onCopy={copyText}
          />
        </div>
      );
    } else {
      const Surface = resolved.component;
      body = (
        <Surface
          content={artifact.content}
          streaming={streaming}
          onCopy={copyText}
          onExport={exportContent}
        />
      );
    }
  }

  const rootClass = ['pd-canvas', `pd-canvas--${placement}`, className]
    .filter((value): value is string => Boolean(value))
    .join(' ');

  return (
    <CanvasConfigContext.Provider value={config}>
      <ArtifactPanel
        className={rootClass}
        data-placement={placement}
        title={title}
        byline="Content is generated and may be inaccurate"
        controls={controls}
        state={state}
        errorMessage={`No canvas surface is registered for “${artifact.content.kind}”.`}
      >
        {body}
      </ArtifactPanel>
    </CanvasConfigContext.Provider>
  );
}
