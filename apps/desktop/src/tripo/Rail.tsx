/**
 * Left tool rail — Image / Model / Segment(▾ Fill Parts) / Retopo /
 * Texture(▾ Edit · Upscale · PBR) / Animate. Matches the reference: caret
 * rows expand their sub-tools inline; the active tool gets the accent tint.
 */
import type { JSX, ReactNode } from 'react';
import {
  IcAnimate,
  IcCaretSmall,
  IcEditPen,
  IcFillParts,
  IcImage,
  IcPbr,
  IcRetopo,
  IcSegment,
  IcSparkles,
  IcTexture,
  IcUpscale,
} from './icons';
import { type TripoTool, useTripoStore } from './store';

interface RailEntry {
  readonly tool: TripoTool;
  readonly label: string;
  readonly icon: ReactNode;
  readonly badge?: string;
  readonly sub?: boolean;
}

function RailButton({
  entry,
  caret,
}: {
  readonly entry: RailEntry;
  readonly caret?: boolean;
}): JSX.Element {
  const active = useTripoStore((s) => s.tool) === entry.tool;
  const setTool = useTripoStore((s) => s.setTool);
  return (
    <button
      type="button"
      className={`tp-rail-item ${entry.sub === true ? 'tp-rail-sub' : ''}`}
      data-active={active}
      data-testid={`tp-rail-${entry.tool}`}
      onClick={() => setTool(entry.tool)}
    >
      <span className="tp-rail-icon">{entry.icon}</span>
      <span className="tp-rail-label">{entry.label}</span>
      {entry.badge !== undefined ? <span className="tp-rail-badge">{entry.badge}</span> : null}
      {caret === true ? (
        <span className="tp-rail-caret">
          <IcCaretSmall size={12} />
        </span>
      ) : null}
    </button>
  );
}

export function Rail(): JSX.Element {
  const segOpen = useTripoStore((s) => s.railSegmentOpen);
  const texOpen = useTripoStore((s) => s.railTextureOpen);

  return (
    <nav className="tp-rail" data-testid="tp-rail">
      <RailButton
        entry={{ tool: 'image', label: 'Image', icon: <IcImage size={19} />, badge: 'GPT Image 2' }}
      />
      <RailButton entry={{ tool: 'model', label: 'Model', icon: <IcSparkles size={19} /> }} />
      <div className="tp-rail-group" data-open={segOpen}>
        <RailButton
          entry={{ tool: 'segment', label: 'Segment', icon: <IcSegment size={19} /> }}
          caret
        />
        {segOpen ? (
          <RailButton
            entry={{
              tool: 'fillparts',
              label: 'Fill Parts',
              icon: <IcFillParts size={19} />,
              sub: true,
            }}
          />
        ) : null}
      </div>
      <RailButton entry={{ tool: 'retopo', label: 'Retopo', icon: <IcRetopo size={19} /> }} />
      <div className="tp-rail-group" data-open={texOpen}>
        <RailButton
          entry={{ tool: 'texture', label: 'Texture', icon: <IcTexture size={19} /> }}
          caret
        />
        {texOpen ? (
          <>
            <RailButton
              entry={{ tool: 'edit', label: 'Edit', icon: <IcEditPen size={19} />, sub: true }}
            />
            <RailButton
              entry={{
                tool: 'upscale',
                label: 'Upscale',
                icon: <IcUpscale size={19} />,
                sub: true,
              }}
            />
            <RailButton
              entry={{ tool: 'pbr', label: 'PBR', icon: <IcPbr size={19} />, sub: true }}
            />
          </>
        ) : null}
      </div>
      <RailButton entry={{ tool: 'animate', label: 'Animate', icon: <IcAnimate size={19} /> }} />
    </nav>
  );
}
