import { describe, expect, it } from 'vitest';
import { bobbleHome, slug, uniqueName } from './bobble-paths.js';

/*
 * jedd: "no complicated var/askldfjh;lkh/asdjkgbm,3241/1324iu1b types of things."
 * What the app produced: /var/folders/4h/nq1c73…/T/pi-generated/
 * gen_1785566138272_fc7490/frame_000.png
 */
describe('bobble paths are readable', () => {
  it('puts everything under one visible folder', () => {
    expect(bobbleHome('/Users/jedd')).toBe('/Users/jedd/Bobble');
  });

  it('slugs a url to something typeable', () => {
    expect(slug('https://example.com/')).toBe('example-com');
    expect(slug('Example Domain')).toBe('example-domain');
    expect(slug('BOBBLE sliding in from the left')).toBe('bobble-sliding-in-from-the-left');
  });

  it('never emits punctuation, spaces or repeated hyphens', () => {
    expect(slug('a/b\\c:d*e?f "g" <h>|i')).toMatch(/^[a-z0-9-]+$/);
    expect(slug('lots   of    spaces')).toBe('lots-of-spaces');
    expect(slug('trailing---')).toBe('trailing');
  });

  it('falls back rather than producing an empty name', () => {
    expect(slug('!!!', 'animation')).toBe('animation');
    expect(slug('')).toBe('untitled');
  });

  /* A counter, not a timestamp — the point is that a person can read it back and
   * type it. "animation-2" is a name; "gen_1785566138272_fc7490" is not. */
  it('deduplicates with a counter', () => {
    const taken = new Set(['/g/animation', '/g/animation-2']);
    expect(uniqueName('/g', 'animation', (p) => taken.has(p))).toBe('animation-3');
  });

  it('uses the plain name when it is free', () => {
    expect(uniqueName('/g', 'animation', () => false)).toBe('animation');
  });
});
