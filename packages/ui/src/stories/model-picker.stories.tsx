import type { Story } from '@ladle/react';
import { useState } from 'react';
import { ModelPicker } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const MODELS = [
  { id: 'qwen', label: 'Qwen3.6 27B', description: 'MTP · Q4_K_M · 16.4 GB' },
  { id: 'gemma', label: 'Gemma4 E2B', description: 'Utility · Q8_0 · 2.1 GB' },
  { id: 'custom', label: 'Custom GGUF…' },
];

const EFFORTS = [
  { id: 'light', label: 'Light' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
];

export const Trigger: Story = () => {
  const [model, setModel] = useState('qwen');
  const [effort, setEffort] = useState('high');
  return (
    <Frame>
      <Row label="closed trigger (ghost text button, fade mask at 12rem)">
        <ModelPicker
          models={MODELS}
          model={model}
          onModelChange={setModel}
          efforts={EFFORTS}
          effort={effort}
          onEffortChange={setEffort}
        />
      </Row>
    </Frame>
  );
};

export const MenuOpen: Story = () => (
  <Frame>
    <div style={{ height: 420 }}>
      <ModelPicker open models={MODELS} model="qwen" efforts={EFFORTS} effort="high" />
    </div>
  </Frame>
);
