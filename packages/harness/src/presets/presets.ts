/**
 * Toolset presets: map each task class → a preset tool list.
 *
 * On classification the harness calls `pi.setActiveTools(resolved)` so the model
 * only sees the tools relevant to the task (never the full registry at once).
 *
 * Presets declare *desired* tool names. Many category tools (image/video/3d gen,
 * browser automation) do not exist in v0.1, so {@link resolvePresetTools}
 * intersects the desired list with the tools actually registered in the session
 * and always keeps `tool_search` available. Categories whose tools are not yet
 * present therefore degrade gracefully to tool-search-only.
 */

import type { TaskClass } from '../classify/classify.js';

/** The always-available tool-search tool name. */
export const TOOL_SEARCH_TOOL_NAME = 'tool_search';

// Common tool clusters (built-in pi tools + this repo's web-tools/gen tools).
const CORE_FS = ['read', 'write', 'edit', 'ls', 'find', 'grep'] as const;
const WEB = ['web_search', 'web_fetch'] as const;
const PYTHON = ['python_run'] as const;
const BROWSER = [
  'browser_navigate',
  'browser_click',
  'browser_eval',
  'browser_screenshot',
] as const;
const IMAGE_GEN = ['image_generate', 'image_edit'] as const;
const VIDEO_GEN = ['video_generate', 'video_edit'] as const;
const MOTION_GEN = ['motion_graphics_render'] as const;
const THREE_D_GEN = ['model_3d_generate', 'model_3d_view'] as const;

/**
 * Desired preset tool lists per class. `tool_search` is appended by
 * {@link resolvePresetTools} and omitted here to keep the intent readable.
 */
export const PRESET_TOOLS: Record<TaskClass, readonly string[]> = {
  // Tiers.
  'simple-QA': [],
  'basic-tools': [...PYTHON, ...WEB],
  'full-shebang': [...CORE_FS, 'bash', ...WEB, ...PYTHON],
  // Categories.
  coding: [...CORE_FS, 'bash', ...PYTHON],
  'file-ops': [...CORE_FS, 'bash'],
  'browser-use': [...BROWSER, 'web_fetch', 'read'],
  'motion-graphics': [...MOTION_GEN, ...IMAGE_GEN],
  'advanced-video': [...VIDEO_GEN, ...IMAGE_GEN],
  '3d': [...THREE_D_GEN, ...IMAGE_GEN],
  '2d-art': [...IMAGE_GEN],
  // 'other' → tool-search-only (empty desired list; tool_search still appended).
  other: [],
};

export interface ResolvePresetOptions {
  /**
   * Keep tool_search available (recommended). Default true — tool-search is
   * "always available" so the model can pull in tools the preset missed.
   */
  readonly includeToolSearch?: boolean;
}

/**
 * Resolve a class's preset against the tools actually registered in the session.
 *
 * - Keeps only desired tools that exist in `availableToolNames`.
 * - Always appends `tool_search` (when present) so tool-search stays available.
 * - De-duplicates while preserving preset order.
 *
 * An empty result (e.g. `simple-QA`, `other`, or a category whose gen tools are
 * absent) collapses to tool-search-only.
 */
export function resolvePresetTools(
  cls: TaskClass,
  availableToolNames: readonly string[],
  opts: ResolvePresetOptions = {},
): string[] {
  const { includeToolSearch = true } = opts;
  const available = new Set(availableToolNames);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const name of PRESET_TOOLS[cls]) {
    if (available.has(name) && !seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  if (
    includeToolSearch &&
    available.has(TOOL_SEARCH_TOOL_NAME) &&
    !seen.has(TOOL_SEARCH_TOOL_NAME)
  ) {
    out.push(TOOL_SEARCH_TOOL_NAME);
  }
  return out;
}

/** True when the resolved preset is tool-search-only (no domain tools). */
export function isToolSearchOnly(resolved: readonly string[]): boolean {
  return resolved.length === 0 || (resolved.length === 1 && resolved[0] === TOOL_SEARCH_TOOL_NAME);
}
