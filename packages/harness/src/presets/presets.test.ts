import { describe, expect, it } from 'vitest';
import { TASK_CLASSES } from '../classify/classify.js';
import {
  isToolSearchOnly,
  PRESET_TOOLS,
  resolvePresetTools,
  TOOL_SEARCH_TOOL_NAME,
} from './presets.js';

// The full v0.1+ tool universe, as it would appear once every workstream lands.
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
  'browser_click',
  'browser_eval',
  'browser_screenshot',
  'image_generate',
  'image_edit',
  'video_generate',
  'video_edit',
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

  it('browser-use → browser tools + web_fetch + read + tool_search', () => {
    expect(resolvePresetTools('browser-use', ALL_TOOLS)).toEqual([
      'browser_navigate',
      'browser_click',
      'browser_eval',
      'browser_screenshot',
      'web_fetch',
      'read',
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
      'browser-use',
    ] as const) {
      const tools = resolvePresetTools(cls, V01_TOOLS);
      // browser-use still keeps its available "read"; the rest are gen-only.
      if (cls === 'browser-use') {
        expect(tools).toEqual(['read', 'tool_search']);
      } else {
        expect(isToolSearchOnly(tools)).toBe(true);
      }
    }
  });

  it('never returns a tool that is not registered', () => {
    const tools = resolvePresetTools('full-shebang', V01_TOOLS);
    for (const t of tools) expect(V01_TOOLS).toContain(t);
  });

  it('omits tool_search when it is not registered', () => {
    const tools = resolvePresetTools('coding', ['read', 'bash']);
    expect(tools).toEqual(['read', 'bash']);
  });
});
