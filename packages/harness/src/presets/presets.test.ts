import { describe, expect, it } from 'vitest';
import { TASK_CLASSES } from '../classify/classify.js';
import {
  isToolSearchOnly,
  PRESET_TOOLS,
  resolvePresetTools,
  TOOL_SEARCH_TOOL_NAME,
} from './presets.js';

// The full v0.1+ tool universe, as it would appear once every workstream lands.
// The browser_* names are the REAL ones registered by @pi-desktop/browser-use.
const ALL_TOOLS = [
  'read',
  'write',
  'edit',
  'ls',
  'find',
  'grep',
  'bash',
  'web_search',
  'web_fetch',
  'python_run',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_read',
  'browser_wait',
  'browser_back',
  'browser_forward',
  'browser_key',
  'image_generate',
  'image_edit',
  'video_generate',
  'video_edit',
  'extract_frames',
  'probe',
  'video_locate',
  'image_segment',
  'image_detect',
  'image_ocr',
  'motion_graphics_render',
  'model_3d_generate',
  'model_3d_view',
  TOOL_SEARCH_TOOL_NAME,
];

describe('PRESET_TOOLS', () => {
  it('has an entry for every task class', () => {
    for (const cls of TASK_CLASSES) {
      expect(PRESET_TOOLS[cls]).toBeDefined();
    }
  });
});

describe('resolvePresetTools — full tool universe', () => {
  it('coding → filesystem + bash + python + tool_search', () => {
    const tools = resolvePresetTools('coding', ALL_TOOLS);
    expect(tools).toEqual([
      'read',
      'write',
      'edit',
      'ls',
      'find',
      'grep',
      'bash',
      'python_run',
      'tool_search',
    ]);
  });

  it('basic-tools → python + web + tool_search', () => {
    expect(resolvePresetTools('basic-tools', ALL_TOOLS)).toEqual([
      'python_run',
      'web_search',
      'web_fetch',
      'tool_search',
    ]);
  });

  it('browser-use → the REAL browser tools (snapshot present + early) + web_fetch + tool_search', () => {
    expect(resolvePresetTools('browser-use', ALL_TOOLS)).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_read',
      'browser_wait',
      'browser_back',
      'browser_forward',
      'browser_key',
      'web_fetch',
      'tool_search',
    ]);
  });

  it('browser-use regression guard (round-10 #9): snapshot active; no fake/attractor tools', () => {
    const tools = resolvePresetTools('browser-use', ALL_TOOLS);
    // The perception tool MUST be present so the model can SEE the page, and
    // near the front (right after navigate) so it reaches for it early.
    expect(tools).toContain('browser_snapshot');
    expect(tools.indexOf('browser_snapshot')).toBeLessThanOrEqual(1);
    // The bug names + the attractive-nuisance file `read` must be gone.
    expect(tools).not.toContain('browser_eval');
    expect(tools).not.toContain('browser_screenshot');
    expect(tools).not.toContain('read');
    // The page-text reader replaces the file reader for browsing.
    expect(tools).toContain('browser_read');
  });

  it('video-edit → ffmpeg façade + fs + video_locate + tool_search (generation stays in advanced-video)', () => {
    expect(resolvePresetTools('video-edit', ALL_TOOLS)).toEqual([
      'video_edit',
      'extract_frames',
      'probe',
      'read',
      'write',
      'edit',
      'ls',
      'find',
      'grep',
      'video_locate',
      'tool_search',
    ]);
  });

  it('perception → segment/detect/locate/ocr + video_edit + tool_search', () => {
    expect(resolvePresetTools('perception', ALL_TOOLS)).toEqual([
      'image_segment',
      'image_detect',
      'video_locate',
      'image_ocr',
      'video_edit',
      'tool_search',
    ]);
  });

  it('advanced-video preset is unchanged by the video split (still generation-shaped)', () => {
    expect(resolvePresetTools('advanced-video', ALL_TOOLS)).toEqual([
      'video_generate',
      'video_edit',
      'image_generate',
      'image_edit',
      'tool_search',
    ]);
  });

  it('simple-QA → tool-search-only', () => {
    const tools = resolvePresetTools('simple-QA', ALL_TOOLS);
    expect(tools).toEqual(['tool_search']);
    expect(isToolSearchOnly(tools)).toBe(true);
  });

  it("'other' → tool-search-only", () => {
    const tools = resolvePresetTools('other', ALL_TOOLS);
    expect(isToolSearchOnly(tools)).toBe(true);
  });

  it('always keeps tool_search available across every class', () => {
    for (const cls of TASK_CLASSES) {
      expect(resolvePresetTools(cls, ALL_TOOLS)).toContain('tool_search');
    }
  });
});

describe('resolvePresetTools — graceful degradation (v0.1 tool set)', () => {
  // In v0.1 the generation/browser tools do not exist yet.
  const V01_TOOLS = [
    'read',
    'write',
    'edit',
    'ls',
    'find',
    'grep',
    'bash',
    'python_run',
    TOOL_SEARCH_TOOL_NAME,
  ];

  it('a category whose tools are absent collapses to tool-search-only', () => {
    for (const cls of [
      'motion-graphics',
      'advanced-video',
      '3d',
      '2d-art',
      // browser-use no longer smuggles in the file `read` tool, so with no
      // browser tools + no web_fetch registered it collapses cleanly.
      'browser-use',
    ] as const) {
      const tools = resolvePresetTools(cls, V01_TOOLS);
      expect(isToolSearchOnly(tools)).toBe(true);
    }
  });

  it('never returns a tool that is not registered', () => {
    const tools = resolvePresetTools('coding', V01_TOOLS);
    for (const t of tools) expect(V01_TOOLS).toContain(t);
  });

  it('omits tool_search when it is not registered', () => {
    const tools = resolvePresetTools('coding', ['read', 'bash']);
    expect(tools).toEqual(['read', 'bash']);
  });
});
