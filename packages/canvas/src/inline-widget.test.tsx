import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { InlineWidget, shouldGoToCanvas } from './inline-widget.tsx';
import type { Artifact } from './model.ts';
import { click, render } from './test-utils.tsx';

const svg: Artifact = { id: 'w', content: { kind: 'svg', text: '<svg></svg>' } };

describe('shouldGoToCanvas', () => {
  it('sends non-simple kinds to the canvas', () => {
    expect(shouldGoToCanvas({ id: 'a', content: { kind: 'pdf', text: '' } })).toBe(true);
    expect(shouldGoToCanvas({ id: 'a', content: { kind: 'code', text: 'x' } })).toBe(true);
  });
  it('keeps small svg/html inline but sends oversized ones to the canvas', () => {
    expect(shouldGoToCanvas(svg)).toBe(false);
    const big: Artifact = { id: 'b', content: { kind: 'html', text: 'x'.repeat(5000) } };
    expect(shouldGoToCanvas(big)).toBe(true);
    expect(shouldGoToCanvas(big, { maxInlineChars: 10000 })).toBe(false);
  });
});

describe('InlineWidget', () => {
  it('emits onMoveToCanvas from the move button', async () => {
    const onMoveToCanvas = vi.fn();
    const { container } = await render(
      <InlineWidget artifact={svg} onMoveToCanvas={onMoveToCanvas}>
        <div>widget</div>
      </InlineWidget>,
    );
    await click(container.querySelector('[aria-label="Move to canvas"]'));
    expect(onMoveToCanvas).toHaveBeenCalledWith(svg);
  });

  it('is size-capped and never scrollable', async () => {
    const { container } = await render(
      <InlineWidget artifact={svg} maxHeight={200}>
        <div>widget</div>
      </InlineWidget>,
    );
    const box = container.querySelector<HTMLElement>('.pd-inline-widget-box');
    expect(box?.style.maxHeight).toBe('200px');
    expect(box?.style.overflow).toBe('hidden');
  });

  it('surfaces an "Open in canvas" affordance instead of scrolling when overflowing', async () => {
    const onMoveToCanvas = vi.fn();
    const { container } = await render(
      <InlineWidget artifact={svg} maxHeight={200} onMoveToCanvas={onMoveToCanvas}>
        <div>tall widget</div>
      </InlineWidget>,
    );
    const box = container.querySelector<HTMLElement>('.pd-inline-widget-box');
    if (!box) throw new Error('missing box');
    // Simulate content taller than the cap (jsdom has zero layout by default).
    Object.defineProperty(box, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true });
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    const open = container.querySelector('.pd-inline-widget-open');
    expect(open).toBeTruthy();
    await click(open);
    expect(onMoveToCanvas).toHaveBeenCalledWith(svg);
  });
});
