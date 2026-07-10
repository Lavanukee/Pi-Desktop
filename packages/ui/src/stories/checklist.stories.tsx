import type { Story } from '@ladle/react';
import type { TaskChecklistItem } from '../index.ts';
import { TaskChecklist } from '../index.ts';
import { Story as Frame, Row } from './helpers.tsx';

const ITEMS: TaskChecklistItem[] = [
  { label: 'Read the component spec book', state: 'done' },
  { label: 'Port the token vocabulary', state: 'done' },
  { label: 'Wire the composer footer', state: 'in-progress' },
  { label: 'Hook up the context gauge', state: 'pending' },
  { label: 'Ship the sidebar canvas', state: 'roadmap' },
];

const SUBAGENTS: TaskChecklistItem[] = [
  { label: 'search: token math references', state: 'done' },
  { label: 'verify: reduced-motion story', state: 'done' },
  { label: 'draft: fidelity read', state: 'in-progress' },
];

export const TaskProgress: Story = () => (
  <Frame>
    <Row label="task progress — done springs a green check, in-progress spins">
      <div style={{ width: 320 }}>
        <TaskChecklist
          title="Task progress"
          items={ITEMS}
          subagents={{ items: SUBAGENTS, defaultOpen: true }}
        />
      </div>
    </Row>
    <Row label="bare list (no title, collapsed subagents)">
      <div style={{ width: 320 }}>
        <TaskChecklist items={ITEMS} subagents={{ title: 'Completed steps', items: SUBAGENTS }} />
      </div>
    </Row>
  </Frame>
);
