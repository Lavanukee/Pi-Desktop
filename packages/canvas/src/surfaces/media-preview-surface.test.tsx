import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { click, render } from '../test-utils.tsx';
import { MediaPreviewSurface, mediaPreviewTransition } from './media-preview-surface.tsx';

/** Fire a non-bubbling media event React attaches directly to the element. */
async function fire(element: Element | null, type: 'load' | 'error'): Promise<void> {
  if (!element) throw new Error(`fire: no element for ${type}`);
  await act(async () => {
    element.dispatchEvent(new Event(type));
  });
}

describe('mediaPreviewTransition', () => {
  it('loading → loaded on load', () => {
    expect(mediaPreviewTransition('loading', { type: 'loaded' })).toBe('loaded');
  });
  it('loading → error on error', () => {
    expect(mediaPreviewTransition('loading', { type: 'error' })).toBe('error');
  });
  it('error → loading on retry', () => {
    expect(mediaPreviewTransition('error', { type: 'retry' })).toBe('loading');
  });
  it('retry is a no-op unless in error', () => {
    expect(mediaPreviewTransition('loaded', { type: 'retry' })).toBe('loaded');
    expect(mediaPreviewTransition('loading', { type: 'retry' })).toBe('loading');
  });
  it('reload always returns to loading', () => {
    expect(mediaPreviewTransition('loaded', { type: 'reload' })).toBe('loading');
    expect(mediaPreviewTransition('error', { type: 'reload' })).toBe('loading');
  });
});

describe('MediaPreviewSurface', () => {
  it('runs loading → error → retry(loading) → loaded', async () => {
    const { container } = await render(<MediaPreviewSurface src="a.png" type="png" index={2} />);
    // Header renders "Preview N · TYPE" upper-cased.
    expect(container.querySelector('.pd-media-title')?.textContent).toContain('Preview 2');
    expect(container.querySelector('.pd-media-type')?.textContent).toBe('PNG');
    // Starts loading (spinner shown, no error panel).
    expect(container.querySelector('.pd-media-status')).toBeTruthy();
    expect(container.querySelector('.pd-media-error')).toBeNull();

    // Element error → error panel with the exact copy + Try again.
    await fire(container.querySelector('img'), 'error');
    expect(container.querySelector('.pd-media-error-title')?.textContent).toBe(
      'Failed to load file content',
    );

    // Try again → back to loading, a fresh img mounts.
    await click(container.querySelector('.pd-media-error button'));
    expect(container.querySelector('.pd-media-error')).toBeNull();
    expect(container.querySelector('.pd-media-status')).toBeTruthy();

    // Element load → loaded, spinner gone, img visible.
    await fire(container.querySelector('img'), 'load');
    expect(container.querySelector('.pd-media-status')).toBeNull();
    expect(container.querySelector('img')?.hasAttribute('hidden')).toBe(false);
  });

  it('emits onDownload with the primary format from the split-button', async () => {
    const onDownload = vi.fn();
    const { container } = await render(
      <MediaPreviewSurface src="a.png" type="PNG" onDownload={onDownload} />,
    );
    await click(container.querySelector('.pd-media-download button'));
    expect(onDownload).toHaveBeenCalledWith('PNG');
  });

  it('honors a controlled status prop', async () => {
    const { container } = await render(
      <MediaPreviewSurface src="a.pdf" type="PDF" status="error" />,
    );
    expect(container.querySelector('.pd-media-error-title')?.textContent).toBe(
      'Failed to load file content',
    );
  });

  it('self-manages error (never a dead spinner) when src is missing', async () => {
    // B1: an uncontrolled surface with no src can never fire load/error, so it
    // must resolve to the error panel instead of spinning forever.
    const { container } = await render(<MediaPreviewSurface type="PNG" />);
    expect(container.querySelector('.pd-media-status')).toBeNull();
    expect(container.querySelector('.pd-media-error-title')?.textContent).toBe(
      'Failed to load file content',
    );
  });

  it('renders (not a spinner) once a valid uncontrolled src loads', async () => {
    // B1: a controlled `status` is NOT passed — the element's load event drives
    // the flip to loaded, which the old hard-controlled `mediaStatus` blocked.
    const { container } = await render(<MediaPreviewSurface src="a.png" type="PNG" />);
    expect(container.querySelector('.pd-media-status')).toBeTruthy();
    await fire(container.querySelector('img'), 'load');
    expect(container.querySelector('.pd-media-status')).toBeNull();
    expect(container.querySelector('img')?.hasAttribute('hidden')).toBe(false);
  });
});
