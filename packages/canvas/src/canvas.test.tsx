import { describe, expect, it, vi } from 'vitest';
import { Canvas } from './canvas.tsx';
import type { Artifact } from './model.ts';
import { click, render } from './test-utils.tsx';

const notes: Artifact = {
  id: 'm',
  title: 'Notes',
  content: { kind: 'markdown', text: '# Hello\n\nworld' },
};

describe('Canvas', () => {
  it('renders the resolved surface inside ArtifactPanel chrome', async () => {
    const { container } = await render(<Canvas artifact={notes} />);
    expect(container.querySelector('.pd-artifact')).toBeTruthy();
    expect(container.textContent).toContain('Notes');
    expect(container.querySelector('.pd-canvas-markdown h1')?.textContent).toBe('Hello');
    expect(container.querySelector('[aria-label="Copy"]')).toBeTruthy();
  });

  it('toggles the raw source view', async () => {
    const { container } = await render(<Canvas artifact={notes} />);
    expect(container.querySelector('.pd-canvas-raw')).toBeNull();
    await click(container.querySelector('[aria-label="Show source"]'));
    expect(container.querySelector('.pd-canvas-raw')).toBeTruthy();
    expect(container.querySelector('.pd-canvas-markdown')).toBeNull();
  });

  it('shows an error state for an unregistered kind', async () => {
    const { container } = await render(
      <Canvas artifact={{ id: 'z', content: { kind: 'hologram', text: 'x' } }} />,
    );
    expect(container.textContent).toContain('No canvas surface is registered');
  });

  it('emits onCopy and onPopOut', async () => {
    const onCopy = vi.fn();
    const onPopOut = vi.fn();
    const { container } = await render(
      <Canvas artifact={notes} onCopy={onCopy} onPopOut={onPopOut} />,
    );
    await click(container.querySelector('[aria-label="Copy"]'));
    expect(onCopy).toHaveBeenCalledWith('# Hello\n\nworld');
    await click(container.querySelector('[aria-label="Open in new window"]'));
    expect(onPopOut).toHaveBeenCalledWith(notes);
  });

  it('renders an SVG artifact sanitized', async () => {
    const { container } = await render(
      <Canvas
        artifact={{
          id: 's',
          content: {
            kind: 'svg',
            text: '<svg><script>x</script><rect width="10" height="10"></rect></svg>',
          },
        }}
        streaming={false}
      />,
    );
    expect(container.querySelector('.pd-canvas-svg rect')).toBeTruthy();
    expect(container.querySelector('.pd-canvas-svg script')).toBeNull();
  });
});
