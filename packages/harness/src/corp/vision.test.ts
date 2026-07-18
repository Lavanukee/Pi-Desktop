import { describe, expect, it } from 'vitest';
import {
  buildCeoVisionPrompt,
  CEO_VISION_PROMPT,
  parseVisionBrief,
  SUBMIT_VISION,
  SUBMIT_VISION_TOOL,
  VISION_SEARCH_URL,
} from './vision.js';

describe('CEO_VISION_PROMPT — the vision-forming system prompt', () => {
  it('re-frames the CEO disposition for forming the vision, with the tool flow', () => {
    expect(CEO_VISION_PROMPT).toContain('hold the vision'); // the CEO library disposition
    expect(CEO_VISION_PROMPT).toContain('FORMING THE VISION'); // the vision-forming framing
    expect(CEO_VISION_PROMPT).toContain('INTERPRET mode'); // the autonomous-run default
    expect(CEO_VISION_PROMPT).toContain(SUBMIT_VISION); // how to finalize
    // Direction only — never HOW (no code / contracts): the CEO writes meaning.
    expect(CEO_VISION_PROMPT.toLowerCase()).toContain('never how');
  });

  it('steers research to the REAL browser (navigate → read) with web_search as fallback', () => {
    // Browser-first: the concrete navigate → read flow against the default DDG page.
    expect(CEO_VISION_PROMPT).toContain('browser_navigate');
    expect(CEO_VISION_PROMPT).toContain('browser_read');
    expect(CEO_VISION_PROMPT).toContain(VISION_SEARCH_URL); // the concrete default results URL
    expect(CEO_VISION_PROMPT).toContain('PREFERRED'); // browser is the preferred path
    // web_search / web_fetch are kept as an explicit fallback, not dropped.
    expect(CEO_VISION_PROMPT).toContain('web_search');
    expect(CEO_VISION_PROMPT).toContain('FALLBACK');
  });
});

describe('VISION_SEARCH_URL — the default real-browser results page', () => {
  it('is the DuckDuckGo HTML endpoint (server-rendered, not bot-blocked like the scrape)', () => {
    expect(VISION_SEARCH_URL).toBe('https://duckduckgo.com/html/?q=');
  });
});

describe('buildCeoVisionPrompt — the vision-forming user turn', () => {
  it('states the raw request and the three things the brief must make unambiguous', () => {
    const prompt = buildCeoVisionPrompt('  Build a habit tracker  ');
    expect(prompt).toContain('Build a habit tracker'); // trimmed raw task
    expect(prompt).toContain('WHAT is being built');
    expect(prompt).toContain('TONE');
    expect(prompt).toContain('DELIVERABLES');
    expect(prompt).toContain(SUBMIT_VISION);
  });

  it('prefers the real browser for research and names the default results URL', () => {
    const prompt = buildCeoVisionPrompt('Build a habit tracker');
    expect(prompt).toContain('browser_navigate');
    expect(prompt).toContain('browser_read');
    expect(prompt).toContain(VISION_SEARCH_URL);
    expect(prompt).toContain('web_search'); // fallback still offered
  });
});

describe('SUBMIT_VISION_TOOL — the finalize-the-brief custom tool', () => {
  it('is a neutral custom tool (no submitReview/consult) with a required brief arg', () => {
    expect(SUBMIT_VISION_TOOL.name).toBe(SUBMIT_VISION);
    expect(SUBMIT_VISION_TOOL.submitReview).toBeUndefined();
    expect(SUBMIT_VISION_TOOL.consult).toBeUndefined();
    const params = SUBMIT_VISION_TOOL.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.properties.brief).toBeDefined();
    expect(params.required).toContain('brief');
  });
});

describe('parseVisionBrief — extract the finalized brief', () => {
  const BRIEF = 'VISION: a clean, focused tool. Deliverables: the core.';

  it('prefers the submit_vision tool call (object arguments)', () => {
    const brief = parseVisionBrief(
      [{ name: SUBMIT_VISION, arguments: { brief: BRIEF } }],
      'some trailing chatter',
    );
    expect(brief).toBe(BRIEF);
  });

  it('decodes JSON-string tool arguments', () => {
    const brief = parseVisionBrief(
      [{ name: SUBMIT_VISION, arguments: JSON.stringify({ brief: BRIEF }) }],
      '',
    );
    expect(brief).toBe(BRIEF);
  });

  it('falls back to the final assistant text when the tool was not called', () => {
    expect(parseVisionBrief([], `  ${BRIEF}  `)).toBe(BRIEF);
  });

  it('ignores an unrelated tool call and uses the text', () => {
    expect(parseVisionBrief([{ name: 'web_search', arguments: { query: 'x' } }], BRIEF)).toBe(
      BRIEF,
    );
  });

  it('returns empty string when nothing usable is present (caller falls back to raw task)', () => {
    expect(parseVisionBrief([{ name: SUBMIT_VISION, arguments: { brief: '   ' } }], '   ')).toBe(
      '',
    );
    expect(parseVisionBrief([], '')).toBe('');
  });
});
