import type { Story } from '@ladle/react';
import { ShimmerText, ThinkingBlock } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const BRIEF = 'Curated exercise tutorials and reframed guidance toward direct audience engagement.';

const LONG = `The user wants a local model recommendation. Given 24GB of unified memory, a 27B parameter model at Q4_K_M quantization should leave roughly 6GB of headroom for the context window and the OS. MTP decoding gives another ~40% throughput on top of that, so the 27B is the right default rather than the 14B. I should also mention that dropping to Q3 would free memory but noticeably hurts instruction-following, which is the opposite of what a first-run default should optimize for.`;

export const Shimmer: Story = () => (
  <Frame>
    <Row label="shimmer text (claude smooth sweep / codex steps-48)">
      <ShimmerText>Thinking…</ShimmerText>
      <ShimmerText>Searching the web…</ShimmerText>
      <ShimmerText active={false} style={{ color: 'var(--pd-text-muted)' }}>
        Done thinking
      </ShimmerText>
    </Row>
  </Frame>
);

export const Thinking: Story = () => (
  <Frame>
    <Row label="DEFAULT (standalone) — collapsed 'Thought for X' pill; click to roll open">
      <ThinkingBlock status="done" durationMs={12000}>
        {LONG}
      </ThinkingBlock>
    </Row>
    <Row label="running — shimmering present-tense pill">
      <ThinkingBlock status="running">{BRIEF}</ThinkingBlock>
    </Row>
    <Row label="expanded brief — plain dim text, no show-more">
      <ThinkingBlock status="done" durationMs={4000} defaultExpanded>
        {BRIEF}
      </ThinkingBlock>
    </Row>
    <Row label="expanded long — bottom fade + small 'Show more' below the text">
      <ThinkingBlock status="done" durationMs={12000} defaultExpanded>
        {LONG}
      </ThinkingBlock>
    </Row>
    <Row label="bare inline thought (hideLabel) — how a brief thought sits between prose">
      <ThinkingBlock status="done" hideLabel>
        {BRIEF}
      </ThinkingBlock>
    </Row>
  </Frame>
);
