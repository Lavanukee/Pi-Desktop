import type { Story } from '@ladle/react';
import {
  AttachmentPill,
  Badge,
  Chip,
  FloatingPill,
  IconFile,
  IconPencil,
  IconSearch,
  Kbd,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

export const Chips: Story = () => (
  <Frame>
    <Row label="suggestion chips (outline pills)">
      <Chip icon={<IconPencil size={14} />}>Write</Chip>
      <Chip icon={<IconSearch size={14} />}>Research</Chip>
      <Chip icon={<IconFile size={14} />}>Summarize a file</Chip>
    </Row>
    <Row label="badges">
      <Badge>3</Badge>
      <Badge tone="info">beta</Badge>
      <Badge tone="success">ready</Badge>
      <Badge tone="warning">82%</Badge>
      <Badge tone="danger">error</Badge>
      <Badge tone="accent">new</Badge>
      <Badge size="sm">12</Badge>
    </Row>
    <Row label="kbd hints — auto (flavor default), chip, bare">
      <Kbd keys="⌘K" />
      <Kbd keys="⌘⇧P" appearance="chip" />
      <Kbd keys="⌘N" appearance="bare" />
    </Row>
    <Row label="attachment pill (concentric radius)">
      <AttachmentPill name="quarterly-report.pdf" meta="1.2 MB" onRemove={() => {}} />
      <AttachmentPill name="notes.md" />
    </Row>
    <Row label="floating suggestion pill">
      <FloatingPill title="Continue setup" description="2 of 3 steps done" onDismiss={() => {}} />
    </Row>
  </Frame>
);
