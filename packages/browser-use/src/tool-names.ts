/**
 * The canonical `browser_*` tool NAMES, in one dependency-free module.
 *
 * These are the single source of truth for the browser tool identifiers. They
 * live apart from {@link ./tools.ts} (which pulls in typebox + the bridge) so
 * other packages — notably `@pi-desktop/harness`'s toolset presets — can import
 * the names WITHOUT dragging in the whole extension. Importing the constant (vs.
 * hand-typing the string) makes a rename a COMPILE error instead of a silent
 * runtime miss (round-10 bug #9: the browser preset had drifted to non-existent
 * `browser_eval`/`browser_screenshot` names and omitted `browser_snapshot`).
 *
 * Re-exported from `./tools.ts` and the package root, and exposed as the
 * `@pi-desktop/browser-use/tool-names` subpath for cheap name-only imports.
 */

export const BROWSER_NAVIGATE_TOOL = 'browser_navigate';
export const BROWSER_SNAPSHOT_TOOL = 'browser_snapshot';
export const BROWSER_CLICK_TOOL = 'browser_click';
export const BROWSER_TYPE_TOOL = 'browser_type';
export const BROWSER_SCROLL_TOOL = 'browser_scroll';
export const BROWSER_READ_TOOL = 'browser_read';
export const BROWSER_WAIT_TOOL = 'browser_wait';
export const BROWSER_BACK_TOOL = 'browser_back';
export const BROWSER_FORWARD_TOOL = 'browser_forward';
export const BROWSER_KEY_TOOL = 'browser_key';

/**
 * Every registered browser tool name, in the order a perceive→act flow wants
 * them (navigate → SNAPSHOT (the model's eyes) → click/type/scroll/read → …).
 * The harness browser preset is built from this list.
 */
export const BROWSER_TOOL_NAMES = [
  BROWSER_NAVIGATE_TOOL,
  BROWSER_SNAPSHOT_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_READ_TOOL,
  BROWSER_WAIT_TOOL,
  BROWSER_BACK_TOOL,
  BROWSER_FORWARD_TOOL,
  BROWSER_KEY_TOOL,
] as const;
