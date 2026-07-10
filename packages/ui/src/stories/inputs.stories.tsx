import type { Story } from '@ladle/react';
import { Input, TextArea } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

export const Inputs: Story = () => (
  <Frame>
    <Row label="input">
      <Input placeholder="Search sessions…" style={{ maxWidth: 280 }} />
    </Row>
    <Row label="input with value">
      <Input defaultValue="qwen3.6-27b-mtp.gguf" style={{ maxWidth: 280 }} />
    </Row>
    <Row label="disabled">
      <Input placeholder="Disabled" disabled style={{ maxWidth: 280 }} />
    </Row>
    <Row label="textarea (auto-grow mirror)">
      <TextArea
        autoGrow
        placeholder="System prompt…"
        defaultValue={'You are Pi, a local assistant.\nBe concise.'}
        style={{ maxWidth: 420 }}
      />
    </Row>
  </Frame>
);
