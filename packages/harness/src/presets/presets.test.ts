import { describe, expect, it } from 'vitest';
import { TASK_CLASSES, type TaskClass } from '../classify/classify.js';
import { SPAWN_SUBAGENT_TOOL_NAME } from '../subagent/types.js';
import {
  isToolSearchOnly,
  PRESET_TOOLS,
  resolvePresetTools,
  SUBAGENT_PRESET_CLASSES,
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
  // The REAL macOS connector tool names registered by @pi-desktop/mac-connectors.
  'calendar_list_events',
  'calendar_create_event',
  'reminders_list',
  'reminders_create',
  'contacts_search',
  'mail_search',
  'mail_recent',
  'mail_read',
  'messages_recent',
  'messages_send',
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

  it("'other' surfaces the macOS connectors (calendar bug) + tool_search when registered", () => {
    const tools = resolvePresetTools('other', ALL_TOOLS);
    // The connector/integration bucket (calendar/mail/messages/… route here) must
    // hand the model the connector tools directly, not force a tool_search hop —
    // this is the fix for "I can't access your calendar" refusals.
    expect(tools).toContain('calendar_list_events');
    expect(tools).toContain('mail_recent');
    expect(tools).toContain('messages_send');
    expect(tools).toContain('reminders_list');
    expect(tools).toContain('contacts_search');
    expect(tools).toContain('tool_search');
    expect(isToolSearchOnly(tools)).toBe(false);
  });

  it("'other' collapses to tool-search-only when the connectors are absent (pure fallback)", () => {
    // With no connector tools registered, 'other' degrades cleanly (the
    // no-tool-signal fallback keeps its lean tool-search-only shape).
    const tools = resolvePresetTools('other', ['read', 'bash', TOOL_SEARCH_TOOL_NAME]);
    expect(isToolSearchOnly(tools)).toBe(true);
  });

  it('always keeps tool_search available across every class', () => {
    for (const cls of TASK_CLASSES) {
      expect(resolvePresetTools(cls, ALL_TOOLS)).toContain('tool_search');
    }
  });
});

describe('spawn_subagent is front-loaded only for agentic classes (blind-test item 6)', () => {
  // The harness registers these three cross-cutting tools globally; add them to
  // the available set so the gating is exercised (they were absent from ALL_TOOLS,
  // which is why the exact-array preset tests above never surfaced them).
  const WITH_HARNESS_TOOLS = [...ALL_TOOLS, SPAWN_SUBAGENT_TOOL_NAME, 'update_plan', 'ask_user'];

  // Trivial tiers + single-artifact create tasks must NOT front-load the subagent
  // — this is exactly the "write a doc" (other) / "create 3 files" (basic-tools)
  // regression from the blind test.
  const NON_SUBAGENT_CLASSES: readonly TaskClass[] = [
    'simple-QA',
    'basic-tools',
    'file-ops',
    '2d-art',
    'other',
  ];

  it('omits spawn_subagent for trivial doc/file/answer classes', () => {
    for (const cls of NON_SUBAGENT_CLASSES) {
      expect(resolvePresetTools(cls, WITH_HARNESS_TOOLS)).not.toContain(SPAWN_SUBAGENT_TOOL_NAME);
    }
  });

  it('front-loads spawn_subagent for genuinely-agentic classes', () => {
    for (const cls of SUBAGENT_PRESET_CLASSES) {
      expect(resolvePresetTools(cls, WITH_HARNESS_TOOLS)).toContain(SPAWN_SUBAGENT_TOOL_NAME);
    }
  });

  it("'other' (where 'write a doc' lands) still gets its connectors + tool_search, just no subagent", () => {
    const tools = resolvePresetTools('other', WITH_HARNESS_TOOLS);
    expect(tools).toContain('calendar_list_events');
    expect(tools).toContain('tool_search');
    expect(tools).not.toContain(SPAWN_SUBAGENT_TOOL_NAME);
  });

  it('the two sets partition every class (each class is agentic XOR trivial for subagents)', () => {
    for (const cls of TASK_CLASSES) {
      const frontLoaded = resolvePresetTools(cls, WITH_HARNESS_TOOLS).includes(
        SPAWN_SUBAGENT_TOOL_NAME,
      );
      expect(frontLoaded).toBe(SUBAGENT_PRESET_CLASSES.has(cls));
    }
  });

  it('plan + ask_user stay active across every class regardless of the subagent gate', () => {
    for (const cls of TASK_CLASSES) {
      const tools = resolvePresetTools(cls, WITH_HARNESS_TOOLS);
      expect(tools).toContain('update_plan');
      expect(tools).toContain('ask_user');
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
