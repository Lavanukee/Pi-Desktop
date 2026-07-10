import type { Story } from '@ladle/react';
import {
  ComposerDivider,
  ContextGauge,
  ContextGaugeTooltip,
  IconButton,
  IconMic,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

/**
 * Context-fullness hover card (feedback #1). Hover the gauge to reveal a
 * compact Aside-style card: fullness %, used/total tokens, compaction note.
 * The second gauge is forced open so the contact sheet captures the card.
 */
export const ContextHover: Story = () => (
  <Frame>
    <Row label="hover the composer-footer gauge">
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderRadius: 12,
          background: 'var(--pd-bg-raised)',
          boxShadow: 'var(--pd-shadow-hairline)',
        }}
      >
        <span style={{ color: 'var(--pd-text-muted)', fontSize: 'var(--pd-font-size-footnote)' }}>
          Qwen3.6 27B
        </span>
        <ContextGaugeTooltip
          percent={18}
          usedTokens={73000}
          totalTokens={400000}
          note="Pi automatically compacts its context"
        />
        <ComposerDivider />
        <IconButton aria-label="Dictate">
          <IconMic />
        </IconButton>
      </div>
    </Row>
    <Row label="forced-open card (static capture)">
      <div style={{ height: 160, display: 'flex', alignItems: 'flex-end' }}>
        <ContextGaugeTooltip
          defaultOpen
          side="top"
          align="start"
          percent={82}
          usedTokens={328000}
          totalTokens={400000}
          note="Pi automatically compacts its context"
        >
          <ContextGauge value={0.82} size={18} tone="warn" tabIndex={0} />
        </ContextGaugeTooltip>
      </div>
    </Row>
  </Frame>
);
