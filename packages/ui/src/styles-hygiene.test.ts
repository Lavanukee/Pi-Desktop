import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the W1R contract: component CSS consumes ONLY --pd-* tokens (plus
 * Radix-provided vars); no raw colors sneak in past the theme system.
 */

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'styles');
const files = readdirSync(stylesDir).filter((f) => f.endsWith('.css'));

// The single sanctioned literal: the iOS-style switch thumb is white in both
// reference apps and both modes (spec-settings), like claude's black-glass
// tooltip — but the tooltip IS tokenized (--pd-tooltip-*), the thumb is not.
const ALLOWED_LITERALS: Record<string, string[]> = {
  'controls.css': ['#fff'],
};

describe('styles hygiene', () => {
  it('has css files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    // Spec citations in comments may quote raw values; only rules count.
    const css = readFileSync(path.join(stylesDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    it(`${file} contains no raw hex/rgb/hsl colors`, () => {
      const allowed = ALLOWED_LITERALS[file] ?? [];
      const hexes = (css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter(
        (hex) => !allowed.includes(hex),
      );
      expect(hexes, `raw hex colors in ${file}`).toEqual([]);
      expect(css, `raw rgb()/hsl() in ${file}`).not.toMatch(/(?:rgb|hsl)a?\(/);
    });

    it(`${file} only references --pd-* / --radix-* custom properties`, () => {
      const refs = css.match(/var\(\s*--[a-z0-9-]+/gi) ?? [];
      for (const ref of refs) {
        expect(ref, `var reference in ${file}`).toMatch(/var\(\s*--(pd|radix)-/);
      }
    });
  }
});
