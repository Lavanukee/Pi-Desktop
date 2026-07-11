import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskChecklist, type TaskChecklistItem } from './checklist.tsx';

/**
 * TaskChecklist collapse-to-title (round-14 #6): when `collapsible`, the title
 * row becomes a toggle button with a rotating chevron + a right-aligned
 * {done}/{total} count, and the body tucks up. Both ends of the collapse swap
 * are asserted through static markup via the uncontrolled `defaultCollapsed`
 * prop (the repo's jsdom-free rendering convention); the non-collapsible path
 * must stay byte-identical.
 */
const items: TaskChecklistItem[] = [
  { label: 'Design', state: 'done' },
  { label: 'Build', state: 'done' },
  { label: 'Ship it', state: 'in-progress' },
  { label: 'Celebrate', state: 'pending' },
];

describe('TaskChecklist collapsible', () => {
  it('non-collapsible: keeps the plain title and renders no toggle/body wrapper', () => {
    const html = renderToStaticMarkup(<TaskChecklist title="Plan" items={items} />);
    expect(html).toContain('pd-task-title');
    expect(html).toContain('Plan');
    // The collapsible chrome is entirely absent — the byte-identical path.
    expect(html).not.toContain('task-collapse-toggle');
    expect(html).not.toContain('pd-task-body');
    expect(html).not.toContain('aria-expanded');
  });

  it('collapsible (default expanded): a toggle button, aria-expanded=true, body shown, done/total count', () => {
    const html = renderToStaticMarkup(<TaskChecklist title="Plan" items={items} collapsible />);
    expect(html).toContain('data-testid="task-collapse-toggle"');
    expect(html).toContain('aria-expanded="true"');
    // Chevron points down (data-open) when expanded.
    expect(html).toContain('pd-task-collapse-chevron');
    expect(html).toContain('data-open');
    // Body wrapper present and NOT collapsed.
    expect(html).toContain('pd-task-body');
    expect(html).not.toContain('data-collapsed');
    // 2 of 4 items are done.
    expect(html).toContain('2/4');
    // The steps are still rendered (grid tuck-up animates a mounted body).
    expect(html).toContain('Ship it');
  });

  it('collapsible + defaultCollapsed: aria-expanded=false, body carries data-collapsed, count intact', () => {
    const html = renderToStaticMarkup(
      <TaskChecklist title="Plan" items={items} collapsible defaultCollapsed />,
    );
    expect(html).toContain('data-testid="task-collapse-toggle"');
    expect(html).toContain('aria-expanded="false"');
    // Body is collapsed via the data attribute (grid-rows → 0fr) but stays mounted.
    expect(html).toContain('data-collapsed');
    expect(html).toContain('2/4');
    expect(html).toContain('Ship it');
  });

  it('count reflects the done tally, not a hard-coded total', () => {
    const allDone: TaskChecklistItem[] = [
      { label: 'a', state: 'done' },
      { label: 'b', state: 'done' },
    ];
    const html = renderToStaticMarkup(<TaskChecklist title="Plan" items={allDone} collapsible />);
    expect(html).toContain('2/2');
  });
});
