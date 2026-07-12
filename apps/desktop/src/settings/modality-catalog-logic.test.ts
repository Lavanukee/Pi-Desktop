import { describe, expect, it } from 'vitest';
import type { ModalityCatalogEntry } from '../../electron/gen/gen-ipc-contract';
import {
  categoryLabel,
  categoryOf,
  entriesForCategory,
  formatApproxSize,
  MODALITY_CATEGORIES,
  MODALITY_SPEED_LABEL,
  modalityRequiresGate,
  modalitySpeed,
} from './modality-catalog-logic';

function entry(over: Partial<ModalityCatalogEntry>): ModalityCatalogEntry {
  return {
    id: 'x',
    modality: 'image',
    label: 'X',
    backend: 'mflux',
    license: 'apache-2.0',
    commercialUse: true,
    approxSizeGB: 4,
    runsLocally: true,
    heavy: false,
    reserved: false,
    recommended: false,
    ...over,
  };
}

describe('categoryOf', () => {
  it('maps image/video/3d straight through', () => {
    expect(categoryOf(entry({ modality: 'image' }))).toBe('image');
    expect(categoryOf(entry({ modality: 'video' }))).toBe('video');
    expect(categoryOf(entry({ modality: '3d' }))).toBe('3d');
  });

  it('splits audio into TTS (audio) vs ComfyUI synthesis (music)', () => {
    expect(categoryOf(entry({ modality: 'audio', backend: 'mlx-audio' }))).toBe('audio');
    expect(categoryOf(entry({ modality: 'audio', backend: 'torch-tts' }))).toBe('audio');
    expect(categoryOf(entry({ modality: 'audio', backend: 'comfyui' }))).toBe('music');
  });
});

describe('entriesForCategory', () => {
  it('filters by category and puts recommended first, then smallest, then name', () => {
    const entries: ModalityCatalogEntry[] = [
      entry({ id: 'big', modality: 'image', approxSizeGB: 24, recommended: false }),
      entry({ id: 'rec-large', modality: 'image', approxSizeGB: 10, recommended: true }),
      entry({ id: 'rec-small', modality: 'image', approxSizeGB: 3, recommended: true }),
      entry({ id: 'small', modality: 'image', approxSizeGB: 2, recommended: false }),
      entry({ id: 'audio-1', modality: 'audio', backend: 'mlx-audio' }),
    ];
    const ordered = entriesForCategory(entries, 'image').map((e) => e.id);
    expect(ordered).toEqual(['rec-small', 'rec-large', 'small', 'big']);
    // The audio entry is excluded from the image grid.
    expect(ordered).not.toContain('audio-1');
  });

  it('does not mutate the input array', () => {
    const entries = [entry({ id: 'a', approxSizeGB: 5 }), entry({ id: 'b', approxSizeGB: 1 })];
    const snapshot = entries.map((e) => e.id);
    entriesForCategory(entries, 'image');
    expect(entries.map((e) => e.id)).toEqual(snapshot);
  });
});

describe('modalityRequiresGate', () => {
  it('gates exactly the non-commercial rows', () => {
    expect(modalityRequiresGate(entry({ commercialUse: false }))).toBe(true);
    expect(modalityRequiresGate(entry({ commercialUse: true }))).toBe(false);
  });
});

describe('formatApproxSize', () => {
  it('renders a weightless model honestly', () => {
    expect(formatApproxSize(0)).toBe('No weights');
  });

  it('renders sizes with a tilde', () => {
    expect(formatApproxSize(3.5)).toBe('~3.5 GB');
    expect(formatApproxSize(24)).toBe('~24 GB');
  });
});

describe('modalitySpeed', () => {
  it('marks GPU-heavy diffusion/video backends slow regardless of size', () => {
    expect(modalitySpeed(entry({ heavy: true, approxSizeGB: 8 }))).toBe('slow');
    // heavy wins even for a tiny footprint.
    expect(modalitySpeed(entry({ heavy: true, approxSizeGB: 1 }))).toBe('slow');
  });

  it('calls tiny light models fast', () => {
    expect(modalitySpeed(entry({ heavy: false, approxSizeGB: 0.3 }))).toBe('fast');
    expect(modalitySpeed(entry({ heavy: false, approxSizeGB: 4 }))).toBe('fast');
  });

  it('calls mid-footprint light models balanced', () => {
    expect(modalitySpeed(entry({ heavy: false, approxSizeGB: 4.3 }))).toBe('balanced');
    expect(modalitySpeed(entry({ heavy: false, approxSizeGB: 9 }))).toBe('balanced');
  });

  it('calls genuinely large light models slow', () => {
    expect(modalitySpeed(entry({ heavy: false, approxSizeGB: 12 }))).toBe('slow');
    expect(modalitySpeed(entry({ heavy: false, approxSizeGB: 20 }))).toBe('slow');
  });

  it('has a capitalised label for every speed word', () => {
    expect(MODALITY_SPEED_LABEL.fast).toBe('Fast');
    expect(MODALITY_SPEED_LABEL.balanced).toBe('Balanced');
    expect(MODALITY_SPEED_LABEL.slow).toBe('Slow');
  });
});

describe('MODALITY_CATEGORIES', () => {
  it('covers the six browser categories with labels', () => {
    expect(MODALITY_CATEGORIES.map((c) => c.id)).toEqual([
      'image',
      'video',
      'audio',
      'music',
      '3d',
      'perception',
    ]);
    expect(categoryLabel('3d')).toBe('3D');
    expect(categoryLabel('music')).toBe('Music');
  });
});
