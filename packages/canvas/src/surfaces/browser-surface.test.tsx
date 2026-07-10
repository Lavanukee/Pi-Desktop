import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { click, render } from '../test-utils.tsx';
import { BrowserSurface } from './browser-surface.tsx';

describe('BrowserSurface', () => {
  it('shows the empty state when there is no URL', async () => {
    const { container } = await render(<BrowserSurface />);
    expect(container.querySelector('.pd-browser-empty')).toBeTruthy();
    expect(container.textContent).toContain('Start browsing');
    expect(container.querySelector<HTMLInputElement>('.pd-browser-url')?.placeholder).toBe(
      'Enter a URL',
    );
  });

  it('submits the URL bar via onNavigate', async () => {
    const onNavigate = vi.fn();
    const { container } = await render(<BrowserSurface onNavigate={onNavigate} />);
    const input = container.querySelector<HTMLInputElement>('.pd-browser-url');
    const form = container.querySelector('form');
    if (!input || !form) throw new Error('missing url bar');
    // Bypass React's value tracker via the native setter so onChange fires.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, 'example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onNavigate).toHaveBeenCalledWith('example.com');
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

  it('wires back / forward / refresh controls', async () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    const onReload = vi.fn();
    const { container } = await render(
      <BrowserSurface
        url="https://x.dev"
        canGoBack
        canGoForward
        onBack={onBack}
        onForward={onForward}
        onReload={onReload}
      />,
    );
    await click(container.querySelector('[aria-label="Back"]'));
    await click(container.querySelector('[aria-label="Forward"]'));
    await click(container.querySelector('[aria-label="Refresh"]'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('shows the "model is driving" indicator when driving', async () => {
    const { container } = await render(<BrowserSurface url="https://x.dev" driving />);
    expect(container.querySelector('.pd-browser-driving')).toBeTruthy();
  });
});
