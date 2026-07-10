import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { click, render } from '../test-utils.tsx';
import { ProjectPicker, type ProjectPickerItem, placeProjectMenu } from './project-picker.tsx';

/** A fake anchor with a fixed client rect for placement tests. */
function anchorAt(rect: Partial<DOMRect>): HTMLElement {
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, ...rect }) as DOMRect,
  } as unknown as HTMLElement;
}

const projects: ProjectPickerItem[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
  { id: 'c', name: 'Gamma' },
];

/** Type into the search input via the native setter so onChange fires. */
async function typeSearch(input: HTMLInputElement | null, value: string): Promise<void> {
  if (!input) throw new Error('no search input');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const noop = () => {};

describe('ProjectPicker', () => {
  it('shows the active project on the chip and ✓ in the open dropdown', async () => {
    const { container } = await render(
      <ProjectPicker projects={projects} active="b" onSelect={noop} onNew={noop} onClear={noop} />,
    );
    expect(container.querySelector('.pd-project-chip-label')?.textContent).toBe('Beta');
    expect(container.querySelector('.pd-menu')).toBeNull();
    await click(container.querySelector('.pd-project-chip'));
    expect(container.querySelector('.pd-menu')).toBeTruthy();
    const checked = [...container.querySelectorAll('.pd-menu-item')].find(
      (n) => n.getAttribute('aria-checked') === 'true',
    );
    expect(checked?.textContent).toContain('Beta');
  });

  it('shows the placeholder when no project is active', async () => {
    const { container } = await render(
      <ProjectPicker
        projects={projects}
        active={null}
        onSelect={noop}
        onNew={noop}
        onClear={noop}
        placeholder="No project"
      />,
    );
    expect(container.querySelector('.pd-project-chip-label')?.textContent).toBe('No project');
  });

  it('filters the list, calls onSearch, and selects a project', async () => {
    const onSelect = vi.fn();
    const onSearch = vi.fn();
    const { container } = await render(
      <ProjectPicker
        projects={projects}
        onSelect={onSelect}
        onNew={noop}
        onClear={noop}
        onSearch={onSearch}
      />,
    );
    await click(container.querySelector('.pd-project-chip'));
    await typeSearch(container.querySelector<HTMLInputElement>('.pd-project-search-input'), 'ga');
    expect(onSearch).toHaveBeenCalledWith('ga');
    const names = [...container.querySelectorAll('.pd-project-name')].map((n) => n.textContent);
    expect(names).toEqual(['Gamma']);
    await click(
      [...container.querySelectorAll('.pd-menu-item')].find((n) =>
        n.textContent?.includes('Gamma'),
      ) ?? null,
    );
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('offers "New project" and "Don\'t work in a project"', async () => {
    const onNew = vi.fn();
    const onClear = vi.fn();
    const { container } = await render(
      <ProjectPicker projects={projects} onSelect={noop} onNew={onNew} onClear={onClear} />,
    );
    await click(container.querySelector('.pd-project-chip'));
    const items = [...container.querySelectorAll('.pd-menu-item')].map((n) => n.textContent);
    expect(items).toContain('New project');
    await click(
      [...container.querySelectorAll('.pd-menu-item')].find(
        (n) => n.textContent === 'New project',
      ) ?? null,
    );
    expect(onNew).toHaveBeenCalledTimes(1);

    await click(container.querySelector('.pd-project-chip'));
    await click(
      [...container.querySelectorAll('.pd-menu-item')].find((n) =>
        n.textContent?.includes("Don't work"),
      ) ?? null,
    );
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('opens the dropdown with fixed positioning so it never clips (round-10 #10)', async () => {
    const { container } = await render(
      <ProjectPicker projects={projects} onSelect={noop} onNew={noop} onClear={noop} />,
    );
    await click(container.querySelector('.pd-project-chip'));
    const menu = container.querySelector<HTMLElement>('.pd-menu');
    expect(menu?.style.position).toBe('fixed');
    // A width + a max-height keep it clamped to the viewport.
    expect(menu?.style.maxHeight).not.toBe('');
    expect(menu?.style.width).not.toBe('');
  });
});

describe('placeProjectMenu', () => {
  const viewport = { width: 1000, height: 800 };

  it('returns null without an anchor', () => {
    expect(placeProjectMenu(null, viewport)).toBeNull();
  });

  it('opens downward when there is room below', () => {
    const pos = placeProjectMenu(anchorAt({ left: 20, top: 40, bottom: 68 }), viewport);
    expect(pos?.top).toBe(68 + 6);
    expect(pos?.bottom).toBeUndefined();
    expect(pos?.left).toBe(20);
  });

  it('flips ABOVE the chip when below is tight (picker near the window bottom)', () => {
    // Chip sits near the bottom (above the composer) → not enough room below.
    const pos = placeProjectMenu(anchorAt({ left: 20, top: 740, bottom: 768 }), viewport);
    expect(pos?.top).toBeUndefined();
    expect(pos?.bottom).toBe(viewport.height - 740 + 6);
  });

  it('clamps the left edge into the viewport', () => {
    const pos = placeProjectMenu(anchorAt({ left: 980, top: 40, bottom: 68 }), viewport);
    // width caps at 280 → left clamps to width - margin.
    expect(pos?.left).toBeLessThanOrEqual(viewport.width - (pos?.width ?? 0) - 8 + 0.5);
    expect(pos?.left).toBeGreaterThanOrEqual(8);
  });
});
