import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_GEN_ACTIONS,
  ComposerAddMenu,
  type GenActionHandlers,
  type GenActionKey,
  selectGenAction,
} from './add-menu.tsx';

/**
 * ComposerAddMenu modality force-actions (spec §3.2). The menu content lives in a
 * Radix portal (no server DOM), so the render assertions target the descriptor
 * list the menu maps over, and the dispatch behavior is verified through the same
 * pure `selectGenAction` the rows call.
 */
describe('ComposerAddMenu — gen block descriptors', () => {
  it('renders the four modality force-actions, in order', () => {
    expect(COMPOSER_GEN_ACTIONS.map((a) => a.key)).toEqual([
      'image',
      'video',
      'motion',
      'perception',
    ]);
    expect(COMPOSER_GEN_ACTIONS.map((a) => a.label)).toEqual([
      'Generate image',
      'Generate video',
      'Motion graphics',
      'Find / segment in image or video',
    ]);
  });

  it('gives every row a unique, stable test id', () => {
    const ids = COMPOSER_GEN_ACTIONS.map((a) => a.testid);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('add-generate-video');
  });
});

describe('selectGenAction — a selected row invokes its callback', () => {
  function spies(): Required<GenActionHandlers> {
    return {
      onGenerateImage: vi.fn(),
      onGenerateVideo: vi.fn(),
      onGenerateMotion: vi.fn(),
      onPerception: vi.fn(),
    };
  }

  const cases: [GenActionKey, keyof GenActionHandlers][] = [
    ['image', 'onGenerateImage'],
    ['video', 'onGenerateVideo'],
    ['motion', 'onGenerateMotion'],
    ['perception', 'onPerception'],
  ];

  for (const [key, handler] of cases) {
    it(`${key} → ${handler} (and only that one)`, () => {
      const h = spies();
      selectGenAction(key, h);
      expect(h[handler]).toHaveBeenCalledTimes(1);
      for (const other of Object.keys(h) as (keyof GenActionHandlers)[]) {
        if (other !== handler) expect(h[other]).not.toHaveBeenCalled();
      }
    });
  }

  it('is a no-op (never throws) when the handler is absent', () => {
    expect(() => selectGenAction('video', {})).not.toThrow();
  });
});

describe('ComposerAddMenu — render smoke', () => {
  it('renders with the gen-action props wired (trigger present, no throw)', () => {
    const html = renderToStaticMarkup(
      <ComposerAddMenu
        variant="full"
        onGenerateImage={() => {}}
        onGenerateVideo={() => {}}
        onGenerateMotion={() => {}}
        onPerception={() => {}}
      />,
    );
    // The trigger renders in the document; the portalled content does not on the
    // server, so we only assert the mount succeeded.
    expect(html).toContain('pd-menu-trigger');
  });
});
