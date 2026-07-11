import { describe, expect, it } from 'vitest';
import { GenImageSurface, type GenImageSurfaceData, modelFootnote } from './gen-image-surface.tsx';
import { genImageContent, parseGenImageData } from './register.tsx';
import { render } from './test-utils.tsx';

const MODEL = { id: 'z-image-turbo', label: 'Z-Image Turbo', license: 'apache-2.0' };

function data(overrides: Partial<GenImageSurfaceData> = {}): GenImageSurfaceData {
  return {
    model: MODEL,
    prompt: 'a red origami crane',
    status: 'done',
    candidates: [{ seed: 42, finalSrc: 'a.png', status: 'done' }],
    ...overrides,
  };
}

describe('modelFootnote', () => {
  it('formats label · id · license', () => {
    expect(modelFootnote(MODEL)).toBe('Z-Image Turbo · z-image-turbo · apache-2.0');
  });
});

describe('GenImageSurface', () => {
  it('renders a candidate grid with the final images', async () => {
    const { container } = await render(
      <GenImageSurface
        data={data({
          candidates: [
            { seed: 1, finalSrc: 'a.png', status: 'done' },
            { seed: 2, finalSrc: 'b.png', status: 'done' },
          ],
        })}
      />,
    );
    const imgs = container.querySelectorAll('img.pd-gen-cell-img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]?.getAttribute('src')).toBe('a.png');
    expect(container.querySelector('.pd-gen-grid')?.getAttribute('data-count')).toBe('2');
  });

  it('stamps the model FOOTNOTE on every output and in the footer', async () => {
    const { container } = await render(<GenImageSurface data={data()} />);
    // Per-cell footnote.
    const caption = container.querySelector('.pd-gen-cell-footnote')?.textContent ?? '';
    expect(caption).toContain('seed 42');
    expect(caption).toContain('z-image-turbo');
    expect(caption).toContain('apache-2.0');
    // Footer footnote.
    expect(container.querySelector('.pd-gen-footer')?.textContent).toContain(
      'Z-Image Turbo · z-image-turbo · apache-2.0',
    );
  });

  it('shows a live progress bar with step label while generating', async () => {
    const { container } = await render(
      <GenImageSurface
        data={data({
          status: 'generating',
          progress: { candidate: 0, step: 3, total: 6 },
          candidates: [{ seed: 42, previewSrc: 'live.png', status: 'generating' }],
        })}
      />,
    );
    const bar = container.querySelector('.pd-gen-progress');
    expect(bar).toBeTruthy();
    expect(bar?.getAttribute('aria-valuenow')).toBe('50'); // 1 candidate → 3/6 = 50%
    expect(container.querySelector('.pd-gen-progress-label')?.textContent).toContain('step 3/6');
    // The live preview uses the composite and is flagged live.
    const img = container.querySelector('img.pd-gen-cell-img');
    expect(img?.getAttribute('src')).toBe('live.png');
    expect(img?.getAttribute('data-live')).toBe('true');
  });

  it('renders a spinner placeholder for a pending candidate (no src yet)', async () => {
    const { container } = await render(
      <GenImageSurface
        data={data({ status: 'generating', candidates: [{ seed: 1, status: 'pending' }] })}
      />,
    );
    expect(container.querySelector('.pd-gen-cell-placeholder')).toBeTruthy();
    expect(container.querySelector('img.pd-gen-cell-img')).toBeNull();
  });

  it('shows an error banner on failure', async () => {
    const { container } = await render(
      <GenImageSurface
        data={data({ status: 'error', error: 'metal out of memory', candidates: [] })}
      />,
    );
    expect(container.querySelector('.pd-gen-error')?.textContent).toBe('metal out of memory');
  });
});

describe('genImageContent / parseGenImageData round-trip', () => {
  it('encodes to a gen-image artifact and decodes back', () => {
    const content = genImageContent(data());
    expect(content.kind).toBe('gen-image');
    const back = parseGenImageData(content);
    expect(back?.model.id).toBe('z-image-turbo');
    expect(back?.candidates[0]?.finalSrc).toBe('a.png');
  });

  it('returns null for non-JSON or malformed payloads', () => {
    expect(parseGenImageData({ kind: 'gen-image', text: 'not json' })).toBeNull();
    expect(parseGenImageData({ kind: 'gen-image', text: '{"candidates":[]}' })).toBeNull();
    expect(parseGenImageData({ kind: 'gen-image', text: '{"model":{"id":"x"}}' })).toBeNull();
  });
});
