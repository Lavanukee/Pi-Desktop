import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { click, render } from '../test-utils.tsx';
import { CanvasOperationBar, deriveBreadcrumb } from './canvas-operation-bar.tsx';
import type { CanvasTab, FileTreeNode } from './tab-model.ts';

function tab(partial: Partial<CanvasTab> & Pick<CanvasTab, 'kind'>): CanvasTab {
  return { id: 't1', title: 'Tab', ...partial };
}

const fileTree: FileTreeNode[] = [
  {
    name: 'src',
    path: 'src',
    kind: 'dir',
    children: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }],
  },
];

describe('deriveBreadcrumb', () => {
  it('splits a file path into segments', () => {
    expect(deriveBreadcrumb(tab({ kind: 'file', filePath: 'src/utils/helpers.ts' }))).toEqual([
      'src',
      'utils',
      'helpers.ts',
    ]);
  });
  it('prefers an explicit breadcrumb', () => {
    expect(
      deriveBreadcrumb(tab({ kind: 'file', breadcrumb: ['a', 'b'], filePath: 'x/y' })),
    ).toEqual(['a', 'b']);
  });
  it('falls back to the artifact filename', () => {
    expect(
      deriveBreadcrumb(
        tab({
          kind: 'file',
          artifact: { id: 'a', content: { kind: 'text', text: '' }, filename: 'a/b.md' },
        }),
      ),
    ).toEqual(['a', 'b.md']);
  });
});

describe('CanvasOperationBar — kinds with no bar', () => {
  it('renders nothing for terminal', async () => {
    const { container } = await render(<CanvasOperationBar tab={tab({ kind: 'terminal' })} />);
    expect(container.querySelector('.pd-canvas-opbar')).toBeNull();
  });
  it('renders nothing for code', async () => {
    const { container } = await render(<CanvasOperationBar tab={tab({ kind: 'code' })} />);
    expect(container.querySelector('.pd-canvas-opbar')).toBeNull();
  });
});

