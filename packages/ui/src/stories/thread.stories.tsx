import type { Story } from '@ladle/react';
import { IconButton, IconCopy, IconPencil, MessageRow, Prose, Thread } from '../index.ts';

export const Messages: Story = () => (
  <div style={{ padding: '24px 0' }}>
    <Thread>
      <MessageRow
        kind="user"
        actions={
          <>
            <IconButton aria-label="Copy" size="sm" variant="ghostMuted">
              <IconCopy size={14} />
            </IconButton>
            <IconButton aria-label="Edit" size="sm" variant="ghostMuted">
              <IconPencil size={14} />
            </IconButton>
          </>
        }
      >
        What local model should I run on a 24GB MacBook for coding?
      </MessageRow>
      <MessageRow kind="assistant">
        <Prose>
          <p>
            For 24GB of unified memory, <strong>Qwen3.6-27B at Q4_K_M</strong> is the sweet spot —
            it uses about 16.4GB, leaving headroom for a <code>32k</code> context window.
          </p>
          <p>
            With MTP speculative decoding enabled you should see roughly 40% higher tokens/sec than
            plain decoding, and quality holds up well for code.
          </p>
        </Prose>
      </MessageRow>
      <MessageRow kind="user">Sounds good — set it up.</MessageRow>
    </Thread>
  </div>
);
