/**
 * Unit coverage for the round-10 #20a footer-dropdown restructure rule: the
 * popup surfaces ONLY switch-now models (pi's available models, on-device Apple
 * Intelligence, and DOWNLOADED local models), then a divider + a single "More
 * models" row into the Model Manager. These pure helpers drive that structure.
 */
import { describe, expect, it } from 'vitest';
import { downloadedCatalog, hasSwitchableModel } from './footer-models';

interface Entry {
  id: string;
  downloaded?: boolean;
}

describe('downloadedCatalog (#20a)', () => {
  it('keeps only downloaded entries — the long "download these" list is dropped', () => {
    const catalog: Entry[] = [
      { id: 'a', downloaded: true },
      { id: 'b', downloaded: false },
      { id: 'c' },
      { id: 'd', downloaded: true },
    ];
    expect(downloadedCatalog(catalog).map((e) => e.id)).toEqual(['a', 'd']);
  });

  it('is empty when nothing is downloaded', () => {
    expect(downloadedCatalog([{ id: 'a', downloaded: false }, { id: 'b' }])).toEqual([]);
  });
});

describe('hasSwitchableModel (#20a)', () => {
  it('is true when a pi model, Apple Intelligence, or a downloaded model exists', () => {
    expect(hasSwitchableModel(2, false, 0)).toBe(true);
    expect(hasSwitchableModel(0, true, 0)).toBe(true);
    expect(hasSwitchableModel(0, false, 1)).toBe(true);
  });

  it('is false when there is nothing to switch to (only "More models" shows)', () => {
    expect(hasSwitchableModel(0, false, 0)).toBe(false);
  });
});