describe('CanvasOperationBar — file', () => {
  it('renders the breadcrumb from the file path', async () => {
    const { container } = await render(
      <CanvasOperationBar tab={tab({ kind: 'file', filePath: 'src/app/main.ts' })} />,
    );
    const crumbs = [...container.querySelectorAll('.pd-canvas-crumb-label')].map(
      (n) => n.textContent,
    );
    expect(crumbs).toEqual(['src', 'app', 'main.ts']);
    // The file segment is flagged for styling.
    expect(
      container.querySelector('.pd-canvas-crumb[data-file] .pd-canvas-crumb-label')?.textContent,
    ).toBe('main.ts');
  });

  it('toggles the file-tree panel from the two-folders button', async () => {
    const { container } = await render(
      <CanvasOperationBar tab={tab({ kind: 'file', filePath: 'src/index.ts', fileTree })} />,
    );
    expect(container.querySelector('.pd-canvas-tree-panel')).toBeNull();
    await click(container.querySelector('[aria-label="Toggle file tree"]'));
    expect(container.querySelector('.pd-canvas-tree-panel')).toBeTruthy();
    expect(container.querySelector('.pd-file-tree')).toBeTruthy();
  });

  it('emits onFileTreeSelect when a file is chosen from the tree', async () => {
    const onFileTreeSelect = vi.fn();
    const { container } = await render(
      <CanvasOperationBar
        tab={tab({ kind: 'file', fileTree })}
        onFileTreeSelect={onFileTreeSelect}
      />,
    );
    await click(container.querySelector('[aria-label="Toggle file tree"]'));
    await click(container.querySelector('.pd-file-tree-row[data-kind="file"]'));
    expect(onFileTreeSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/index.ts' }),
    );
    // Selecting closes the panel.
    expect(container.querySelector('.pd-canvas-tree-panel')).toBeNull();
  });

  it('opens the "Open ▾" dropdown and emits onOpenWith / onReveal', async () => {
    const onOpenWith = vi.fn();
    const onReveal = vi.fn();
    const { container } = await render(
      <CanvasOperationBar
        tab={tab({ kind: 'file', filePath: 'src/index.ts' })}
        onOpenWith={onOpenWith}
        onReveal={onReveal}
      />,
    );
    await click(container.querySelector('[aria-label="Open with"]'));
    const items = [...container.querySelectorAll('.pd-canvas-menu-item')].map((n) => n.textContent);
    expect(items).toEqual([
      'VS Code Insiders',
      'Default app',
      'Terminal',
      'Xcode',
      'Open in folder',
    ]);
    await click(container.querySelectorAll('.pd-canvas-menu-item')[0] ?? null);
    expect(onOpenWith).toHaveBeenCalledWith('vscode-insiders');

    await click(container.querySelector('[aria-label="Open with"]'));
    const menuItems = container.querySelectorAll('.pd-canvas-menu-item');
    await click(menuItems[menuItems.length - 1] ?? null);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
});

describe('CanvasOperationBar — browser', () => {
  it('wires back / forward / refresh / external / menu', async () => {
    const spies = {
      onBrowserBack: vi.fn(),
      onBrowserForward: vi.fn(),
      onBrowserReload: vi.fn(),
      onBrowserOpenExternal: vi.fn(),
      onBrowserMenu: vi.fn(),
    };
    const { container } = await render(
      <CanvasOperationBar
        tab={tab({ kind: 'browser', url: 'https://x.dev', canGoBack: true, canGoForward: true })}
        {...spies}
      />,
    );
    await click(container.querySelector('[aria-label="Back"]'));
    await click(container.querySelector('[aria-label="Forward"]'));
    await click(container.querySelector('[aria-label="Refresh"]'));
    await click(container.querySelector('[aria-label="Open in external browser"]'));
    await click(container.querySelector('[aria-label="Browser menu"]'));
    expect(spies.onBrowserBack).toHaveBeenCalledTimes(1);
    expect(spies.onBrowserForward).toHaveBeenCalledTimes(1);
    expect(spies.onBrowserReload).toHaveBeenCalledTimes(1);
    expect(spies.onBrowserOpenExternal).toHaveBeenCalledTimes(1);
    expect(spies.onBrowserMenu).toHaveBeenCalledTimes(1);
  });

  it('submits the URL bar via onBrowserNavigate', async () => {
    const onBrowserNavigate = vi.fn();
    const { container } = await render(
      <CanvasOperationBar tab={tab({ kind: 'browser' })} onBrowserNavigate={onBrowserNavigate} />,
    );
    const input = container.querySelector<HTMLInputElement>('.pd-browser-url');
    const form = container.querySelector('form');
    if (!input || !form) throw new Error('missing url bar');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, 'example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onBrowserNavigate).toHaveBeenCalledWith('example.com');
  });

  it('disables back / forward when the tab cannot navigate', async () => {
    const { container } = await render(
      <CanvasOperationBar tab={tab({ kind: 'browser', url: 'https://x.dev' })} />,
    );
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Forward"]')?.disabled).toBe(
      true,
    );
  });
});

describe('CanvasOperationBar — media', () => {
  it('shows the "<name> · <TYPE>" label and download/refresh/expand/close', async () => {
    const onMediaDownload = vi.fn();
    const onMediaRefresh = vi.fn();
    const onMediaExpand = vi.fn();
    const onClose = vi.fn();
    const { container } = await render(
      <CanvasOperationBar
        tab={tab({ kind: 'image', filePath: 'out/render.png', mediaType: 'PNG' })}
        onMediaDownload={onMediaDownload}
        onMediaRefresh={onMediaRefresh}
        onMediaExpand={onMediaExpand}
        onClose={onClose}
      />,
    );
    expect(container.querySelector('.pd-media-title')?.textContent).toContain('render.png');
    expect(container.querySelector('.pd-media-type')?.textContent).toBe('PNG');
    await click(container.querySelector('.pd-media-download button'));
    expect(onMediaDownload).toHaveBeenCalledWith('PNG');
    await click(container.querySelector('[aria-label="Refresh preview"]'));
    await click(container.querySelector('[aria-label="Expand preview"]'));
    await click(container.querySelector('[aria-label="Close preview"]'));
    expect(onMediaRefresh).toHaveBeenCalledTimes(1);
    expect(onMediaExpand).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers extra formats in the download dropdown', async () => {
    const onMediaDownload = vi.fn();
    const { container } = await render(
      <CanvasOperationBar
        tab={tab({ kind: 'image', mediaType: 'PNG', downloadFormats: ['PNG', 'JPG'] })}
        onMediaDownload={onMediaDownload}
      />,
    );
    await click(container.querySelector('[aria-label="Download options"]'));
    const formats = [...container.querySelectorAll('.pd-canvas-menu-item')].map(
      (n) => n.textContent,
    );
    expect(formats).toEqual(['PNG', 'JPG']);
    await click(container.querySelectorAll('.pd-canvas-menu-item')[1] ?? null);
    expect(onMediaDownload).toHaveBeenCalledWith('JPG');
  });
});
