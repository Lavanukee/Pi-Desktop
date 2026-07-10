import { describe, expect, it } from 'vitest';
import { useLlmStore } from './llm-store';
import { ensureVisionMode, resolveVisionTarget } from './local-model';
import { messageNeedsVision } from './pi-connect';

describe('messageNeedsVision', () => {
  it('is true only when an image attachment is present', () => {
    expect(messageNeedsVision({ imageDataUris: ['data:image/png;base64,AAAA'] })).toBe(true);
    expect(messageNeedsVision({ imageDataUris: [] })).toBe(false);
    expect(messageNeedsVision({})).toBe(false);
  });
});

describe('resolveVisionTarget', () => {
  const catalog = [
    { id: 'gemma-4-e2b-it', vision: true },
    { id: 'nemotron-3-nano-30b-a3b', vision: false },
    { id: 'gemma-4-12b-it', vision: true },
  ];

  it('no-ops when the server is already multimodal (vision is sticky)', () => {
    expect(resolveVisionTarget({ launchMode: 'multimodal', catalog }).action).toBe('already-on');
  });

  it('relaunches the CURRENT model in multimodal when it supports vision', () => {
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      model: { id: 'gemma-4-e2b-it', quant: 'Q4_K_M' },
      catalog,
    });
    expect(d).toEqual({ action: 'relaunch', modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M' });
  });

  it('falls back to a downloaded vision tier pick when the current model is text-only', () => {
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      model: { id: 'nemotron-3-nano-30b-a3b' },
      catalog,
      tierModels: {
        fast: { modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M', vision: true, downloaded: false },
        balanced: { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M', vision: true, downloaded: true },
        intelligent: { modelId: 'qwen', quant: 'Q4_K_M', vision: true, downloaded: false },
      },
    });
    // intelligent + fast are vision but not downloaded → the downloaded balanced wins.
    expect(d).toEqual({ action: 'relaunch', modelId: 'gemma-4-12b-it', quant: 'Q4_K_M' });
  });

  it('returns none when nothing vision-capable is available', () => {
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      model: { id: 'nemotron-3-nano-30b-a3b' },
      catalog,
    });
    expect(d.action).toBe('none');
  });
});

describe('ensureVisionMode — sticky no-op path', () => {
  it('returns already-on (no relaunch) when the server is multimodal', async () => {
    const prev = useLlmStore.getState().status;
    useLlmStore.setState({ status: { ...prev, launchMode: 'multimodal' } });
    const res = await ensureVisionMode();
    expect(res).toEqual({ ok: true, changed: false });
    useLlmStore.setState({ status: prev });
  });
});
