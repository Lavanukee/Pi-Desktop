import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { click, render } from '../test-utils.tsx';
import { ProjectPicker, type ProjectPickerItem } from './project-picker.tsx';

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
});
