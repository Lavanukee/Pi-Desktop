/**
 * The DELIVERY SHAPE — the product's delivery constraint, derived from the vision
 * text (spec §4 the vision, §5 the integration layer, §8 the tester gate).
 *
 * WHY this exists (the real-run finding it fixes): a vision can carry a hard
 * DELIVERY constraint — "a playable Snake game — ONE index.html that opens directly
 * in a browser without Node.js/npm/build" — that must reach the DECOMPOSITION, or
 * the architect will happily choose a bundler-dependent module graph that can never
 * open directly. Nothing threaded that constraint through, so the corp produced 27
 * cross-importing TS modules and NO openable entry. This module extracts the shape
 * from the vision so the architect prompt (architect.ts) and the guaranteed
 * integration contract (integration-contract.ts) can STEER toward a self-contained,
 * openable entry instead of a build-only module graph.
 *
 * Deliberately a LIGHT, robust signal (spec §0.6 "robustness is external"): a few
 * tolerant regexes over the vision text, never a hardcoded "snake"/"index.html".
 * Pure + deterministic; never throws.
 */

/**
 * The delivery constraint a vision implies for the finished product.
 * - {@link openableSingleFile} — the product must be a SINGLE artifact a browser
 *   opens DIRECTLY: no build, no bundler, no npm/Node, no dev server (the vision
 *   says "opens in a browser", "no build", "single file", "one index.html", …).
 *   Implies {@link web}.
 * - {@link web} — the product is a browser/web artifact (renderable in a browser).
 */
export interface DeliveryShape {
  readonly openableSingleFile: boolean;
  readonly web: boolean;
}

/** The vision explicitly forbids a build step / toolchain ("without build", "no
 * bundler", "no npm/Node", "buildless", "no compile/install"). */
const NO_BUILD_SIGNAL =
  /\b(?:no|without|zero|not?\s+(?:any|a))[\s-]*(?:build(?:\s*step|\s*tools?|\s*process)?|bundler|bundling|webpack|vite|rollup|esbuild|npm|node(?:\.?js)?|toolchain|compil\w*|transpil\w*|install\s*step|package\s*manager)\b|\bbuildless\b|\bno-?build\b/i;

/** The vision demands a single/self-contained/directly-openable artifact ("single
 * file", "one index.html", "self-contained", "opens directly", "double-click",
 * "static html", "no server"). */
const SINGLE_FILE_SIGNAL =
  /\bsingle[\s-]*(?:file|html|page)\b|\bone[\s-]+(?:single[\s-]+)?(?:index\.html|html\s*file|file)\b|\bself[\s-]?contained\b|\bstand[\s-]?alone\b|\bopens?\s+(?:directly|straight|right\s+up|in\s+(?:a|the)\s+browser)\b|\bopenable\b|\bdouble[\s-]?clic\w*\b|\bjust\s+open\b|\bstatic\s+html\b|\bno\s+(?:web\s+)?server\b|\bwithout\s+(?:a\s+)?server\b/i;

/** The vision describes a browser/web artifact ("browser", "web page", "html",
 * "index.html", "css", "DOM", "canvas", "front-end", "SPA"). */
const WEB_SIGNAL =
  /\b(?:browser|web[\s-]?page|web[\s-]?site|web[\s-]?app|web[\s-]?based|webgl|html5?|index\.html|css|dom|canvas|front[\s-]?end|single[\s-]?page\s+app|spa)\b/i;

/**
 * Derive the {@link DeliveryShape} from a vision (or task) string — a light,
 * tolerant signal, never a hardcoded product name. `openableSingleFile` fires when
 * the vision forbids a build OR demands a single/self-contained/directly-openable
 * artifact; `web` fires for any browser/web signal (and is implied by
 * `openableSingleFile`). Pure; never throws; a blank/neutral vision yields
 * `{ openableSingleFile: false, web: false }`.
 */
export function deriveDeliveryShape(vision: string): DeliveryShape {
  const text = typeof vision === 'string' ? vision : '';
  const openableSingleFile = NO_BUILD_SIGNAL.test(text) || SINGLE_FILE_SIGNAL.test(text);
  const web = openableSingleFile || WEB_SIGNAL.test(text);
  return { openableSingleFile, web };
}

/**
 * The delivery-constraint prompt lines to splice into a role turn (the architect —
 * architect.ts — and the integration contract's brief — integration-contract.ts).
 * Returns `[]` for a neutral shape, so a caller that always splices these is a no-op
 * unless the vision genuinely demands a self-contained openable deliverable. Pure
 * string composition.
 */
export function deliveryConstraintLines(shape: DeliveryShape): string[] {
  if (!shape.openableSingleFile) return [];
  return [
    'DELIVERY CONSTRAINT (from the vision): the finished product must be a SINGLE artifact a browser opens DIRECTLY — double-click the entry file and it runs. NO build step, NO bundler, NO npm/Node, NO dev server.',
    'Do NOT design a bundler-dependent module graph (bare import specifiers that only resolve after a build). Make the entry SELF-CONTAINED: inline the scripts/styles, use <script type="module"> with RELATIVE paths that resolve straight from the filesystem, or an import map — something that opens and runs with no toolchain.',
  ];
}
