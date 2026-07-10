import type { Story } from '@ladle/react';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import {
  FileExtIcon,
  IconArrowUp,
  IconChat,
  IconCheck,
  IconClock,
  IconConnector,
  IconCopy,
  IconExternal,
  IconFile,
  IconFolderPlus,
  IconGauge,
  IconGlobe,
  IconImage,
  IconInfo,
  IconMic,
  IconPencil,
  IconPuzzle,
  IconRefresh,
  IconSearch,
  IconShare,
  IconSidebar,
  IconSparkles,
  IconStrokeControl,
  IconTerminal,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

/** The stroked glyphs, shown as a repeatable set at each stroke weight. */
const ICON_SET = [
  IconChat,
  IconSearch,
  IconPencil,
  IconFile,
  IconFolderPlus,
  IconTerminal,
  IconGlobe,
  IconSparkles,
  IconConnector,
  IconPuzzle,
  IconClock,
  IconGauge,
  IconRefresh,
  IconShare,
  IconExternal,
  IconMic,
  IconImage,
  IconInfo,
  IconSidebar,
  IconArrowUp,
  IconCopy,
  IconCheck,
];

const STROKES = [1.0, 1.5, 2.0, 2.5];

function IconGrid({ stroke }: { stroke: number }) {
  return (
    <div
      style={
        {
          '--pd-icon-stroke': stroke,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 18,
          alignItems: 'center',
          color: 'var(--pd-text-secondary)',
        } as CSSProperties
      }
    >
      {ICON_SET.map((Glyph) => (
        <Glyph key={Glyph.name} size={22} />
      ))}
    </div>
  );
}

/** The same icon set rendered at stroke 1.0 / 1.5 / 2.0 / 2.5. */
export const StrokeWeights: Story = () => (
  <Frame>
    {STROKES.map((stroke) => (
      <Row key={stroke} label={`--pd-icon-stroke: ${stroke.toFixed(1)}`}>
        <IconGrid stroke={stroke} />
      </Row>
    ))}
  </Frame>
);

/** File-extension badge icons (round-5 #7): the ext chip sits ON the sheet's
 * lower band, no longer hanging below it. Shown at chain size (20) and larger. */
export const FileBadges: Story = () => (
  <Frame>
    <Row label="file-ext badges — PNG / PY / TXT / PDF / TS / JSON (chain size 20)">
      <div
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          color: 'var(--pd-text-secondary)',
        }}
      >
        {['PNG', 'PY', 'TXT', 'PDF', 'TS', 'JSON'].map((ext) => (
          <FileExtIcon key={ext} ext={ext} size={20} />
        ))}
      </div>
    </Row>
    <Row label="same badges, enlarged (size 40) — legibility + centering">
      <div
        style={{
          display: 'flex',
          gap: 20,
          alignItems: 'center',
          color: 'var(--pd-text-secondary)',
        }}
      >
        {['PNG', 'PY', 'TXT'].map((ext) => (
          <FileExtIcon key={ext} ext={ext} size={40} />
        ))}
      </div>
    </Row>
  </Frame>
);

/** The live settings control — drag to see the preview row thin/thicken. */
export const StrokeControl: Story = () => {
  const [stroke, setStroke] = useState(1.25);
  return (
    <Frame>
      <Row label="IconStrokeControl (min 1.0, max 2.5, step 0.25)">
        <IconStrokeControl value={stroke} onChange={setStroke} />
      </Row>
      <Row label="the whole set, driven by the slider above">
        <IconGrid stroke={stroke} />
      </Row>
    </Frame>
  );
};
