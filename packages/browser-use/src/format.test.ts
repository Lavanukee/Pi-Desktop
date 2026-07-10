import { describe, expect, it } from 'vitest';
import { formatSnapshot } from './format.js';
import type { PageSnapshot } from './perception.js';

function snapshot(
  over: Partial<PageSnapshot['summary']> = {},
  elements: PageSnapshot['elements'] = [],
): PageSnapshot {
  return {
    ok: true,
    elements,
    summary: {
      title: 'Example',
      url: 'https://example.test/',
      headings: ['Big heading'],
      landmarks: ['main', 'nav'],
      scrollY: 0,
      maxScrollY: 0,
      atBottom: true,
      elementCount: elements.length,
      truncated: false,
      canvasHeavy: false,
      ...over,
    },
  };
}

describe('formatSnapshot', () => {
  it('renders one addressable line per element with role/name/markers', () => {
    const text = formatSnapshot(
      snapshot({}, [
        {
          index: 1,
          role: 'link',
          name: 'Docs',
          bbox: { x: 1, y: 1, w: 1, h: 1 },
          href: 'x',
          inViewport: true,
        },
        {
          index: 2,
          role: 'textbox',
          name: 'Search',
          bbox: { x: 1, y: 1, w: 1, h: 1 },
          editable: true,
          value: 'hi',
          inViewport: false,
        },
      ]),
    );
    expect(text).toContain('[1] link "Docs"');
    expect(text).toContain('[2] textbox "Search" = "hi" (editable, below fold)');
    expect(text).toContain('Landmarks: main, nav');
    expect(text).toContain('Page: "Example"');
  });

  it('notes truncation and canvas-heavy pages', () => {
    const text = formatSnapshot(
      snapshot({ truncated: true, elementCount: 99, canvasHeavy: true }, []),
    );
    expect(text).toContain('canvas/WebGL-heavy');
    expect(text).toContain('of 99 interactive elements shown');
    expect(text).toContain('no interactive elements found');
  });
});
