import type { Story } from '@ladle/react';
import { IconButton, IconPlus, IconSearch, Tooltip, TooltipProvider } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

export const Tooltips: Story = () => (
  <TooltipProvider delayDuration={0}>
    <Frame>
      <Row label="forced open (claude: black glass / codex: theme pill)">
        <div style={{ display: 'flex', gap: 120, padding: '48px 24px' }}>
          <Tooltip open label="Add files and more" side="bottom">
            <IconButton aria-label="Attach">
              <IconPlus />
            </IconButton>
          </Tooltip>
          <Tooltip open label="Search chats" kbd="⌘G" side="bottom">
            <IconButton aria-label="Search">
              <IconSearch />
            </IconButton>
          </Tooltip>
        </div>
      </Row>
    </Frame>
  </TooltipProvider>
);
