import type { Story } from '@ladle/react';
import { useState } from 'react';
import { CollapsibleSearch, Input, SearchInput, TextArea } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

/** Stateful host so the collapse/expand toggle + typing work in the story. */
function CollapsibleSearchDemo({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const [value, setValue] = useState(defaultExpanded ? 'pixel shaders' : '');
  return (
    <div style={{ maxWidth: 280 }}>
      <CollapsibleSearch value={value} onChange={setValue} defaultExpanded={defaultExpanded} />
    </div>
  );
}

export const Inputs: Story = () => (
  <Frame>
    <Row label="input">
      <Input placeholder="Search sessions…" style={{ maxWidth: 280 }} />
    </Row>
    <Row label="collapsible search — collapsed (glass + 'Search chats', click to expand)">
      <CollapsibleSearchDemo />
    </Row>
    <Row label="collapsible search — expanded (live input in place)">
      <CollapsibleSearchDemo defaultExpanded />
    </Row>
    <Row label="search input (leading magnifying glass — 'Search chats')">
      <SearchInput placeholder="Search chats" style={{ maxWidth: 280 }} />
    </Row>
    <Row label="search input with value">
      <SearchInput defaultValue="pixel shaders" style={{ maxWidth: 280 }} />
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
