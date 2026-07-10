import type { Story } from '@ladle/react';
import type { QuestionOption } from '../index.ts';
import { QuestionCard } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const noop = () => {};

const OPTIONS: QuestionOption[] = [
  { value: 'q4', label: 'Q4_K_M — 16.4 GB', info: '4-bit. Best speed/quality tradeoff for 24GB.' },
  { value: 'q5', label: 'Q5_K_M — 19.2 GB', info: '5-bit. A little sharper, tighter headroom.' },
  { value: 'q8', label: 'Q8_0 — 28.9 GB', info: '8-bit. Needs 32GB of unified memory.' },
];

/**
 * Question UI — agent asks the user (feedback #8). One QuestionCard, three
 * modes: multiple choice (numbered, info icons, keyboard affordances),
 * free response, and slider.
 */
export const Choice: Story = () => (
  <Frame>
    <Row label="multiple choice (multi-select, per-row info)">
      <QuestionCard
        question="Which quantizations should Pi keep downloaded?"
        mode="choice"
        multiple
        options={OPTIONS}
        defaultValues={['q4']}
        onSubmit={noop}
        onCancel={noop}
      />
    </Row>
    <Row label="single choice">
      <QuestionCard
        question="Which model should Pi run by default?"
        mode="choice"
        options={OPTIONS}
        onSubmit={noop}
        onCancel={noop}
      />
    </Row>
  </Frame>
);

export const FreeResponse: Story = () => (
  <Frame>
    <Row label="free response">
      <QuestionCard
        question="What should Pi name this project?"
        mode="free"
        placeholder="e.g. Reaction-wheel airship"
        onSubmit={noop}
        onCancel={noop}
      />
    </Row>
  </Frame>
);

export const Slider: Story = () => (
  <Frame>
    <Row label="slider">
      <QuestionCard
        question="How much context should Pi reserve for tools (%)?"
        mode="slider"
        min={0}
        max={100}
        step={5}
        defaultValue={25}
        onSubmit={noop}
        onCancel={noop}
      />
    </Row>
  </Frame>
);
