import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { click, render } from '../test-utils.tsx';
import {
  isAudioType,
  isVideoType,
  MediaPreviewSurface,
  mediaPreviewTransition,
} from './media-preview-surface.tsx';

/** Fire a non-bubbling media event React attaches directly to the element. */
async function fire(element: Element | null, type: 'load' | 'error' | 'loadeddata'): Promise<void> {
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

describe('isVideoType', () => {
  it('matches video subtypes/kinds and rejects images + pdf', () => {
    for (const t of ['mp4', 'MOV', 'webm', 'video', 'quicktime']) {
      expect(isVideoType(t)).toBe(true);
    }
    for (const t of ['png', 'JPEG', 'svg', 'pdf', 'gif']) {
      expect(isVideoType(t)).toBe(false);
    }
  });
});

describe('isAudioType', () => {
  it('matches audio subtypes/kinds and rejects video + images', () => {
    for (const t of ['mp3', 'WAV', 'audio', 'flac', 'm4a', 'aac']) {
      expect(isAudioType(t)).toBe(true);
    }
    for (const t of ['mp4', 'MOV', 'png', 'pdf', 'video']) {
      expect(isAudioType(t)).toBe(false);
    }
  });
});

describe('MediaPreviewSurface (body-only)', () => {
  it('renders an <audio> element (not <img>/<video>) for an audio type', async () => {
    const { container } = await render(<MediaPreviewSurface src="song.mp3" type="MP3" />);
    expect(container.querySelector('audio')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    // `loadeddata` → loaded: spinner gone, audio visible.
    await fire(container.querySelector('audio'), 'loadeddata');
    expect(container.querySelector('.pd-media-status')).toBeNull();
    expect(container.querySelector('audio')?.hasAttribute('hidden')).toBe(false);
  });

  it('runs loading → error → retry(loading) → loaded', async () => {
    const { container } = await render(<MediaPreviewSurface src="a.png" type="png" index={2} />);
    // The header (name · TYPE + download) lives in the operation bar now.
    expect(container.querySelector('.pd-media-title')).toBeNull();
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

  it('honors a controlled status prop', async () => {
    const { container } = await render(
      <MediaPreviewSurface src="a.pdf" type="PDF" status="error" />,
    );
    expect(container.querySelector('.pd-media-error-title')?.textContent).toBe(
      'Failed to load file content',
    );
  });

  it('self-manages error (never a dead spinner) when src is missing', async () => {
    const { container } = await render(<MediaPreviewSurface type="PNG" />);
    expect(container.querySelector('.pd-media-status')).toBeNull();
    expect(container.querySelector('.pd-media-error-title')?.textContent).toBe(
      'Failed to load file content',
    );
  });

  it('renders a <video> (not <img>) for a video type and drives its load state', async () => {
    const { container } = await render(<MediaPreviewSurface src="clip.mp4" type="MP4" />);
    // A video element is used — never an img/iframe — and starts loading.
    expect(container.querySelector('video')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.pd-media-status')).toBeTruthy();

    // `loadeddata` → loaded: spinner gone, video visible.
    await fire(container.querySelector('video'), 'loadeddata');
    expect(container.querySelector('.pd-media-status')).toBeNull();
    expect(container.querySelector('video')?.hasAttribute('hidden')).toBe(false);
  });

  it('shows the error panel when the video element errors', async () => {
    const { container } = await render(<MediaPreviewSurface src="clip.webm" type="WEBM" />);
    await fire(container.querySelector('video'), 'error');
    expect(container.querySelector('.pd-media-error-title')?.textContent).toBe(
      'Failed to load file content',
    );
  });

  it('re-keys the media element back to loading when reloadNonce changes', async () => {
    // The operation bar's Refresh bumps reloadNonce to reload the same src.
    const { container, rerender } = await render(
      <MediaPreviewSurface src="a.png" type="PNG" reloadNonce={0} />,
    );
    await fire(container.querySelector('img'), 'load');
    expect(container.querySelector('.pd-media-status')).toBeNull();
    // Bump the nonce → back to loading (fresh element).
    await rerender(<MediaPreviewSurface src="a.png" type="PNG" reloadNonce={1} />);
    expect(container.querySelector('.pd-media-status')).toBeTruthy();
  });
});
