import type { Story } from '@ladle/react';
import type { ButtonVariant } from '../index.ts';
import { Button, IconButton, IconClose, IconPlus, IconSearch, IconSidebar } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const VARIANTS: ButtonVariant[] = [
  'primary',
  'accent',
  'secondary',
  'outline',
  'ghost',
  'ghostMuted',
  'danger',
];

export const Buttons: Story = () => (
  <Frame>
    <Row label="variants">
      {VARIANTS.map((variant) => (
        <Button key={variant} variant={variant}>
          {variant}
        </Button>
      ))}
    </Row>
    <Row label="disabled">
      {VARIANTS.map((variant) => (
        <Button key={variant} variant={variant} disabled>
          {variant}
        </Button>
      ))}
    </Row>
    <Row label="loading">
      <Button variant="primary" loading>
        Sending
      </Button>
      <Button variant="secondary" loading>
        Working
      </Button>
    </Row>
    <Row label="sizes">
      <Button variant="primary" size="sm">
        Small
      </Button>
      <Button variant="primary" size="md">
        Medium
      </Button>
      <Button variant="primary" size="lg">
        Large
      </Button>
    </Row>
    <Row label="open trigger state (data-state=open mirrors hover)">
      <Button variant="ghost" data-state="open">
        Menu open
      </Button>
      <Button variant="outline" data-state="open">
        Menu open
      </Button>
    </Row>
    <Row label="icon buttons (28px topbar chrome)">
      <IconButton aria-label="Toggle sidebar">
        <IconSidebar />
      </IconButton>
      <IconButton aria-label="Search">
        <IconSearch />
      </IconButton>
      <IconButton aria-label="New" variant="secondary">
        <IconPlus />
      </IconButton>
      <IconButton aria-label="Close" size="sm">
        <IconClose size={12} />
      </IconButton>
      <IconButton aria-label="Send" variant="primary" circle>
        <IconPlus />
      </IconButton>
    </Row>
  </Frame>
);
