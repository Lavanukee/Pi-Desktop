import { describe, expect, it, vi } from 'vitest';
import { render } from '../test-utils.tsx';
import { BrowserSurface } from './browser-surface.tsx';

describe('BrowserSurface', () => {
  it('shows the empty state when there is no URL', async () => {
    const { container } = await render(<BrowserSurface />);
    expect(container.querySelector('.pd-browser-empty')).toBeTruthy();
    expect(container.textContent).toContain('Start browsing');
    // The URL bar + nav chrome moved to the operation bar — not here anymore.
    expect(container.querySelector('.pd-browser-url')).toBeNull();
    expect(container.querySelector('.pd-browser-nav')).toBeNull();
  });

  it('hides the empty state once a URL is set', async () => {
    const { container } = await render(<BrowserSurface url="https://x.dev" />);
    expect(container.querySelector('.pd-browser-empty')).toBeNull();
  });

  it('honors the content-slot rect/ref contract on mount and unmount', async () => {
    const onMount = vi.fn();
    const onRectChange = vi.fn();
    const { container, unmount } = await render(
      <BrowserSurface url="https://x.dev" onMount={onMount} onRectChange={onRectChange} />,
    );
    const slot = container.querySelector('.pd-browser-slot');
    // Mount hands the app the slot element + its viewport rect.
    expect(onMount).toHaveBeenCalledWith(slot);
    const rect = onRectChange.mock.calls[0]?.[0];
    expect(rect).toBeTruthy();
    expect(typeof rect).toBe('object');

    // Unmount hides the native view: rect null then element null.
    await unmount();
    expect(onRectChange).toHaveBeenLastCalledWith(null);
    expect(onMount).toHaveBeenLastCalledWith(null);
  });

  it('shows the "model is driving" indicator when driving', async () => {
    const { container } = await render(<BrowserSurface url="https://x.dev" driving />);
    expect(container.querySelector('.pd-browser-driving')).toBeTruthy();
  });
});
