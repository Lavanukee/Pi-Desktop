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

  it('primary "Open" segment emits onOpen and shows the default app icon', async () => {
    const onOpen = vi.fn();
    const { container } = await render(
      <CanvasOperationBar
        tab={tab({
          kind: 'file',
          filePath: 'src/index.ts',
          defaultApp: { id: 'code', name: 'VS Code', iconDataUrl: 'data:image/png;base64,AAAA' },
          openApps: [
            { id: 'code', name: 'VS Code' },
            { id: 'sublime', name: 'Sublime Text' },
          ],
        })}
        onOpen={onOpen}
      />,
    );
    const primary = container.querySelector('.pd-canvas-split-main');
    // The default app's icon (a data: URL <img>) sits on the primary segment.
    expect(primary?.getAttribute('aria-label')).toBe('Open with VS Code');
    expect(primary?.querySelector('.pd-canvas-app-icon img')).toBeTruthy();
    await click(primary);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('the ▾ lists apps EXCEPT the default, plus "Open in folder"', async () => {
    const onOpenWith = vi.fn();
    const onReveal = vi.fn();
    const { container } = await render(
      <CanvasOperationBar
        tab={tab({
          kind: 'file',
          filePath: 'src/index.ts',
          defaultApp: { id: 'code', name: 'VS Code' },
          openApps: [
            { id: 'code', name: 'VS Code' },
            { id: 'sublime', name: 'Sublime Text' },
            { id: 'zed', name: 'Zed' },
          ],
        })}
        onOpenWith={onOpenWith}
        onReveal={onReveal}
      />,
    );
    await click(container.querySelector('[aria-label="Open with…"]'));
    const items = [...container.querySelectorAll('.pd-menu-item')].map((n) => n.textContent);
    // Default (VS Code) omitted from the dropdown; "Open in folder" appended.
    expect(items).toEqual(['Sublime Text', 'Zed', 'Open in folder']);
    await click(container.querySelectorAll('.pd-menu-item')[0] ?? null);
    expect(onOpenWith).toHaveBeenCalledWith('sublime');

    await click(container.querySelector('[aria-label="Open with…"]'));
    const menuItems = container.querySelectorAll('.pd-menu-item');
    await click(menuItems[menuItems.length - 1] ?? null);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic app glyph when no default app is supplied', async () => {
    const { container } = await render(
      <CanvasOperationBar tab={tab({ kind: 'file', filePath: 'a.txt' })} />,
    );
    const primary = container.querySelector('.pd-canvas-split-main');
    expect(primary?.getAttribute('aria-label')).toBe('Open');
    // Generic glyph (an svg), not a system-icon <img>.
    expect(primary?.querySelector('.pd-canvas-app-icon svg')).toBeTruthy();
    expect(primary?.querySelector('.pd-canvas-app-icon img')).toBeNull();
  });
});

describe('CanvasOperationBar — file raw/rendered toggle', () => {
  it('shows the toggle for a markdown file and emits the mode change', async () => {
    const onFileViewModeChange = vi.fn();
    const { container } = await render(
      <CanvasOperationBar
        tab={tab({
          kind: 'file',
          filePath: 'README.md',
          artifact: { id: 'a', filename: 'README.md', content: { kind: 'markdown', text: '# Hi' } },
        })}
        fileViewMode="rendered"
        onFileViewModeChange={onFileViewModeChange}
      />,
    );
    const segments = [...container.querySelectorAll('.pd-canvas-view-toggle .pd-segment')].map(
      (n) => n.textContent,
    );
    expect(segments).toEqual(['Rendered', 'Raw']);
    const raw = [...container.querySelectorAll('.pd-canvas-view-toggle .pd-segment')].find(
      (n) => n.textContent === 'Raw',
    );
    await click(raw ?? null);
    expect(onFileViewModeChange).toHaveBeenCalledWith('raw');
  });

  it('hides the toggle for a non-markdown (code) file', async () => {
    const { container } = await render(
      <CanvasOperationBar tab={tab({ kind: 'file', filePath: 'main.ts' })} />,
    );
    expect(container.querySelector('.pd-canvas-view-toggle')).toBeNull();
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
    // The extension is stripped so it reads "render · PNG", not "render.png · PNG".
    const title = container
      .querySelector('.pd-media-title')
      ?.textContent?.replace(/\s+/g, ' ')
      .trim();
    expect(title).toBe('render · PNG');
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
