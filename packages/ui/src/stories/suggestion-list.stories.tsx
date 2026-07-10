import type { Story } from '@ladle/react';
import { useState } from 'react';
import { type SuggestionItem, SuggestionList } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const SUGGESTIONS: SuggestionItem[] = [
  { label: '/model — switch the active model', hint: 'command' },
  { label: '/clear — start a fresh session', hint: 'command' },
  { label: 'make_qr.py', hint: 'file' },
  { label: 'packages/ui/src/index.ts', hint: 'file' },
];

/** A mock composer so the overlay has something to float above. */
function MockComposer({ active }: { active: number }) {
  const [activeIndex, setActiveIndex] = useState(active);
  return (
    <div style={{ position: 'relative', width: 380 }}>
      <SuggestionList
        suggestions={SUGGESTIONS}
        activeIndex={activeIndex}
        onAccept={() => undefined}
        onHoverIndex={setActiveIndex}
      />
      <div
        className="pd-composer"
        style={{ padding: '14px 16px', color: 'var(--pd-text-primary)' }}
      >
        Generate a QR code for /mo
      </div>
    </div>
  );
}

export const Floating: Story = () => (
  <Frame>
    <Row label="suggestions float ABOVE the input — no layout reserved, active row is Tab-hinted">
      <div style={{ paddingTop: 180 }}>
        <MockComposer active={0} />
      </div>
    </Row>
  </Frame>
);
