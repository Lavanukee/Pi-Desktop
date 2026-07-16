/**
 * Round-10 #17: every browser-action step gets its OWN glyph in the activity
 * chain (compass/pointer/keyboard/eye) instead of the generic file sheet. These
 * assert the tool-kind → icon mapping at the React-element level (no DOM needed).
 */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  IconClock,
  IconCode,
  IconCompass,
  IconCursor,
  IconEye,
  IconFile,
  IconGlobe,
  IconKeyboard,
  IconPuzzle,
  IconSearch,
  IconSparkles,
  IconTerminal,
} from './icons.tsx';
import { toolIcon } from './tool-icons.tsx';

/** The component function a `toolIcon(...)` element renders. */
const glyphOf = (node: unknown): unknown => (node as ReactElement).type;

describe('toolIcon (round-10 #17 browser glyphs)', () => {
  it('maps each browser action to its own distinct icon', () => {
    expect(glyphOf(toolIcon('browser-navigate'))).toBe(IconCompass);
    expect(glyphOf(toolIcon('browser-click'))).toBe(IconCursor);
    expect(glyphOf(toolIcon('browser-type'))).toBe(IconKeyboard);
    expect(glyphOf(toolIcon('browser-read'))).toBe(IconEye);
  });

  it('does NOT render browser actions as the generic file sheet', () => {
    for (const kind of [
      'browser-navigate',
      'browser-click',
      'browser-type',
      'browser-read',
    ] as const) {
      expect(glyphOf(toolIcon(kind))).not.toBe(IconFile);
    }
  });

  it('leaves the existing non-browser mappings intact', () => {
    expect(glyphOf(toolIcon('read'))).toBe(IconFile);
    expect(glyphOf(toolIcon('bash'))).toBe(IconTerminal);
    expect(glyphOf(toolIcon('search'))).toBe(IconGlobe);
    expect(glyphOf(toolIcon('thinking'))).toBe(IconClock);
  });

  it('maps a skill read to its own sparkle glyph — not the file sheet (Wave B #3a)', () => {
    // No filename badge for a skill: it always reads as the sparkle, never a
    // file-extension tile (contrast `read`, which badges when given a filename).
    expect(glyphOf(toolIcon('skill'))).toBe(IconSparkles);
    expect(glyphOf(toolIcon('skill', 'SKILL.md'))).toBe(IconSparkles);
    expect(glyphOf(toolIcon('skill'))).not.toBe(IconFile);
  });
});

describe('toolIcon (R14 registry glyphs — each tool its own mark)', () => {
  it('gives python / tool-search / generic-tool their OWN distinct glyphs', () => {
    expect(glyphOf(toolIcon('python'))).toBe(IconCode);
    // tool_search reads as a magnifier over the tool registry, NOT the web globe.
    expect(glyphOf(toolIcon('tool-search'))).toBe(IconSearch);
    expect(glyphOf(toolIcon('tool-search'))).not.toBe(IconGlobe);
    // The neutral generic fallback is a puzzle glyph, NEVER the file sheet.
    expect(glyphOf(toolIcon('tool'))).toBe(IconPuzzle);
    expect(glyphOf(toolIcon('tool'))).not.toBe(IconFile);
    // An unknown kind also degrades to the puzzle glyph, never the file sheet.
    expect(glyphOf(toolIcon('nonsense' as never))).not.toBe(IconFile);
  });

  it('renders the injected connector brand SVG inline for the connector kind', () => {
    const branded = renderToStaticMarkup(
      toolIcon('connector', undefined, 16, '<svg data-testid="brand-mark"></svg>') as ReactElement,
    );
    expect(branded).toContain('data-testid="brand-mark"');
    // The brand ink flips on dark surfaces via the shared connector-icon class.
    expect(branded).toContain('pd-connector-icon');
  });

  it('falls the connector kind back to the neutral plug glyph when no brand SVG is injected', () => {
    const fallback = renderToStaticMarkup(toolIcon('connector') as ReactElement);
    // The plug (IconConnector) is a plain stroked svg with no injected brand markup.
    expect(fallback).toContain('<svg');
    expect(fallback).not.toContain('brand-mark');
    expect(fallback).not.toContain('pd-connector-icon');
  });
});
