/**
 * The canonical `mac_*` computer-use tool NAMES, in one dependency-free module
 * (mirrors `@pi-desktop/browser-use/tool-names`).
 *
 * These live apart from {@link ./tools.ts} (which pulls in typebox + the bridge)
 * so other packages — notably `@pi-desktop/harness`'s toolset presets + preload
 * — can import the names WITHOUT dragging in the whole extension. They form one
 * PIPELINE: a snapshot is useless without launch/click/type/key/scroll, so the
 * harness treats them as a peer group (load one ⇒ load all).
 *
 * Exposed as the `@pi-desktop/mac-computer-use/tool-names` subpath; re-exported
 * from `./tools.ts` so the strings have a single source of truth (a rename is a
 * COMPILE error, not a silent runtime miss).
 */

export const MAC_SNAPSHOT_TOOL = 'mac_snapshot';
export const MAC_CLICK_TOOL = 'mac_click';
export const MAC_TYPE_TOOL = 'mac_type';
export const MAC_KEY_TOOL = 'mac_key';
export const MAC_SCROLL_TOOL = 'mac_scroll';
export const MAC_LAUNCH_TOOL = 'mac_launch';
/* Chrome, driven through its DOM rather than its pixels — the user's OWN Chrome,
 * with their sessions. See ./chrome.ts for why this beats sighted clicking. */
export const CHROME_SNAPSHOT_TOOL = 'chrome_snapshot';
export const CHROME_CLICK_TOOL = 'chrome_click';
export const CHROME_TYPE_TOOL = 'chrome_type';
export const CHROME_GO_TOOL = 'chrome_go';

/** Every `mac_*` computer-use tool name — the full background-control pipeline. */
export const MAC_COMPUTER_USE_TOOL_NAMES = [
  MAC_LAUNCH_TOOL,
  MAC_SNAPSHOT_TOOL,
  MAC_CLICK_TOOL,
  MAC_TYPE_TOOL,
  MAC_KEY_TOOL,
  MAC_SCROLL_TOOL,
  CHROME_SNAPSHOT_TOOL,
  CHROME_CLICK_TOOL,
  CHROME_TYPE_TOOL,
  CHROME_GO_TOOL,
] as const;
