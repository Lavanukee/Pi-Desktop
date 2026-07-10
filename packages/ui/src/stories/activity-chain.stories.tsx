import type { Story } from '@ladle/react';
import {
  ActivityChain,
  type ActivityStepData,
  type DiffFileData,
  type WebSearchResultData,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const THOUGHT =
  'qrcode + pillow is the smallest dependency footprint here. I could shell out to a system QR tool, ' +
  'but that adds an external process dependency and platform-specific paths; staying in-process with ' +
  'pillow keeps it portable. Plan: write the file, run it once to confirm the encode, then hand back ' +
  'the PNG and open it inline in the canvas so the user can eyeball the result immediately.';

const DIFF: DiffFileData[] = [
  {
    path: 'make_qr.py',
    added: 4,
    deleted: 1,
    lines: [
      { kind: 'hunk', text: '@@ -1,3 +1,6 @@' },
      { kind: 'context', text: 'import qrcode', newNumber: 1 },
      { kind: 'del', text: 'img = qrcode.make("hi")', oldNumber: 2 },
      { kind: 'add', text: 'img = qrcode.make("https://pi.local")', newNumber: 2 },
      { kind: 'add', text: 'img.save("qr.png")', newNumber: 3 },
    ],
  },
];

const RESULTS: WebSearchResultData[] = [
  { title: 'qrcode · PyPI', url: 'https://pypi.org/project/qrcode', domain: 'pypi.org' },
  {
    title: 'Image Module — Pillow documentation',
    url: 'https://pillow.readthedocs.io',
    domain: 'pillow.readthedocs.io',
  },
  {
    title: 'How to generate a QR code in Python',
    url: 'https://realpython.com/qrcode',
    domain: 'realpython.com',
  },
];

const CHAIN: ActivityStepData[] = [
  {
    kind: 'thinking',
    label: 'Planned the QR generator',
    thought: THOUGHT,
    durationMs: 80 * 60_000,
  },
  {
    kind: 'bash',
    label: 'Ran a command',
    tag: 'Script',
    command:
      'cat > make_qr.py <<\'EOF\'\nimport qrcode\nimg = qrcode.make("https://pi.local/very/long/path/that/forces/a/horizontal/scroll/inside/the/framed/code/box")\nimg.save("qr.png")\nEOF\necho "Updated."',
    output:
      'Wrote make_qr.py and generated qr.png (177x177) at ./out/qr.png — a single very long output line that scrolls horizontally inside the bordered output frame.',
  },
  { kind: 'edit', label: 'Edited make_qr.py', filename: 'make_qr.py', diff: DIFF },
  {
    kind: 'search',
    label: 'Searched the web',
    query: 'qrcode python pillow save png',
    results: RESULTS,
  },
  { kind: 'read', label: 'Read make_qr.py', filename: 'make_qr.py', preview: 'import qrcode …' },
  { kind: 'image', label: 'Rendered qr.png', filename: 'qr.png', opensInCanvas: true },
];

/** Collapsed: one dim summary line aggregating the whole chain (chevron on hover). */
export const Collapsed: Story = () => (
  <Frame>
    <Row label="collapsed chain — full order-independent aggregation ('thought for 1h 20m …')">
      <ActivityChain steps={CHAIN} />
    </Row>
  </Frame>
);

/**
 * Expanded: connector-threaded step list. Thoughts + web searches render inline
 * (always open); bash/edit/read carry a pill below the line to reveal content.
 */
export const Expanded: Story = () => (
  <Frame>
    <Row label="expanded — thought + search inline; bash/edit/read show a pill below the line">
      <ActivityChain steps={CHAIN} defaultExpanded />
    </Row>
  </Frame>
);

/** Pill-expanded: terminal command + Output block (bash pill seeded open). */
export const StepTerminal: Story = () => (
  <Frame>
    <Row label="pill opened — terminal command input + Output section">
      <ActivityChain steps={CHAIN} defaultExpanded defaultOpenStep={1} />
    </Row>
  </Frame>
);

/** Pill-expanded: file edit renders the DiffView (edit pill seeded open). */
export const StepDiff: Story = () => (
  <Frame>
    <Row label="pill opened — file edit reuses DiffView">
      <ActivityChain steps={CHAIN} defaultExpanded defaultOpenStep={2} />
    </Row>
  </Frame>
);

/** Web search renders its result list inline (no pill, no second click). */
export const StepSearch: Story = () => (
  <Frame>
    <Row label="inline — web-search result list renders directly in the open chain">
      <ActivityChain steps={CHAIN} defaultExpanded />
    </Row>
  </Frame>
);
