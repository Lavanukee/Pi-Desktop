import type { Story } from '@ladle/react';
import type { DiffFileData } from '../index.ts';
import { DiffView } from '../index.ts';
import { Story as Frame } from './helpers.tsx';

const FILES: DiffFileData[] = [
  {
    path: 'packages/engine/src/pi-bridge.ts',
    added: 4,
    deleted: 2,
    lines: [
      { kind: 'hunk', text: '@@ -12,7 +12,9 @@ export class PiBridge {' },
      {
        kind: 'context',
        text: '  constructor(opts: BridgeOptions) {',
        oldNumber: 12,
        newNumber: 12,
      },
      { kind: 'del', text: '    this.timeout = 5000;', oldNumber: 13 },
      { kind: 'del', text: '    this.retries = 0;', oldNumber: 14 },
      { kind: 'add', text: '    this.timeout = opts.timeout ?? 5000;', newNumber: 13 },
      { kind: 'add', text: '    this.retries = opts.retries ?? 2;', newNumber: 14 },
      { kind: 'add', text: '    this.backoff = opts.backoff ?? exponential();', newNumber: 15 },
      { kind: 'add', text: '    this.signal = opts.signal;', newNumber: 16 },
      {
        kind: 'context',
        text: '    this.child = spawnBridge(opts.bin);',
        oldNumber: 15,
        newNumber: 17,
      },
      { kind: 'context', text: '  }', oldNumber: 16, newNumber: 18 },
    ],
  },
];

export const UnifiedDiff: Story = () => (
  <Frame>
    <div style={{ maxWidth: 680 }}>
      <DiffView files={FILES} />
    </div>
  </Frame>
);
