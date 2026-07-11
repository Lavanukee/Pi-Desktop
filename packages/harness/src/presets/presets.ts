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

import { BROWSER_TOOL_NAMES } from '@pi-desktop/browser-use/tool-names';
import type { TaskClass } from '../classify/classify.js';
import { SPAWN_SUBAGENT_TOOL_NAME } from '../subagent/types.js';

/** The always-available tool-search tool name. */
export const TOOL_SEARCH_TOOL_NAME = 'tool_search';

/**
 * Harness tools kept active in EVERY preset (when registered), independent of
 * the task class — the model must always be able to publish a plan, ask the user
 * a question, and spawn a subagent. `tool_search` is handled separately (it is
 * gated by {@link ResolvePresetOptions.includeToolSearch}).
 */
export const ALWAYS_ACTIVE_TOOLS: readonly string[] = [
  'update_plan',
  'ask_user',
  SPAWN_SUBAGENT_TOOL_NAME,
];

// Common tool clusters (built-in pi tools + this repo's web-tools/gen tools).
const CORE_FS = ['read', 'write', 'edit', 'ls', 'find', 'grep'] as const;
const WEB = ['web_search', 'web_fetch'] as const;
const PYTHON = ['python_run'] as const;
// The browser set is imported from browser-use (single source of truth) so a
// tool rename is a COMPILE error here, not a silent runtime miss. It leads with
// browser_navigate then browser_snapshot — the model MUST be able to SEE the
// page (snapshot) before it can click/type. (Round-10 bug #9: this list had
// drifted to non-existent `browser_eval`/`browser_screenshot` and omitted
// `browser_snapshot`/`browser_read`, so browser tasks looped, blind.)
const BROWSER = BROWSER_TOOL_NAMES;
const IMAGE_GEN = ['image_generate', 'image_edit'] as const;
const VIDEO_GEN = ['video_generate', 'video_edit'] as const;
const MOTION_GEN = ['motion_graphics_render'] as const;
const THREE_D_GEN = ['model_3d_generate', 'model_3d_view'] as const;
// Typed ffmpeg façade (safe argv, no denoise) — the video-edit preset core.
const VIDEO_EDIT = ['video_edit', 'extract_frames', 'probe'] as const;
// On-device perception: Falcon-Perception (MLX) + ffmpeg-sampled video locate.
const PERCEPTION = ['image_segment', 'image_detect', 'video_locate', 'image_ocr'] as const;

/**
 * Desired preset tool lists per class. `tool_search` is appended by
 * {@link resolvePresetTools} and omitted here to keep the intent readable.
 */
export const PRESET_TOOLS: Record<TaskClass, readonly string[]> = {
  // Tiers.
  'simple-QA': [],
  'basic-tools': [...PYTHON, ...WEB],
  // Categories.
  coding: [...CORE_FS, 'bash', ...PYTHON],
  'file-ops': [...CORE_FS, 'bash'],
  // NOTE: the bare file `read` tool is deliberately NOT here — it was an
  // attractive nuisance that a small model grabbed ("Read a file") instead of
  // browsing. Page reading is browser_read; page perception is browser_snapshot.
  'browser-use': [...BROWSER, 'web_fetch'],
  'motion-graphics': [...MOTION_GEN, ...IMAGE_GEN],
  // advanced-video = GENERATION (text→video). Preset unchanged by the video split.
  'advanced-video': [...VIDEO_GEN, ...IMAGE_GEN],
  // video-edit = the ffmpeg façade + fs tools; video_locate bridges to perception.
  'video-edit': [...VIDEO_EDIT, ...CORE_FS, 'video_locate'],
  // perception = analysis (segment/detect/locate/ocr); video_edit burns overlays.
  perception: [...PERCEPTION, 'video_edit'],
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
    seen.add(TOOL_SEARCH_TOOL_NAME);
  }
  // Plan + ask-user stay active across every class (when registered) so the
  // model can always surface progress and ask questions.
  for (const name of ALWAYS_ACTIVE_TOOLS) {
    if (available.has(name) && !seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  return out;
}

/** True when the resolved preset is tool-search-only (no domain tools). */
export function isToolSearchOnly(resolved: readonly string[]): boolean {
  return resolved.length === 0 || (resolved.length === 1 && resolved[0] === TOOL_SEARCH_TOOL_NAME);
}
