import type { Story } from '@ladle/react';
import { ContextGauge, ProgressBar, Spinner } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

export const Indicators: Story = () => (
  <Frame>
    <Row label="progress (determinate)">
      <div style={{ width: 320 }}>
        <ProgressBar value={0.65} />
      </div>
    </Row>
    <Row label="progress (indeterminate)">
      <div style={{ width: 320 }}>
        <ProgressBar />
      </div>
    </Row>
    <Row label="spinner (desynced starts)">
      <Spinner size={12} />
      <Spinner />
      <Spinner size={24} />
    </Row>
    <Row label="context gauge (16px codex donut; ring scales)">
      <ContextGauge value={0.12} />
      <ContextGauge value={0.5} />
      <ContextGauge value={0.85} />
      <ContextGauge value={0.85} tone="warn" size={20} />
      <ContextGauge value={0.97} tone="danger" size={28} />
    </Row>
  </Frame>
);
