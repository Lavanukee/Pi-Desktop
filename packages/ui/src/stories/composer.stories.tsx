import type { Story } from '@ladle/react';
import { useState } from 'react';
import {
  AttachmentPill,
  Composer,
  ComposerDivider,
  ContextGauge,
  IconButton,
  IconMic,
  IconPlus,
  ModelPicker,
  SegmentedControl,
} from '../index.ts';
import { Story as Frame } from './helpers.tsx';

const MODELS = [
  { id: 'qwen', label: 'Qwen3.6 27B', description: 'MTP · Q4_K_M · 16.4 GB' },
  { id: 'gemma', label: 'Gemma4 E2B', description: 'Utility · Q8_0 · 2.1 GB' },
];

const EFFORTS = [
  { id: 'light', label: 'Light' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

function ComposerDemo({ withTray }: { withTray?: boolean }) {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState('chat');
  const [model, setModel] = useState('qwen');
  const [effort, setEffort] = useState('medium');
  return (
    <Composer
      value={value}
      onValueChange={setValue}
      placeholder="How can I help you today?"
      topTray={withTray ? <span>/model — switch the active model</span> : undefined}
      attachments={
        withTray ? (
          <AttachmentPill name="pi-bridge.ts" meta="12 KB" onRemove={() => {}} />
        ) : undefined
      }
      leading={
        <>
          <IconButton aria-label="Add files">
            <IconPlus />
          </IconButton>
          <SegmentedControl
            aria-label="Mode"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'chat', label: 'Chat' },
              { value: 'cowork', label: 'Cowork' },
            ]}
          />
        </>
      }
      trailing={
        <>
          <ModelPicker
            models={MODELS}
            model={model}
            onModelChange={setModel}
            efforts={EFFORTS}
            effort={effort}
            onEffortChange={setEffort}
          />
          <ContextGauge value={0.34} />
          <ComposerDivider />
          <IconButton aria-label="Dictate">
            <IconMic />
          </IconButton>
        </>
      }
    />
  );
}

export const Empty: Story = () => (
  <Frame>
    <ComposerDemo />
  </Frame>
);

export const WithTrayAndAttachment: Story = () => (
  <Frame>
    <ComposerDemo withTray />
  </Frame>
);
