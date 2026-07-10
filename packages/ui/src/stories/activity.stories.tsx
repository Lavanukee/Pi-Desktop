import type { Story } from '@ladle/react';
import {
  ActivityGroupCard,
  ActivityRow,
  Button,
  DiffStat,
  IconDiff,
  IconPencil,
  IconTerminal,
} from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const FILES = [
  { path: 'packages/engine/src/pi-bridge.ts', added: 76, deleted: 5 },
  { path: 'packages/engine/src/event-router.ts', added: 214, deleted: 3 },
  { path: 'apps/desktop/src/state/pi-slice.ts', added: 96, deleted: 4 },
  { path: 'apps/desktop/electron/main.ts', added: 41, deleted: 2 },
  { path: 'packages/shared/src/ipc.ts', added: 24, deleted: 1 },
  { path: 'README.md', added: 15, deleted: 0 },
];

export const ToolCalls: Story = () => (
  <Frame>
    <Row label="inline activity rows (claude flavor is a reconstruction — verify)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
        <ActivityRow icon={<IconTerminal size={14} />} label="Ran pnpm test" />
        <ActivityRow running label="Editing pi-bridge.ts…" />
        <ActivityRow icon={<IconPencil size={14} />} label="Edited a file" defaultExpanded>
          <span>
            Edited <span className="pd-activity-file-link">pi-bridge.ts</span>{' '}
            <DiffStat added={76} deleted={5} />
          </span>
        </ActivityRow>
      </div>
    </Row>
    <Row label="grouped turn-diff card (hover header for subtitle swap)">
      <ActivityGroupCard
        icon={<IconDiff />}
        title="Edited 6 files"
        added={466}
        deleted={15}
        hoverSubtitle="Review changes"
        visibleFiles={4}
        actions={
          <>
            <Button size="sm" variant="ghostMuted">
              Undo
            </Button>
            <Button size="sm" variant="outline">
              Review
            </Button>
          </>
        }
        files={FILES}
      />
    </Row>
    <Row label="rolling diffstat">
      <span style={{ fontSize: 'var(--pd-font-size-body)' }}>
        <DiffStat added={466} deleted={15} rolling />
      </span>
    </Row>
  </Frame>
);
