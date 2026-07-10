import type { Story } from '@ladle/react';
import { ScrollArea } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const LINES = Array.from({ length: 40 }, (_, i) => `Log line ${i + 1}: llama-server heartbeat ok`);

export const Scrollbars: Story = () => (
  <Frame>
    <Row label="scroll area with edge fade (flavor scrollbar recipes)">
      <ScrollArea style={{ height: 200, width: 360 }}>
        <div style={{ padding: '4px 12px' }}>
          {LINES.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </ScrollArea>
    </Row>
    <Row label="hidden scrollbar (menus/pill rows)">
      <ScrollArea hideScrollbar style={{ height: 120, width: 360 }}>
        <div style={{ padding: '4px 12px' }}>
          {LINES.slice(0, 20).map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </ScrollArea>
    </Row>
  </Frame>
);
