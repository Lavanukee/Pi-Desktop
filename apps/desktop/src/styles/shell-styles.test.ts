import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R14 Lane C — shell + scroll geometry guards.
 *
 * The visual result of these three fixes is owner-validated FEEL, but each rests
 * on a specific CSS contract that a later refactor could silently undo. These
 * tests pin those contracts against apps/desktop global.css:
 *   C1  the collapsed-rail card chrome (bg + flavor edge) moved OFF the
 *       full-height .pd-sidebar shell onto the inner .pd-rail, so the visible
 *       card top drops below the traffic-light strip (shell stays transparent).
 *   C2  the thread scroll HARD-STOPS at its edges — overscroll-behavior:none and
 *       no `.pd-elastic-content` JS rubber-band wrapper remains.
 *   C3  the rail button centers its 40px hover/active wash on the glyph (no
 *       left-anchored padding-left that pushed the wash off to the left).
 */

const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'global.css');
// Strip block comments so quoted values in prose can never match a rule.
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block for the FIRST rule whose selector text contains the
 *  given literal (which is also the first such rule in source order). */
function block(selectorLiteral: string): string {
  const at = css.indexOf(selectorLiteral);
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) return '';
  return css.slice(open + 1, close);
}

describe('R14-C shell + scroll styles', () => {
  describe('C2 — hard-stop scroll', () => {
    it('the thread scroller uses overscroll-behavior:none (no bounce, no chaining)', () => {
      expect(block('.pd-elastic-scroll')).toMatch(/overscroll-behavior:\s*none/);
    });

    it('drops the old elastic containment + JS transform wrapper', () => {
      expect(css).not.toMatch(/overscroll-behavior:\s*contain/);
      // The JS rubber-band rode on `.pd-elastic-content { will-change: transform }`.
      expect(css).not.toContain('.pd-elastic-content');
    });
  });

  describe('C3 — rail button hover wash centering', () => {
    it('centers the 40px button (its wash) in the rail', () => {
      expect(block('.pd-rail-btn ')).toMatch(/justify-content:\s*center/);
    });

    it('no longer left-anchors the glyph with padding-left', () => {
      // The base .pd-rail-btn rule (first `.pd-rail-btn` occurrence) must not
      // re-introduce the left padding that shoved the wash left of the glyph.
      expect(block('.pd-rail-btn ')).not.toMatch(/padding-left/);
    });
  });

  describe('C1 — collapsed rail card chrome moved onto .pd-rail', () => {
    it('the full-height shell is transparent + chrome-less when collapsed', () => {
      const shell = block('.pd-sidebar[data-open="false"]');
      expect(shell).toMatch(/background:\s*transparent/);
      expect(shell).toMatch(/box-shadow:\s*none/);
      // The shell still runs the full height (rail-height contract).
      expect(shell).toMatch(/height:\s*100%/);
    });

    it('the .pd-rail carries the visible card background', () => {
      expect(block('.pd-rail ')).toMatch(/background:\s*var\(--pd-bg-sidebar\)/);
    });

    it('claude gives .pd-rail the floating rounded/bordered card chrome', () => {
      const claudeRail = block(':root[data-flavor="claude"] .pd-rail');
      expect(claudeRail).toMatch(/border-radius/);
      expect(claudeRail).toMatch(/box-shadow/);
    });
  });
});
