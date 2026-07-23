/**
 * Left tool rail — one flat, uniformly-aligned button per functional pipeline
 * section: Image / Model / Segment / Retopo / Texture / Animate. No sub-tool
 * inset groups (they read as misaligned buttons) and no product badges.
 */
import type { JSX, ReactNode } from 'react';
import { IcAnimate, IcImage, IcRetopo, IcSegment, IcSparkles, IcTexture } from './icons';
import { type TripoTool, useTripoStore } from './store';

const ENTRIES: readonly { tool: TripoTool; label: string; icon: ReactNode }[] = [
  { tool: 'image', label: 'Image', icon: <IcImage size={19} /> },
  { tool: 'model', label: 'Model', icon: <IcSparkles size={19} /> },
  { tool: 'segment', label: 'Segment', icon: <IcSegment size={19} /> },
  { tool: 'retopo', label: 'Retopo', icon: <IcRetopo size={19} /> },
  { tool: 'texture', label: 'Texture', icon: <IcTexture size={19} /> },
  { tool: 'animate', label: 'Animate', icon: <IcAnimate size={19} /> },
];

export function Rail(): JSX.Element {
  const tool = useTripoStore((s) => s.tool);
  const setTool = useTripoStore((s) => s.setTool);

  return (
    <nav className="tp-rail" data-testid="tp-rail">
      {ENTRIES.map((e) => (
        <button
          key={e.tool}
          type="button"
          className="tp-rail-item"
          data-active={tool === e.tool}
          data-testid={`tp-rail-${e.tool}`}
          onClick={() => setTool(e.tool)}
        >
          <span className="tp-rail-icon">{e.icon}</span>
          <span className="tp-rail-label">{e.label}</span>
        </button>
      ))}
    </nav>
  );
}
