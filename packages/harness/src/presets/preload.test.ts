import { BROWSER_TOOL_NAMES } from '@pi-desktop/browser-use/tool-names';
import { MAC_COMPUTER_USE_TOOL_NAMES } from '@pi-desktop/mac-computer-use/tool-names';
import { describe, expect, it } from 'vitest';
import type { ToolLike } from '../tools/tool-search.js';
import { MAX_PRELOAD_TOOLS, preloadToolNames } from './preload.js';

/** A registry with the two pipelines + a few standalone tools, each with a
 * description that gives searchTools something to match beyond the bare name. */
const REGISTRY: ToolLike[] = [
  { name: 'read', description: 'Read a file from disk' },
  { name: 'write', description: 'Write a file to disk' },
  { name: 'bash', description: 'Run a shell command' },
  { name: 'pdf_extract', description: 'Extract text from a pdf document' },
  { name: 'http_request', description: 'Make an http request to a url' },
  ...MAC_COMPUTER_USE_TOOL_NAMES.map((name) => ({
    name,
    description: 'Control a mac app in the background',
  })),
  ...BROWSER_TOOL_NAMES.map((name) => ({ name, description: 'Drive a web browser page' })),
];

describe('preloadToolNames', () => {
  it('returns nothing for an empty / trivial prompt', () => {
    expect(preloadToolNames('', REGISTRY)).toEqual([]);
    expect(preloadToolNames('   ', REGISTRY)).toEqual([]);
    // "hi there" has no tool-name/description signal → no confident match.
    expect(preloadToolNames('hi there how are you', REGISTRY)).toEqual([]);
  });

  it('pre-activates a standalone tool on a strong name match', () => {
    const got = preloadToolNames('extract the text from this pdf', REGISTRY);
    expect(got).toContain('pdf_extract');
    // A standalone match must NOT drag in a pipeline it isn't part of.
    expect(got).not.toContain('mac_click');
    expect(got).not.toContain('browser_navigate');
  });

  it('loads the WHOLE mac pipeline when a mac tool is a strong match (peers)', () => {
    const got = preloadToolNames('take a snapshot of the mac app and click the button', REGISTRY);
    for (const name of MAC_COMPUTER_USE_TOOL_NAMES) expect(got).toContain(name);
  });

  it('loads a pipeline`s missing peers even when one member is already active', () => {
    // jedd: "if mac snapshot is loaded, the whole mac computer use pipeline should be as well".
    const got = preloadToolNames('snapshot the current mac window', REGISTRY, {
      activeToolNames: ['mac_snapshot'],
    });
    expect(got).not.toContain('mac_snapshot'); // already active → not re-added
    expect(got).toContain('mac_click');
    expect(got).toContain('mac_type');
    expect(got).toContain('mac_launch');
  });

  it('honors the per-turn pick limit', () => {
    // Two distinct strong signals (pdf + http) → both picked, but no third.
    const got = preloadToolNames('extract pdf text then make an http request', REGISTRY, {
      limit: 2,
    });
    expect(got).toContain('pdf_extract');
    expect(got).toContain('http_request');
  });

  it('never exceeds the MAX_PRELOAD_TOOLS ceiling', () => {
    // A prompt hitting both pipelines would be 12 tools; the cap holds it down.
    const got = preloadToolNames(
      'snapshot the mac app, click, type, then navigate the browser and click and type',
      REGISTRY,
      { limit: 4 },
    );
    expect(got.length).toBeLessThanOrEqual(MAX_PRELOAD_TOOLS);
  });

  it('skips tools that are not registered in this session', () => {
    // Registry without the mac pipeline → a mac-y prompt yields nothing mac.
    const noMac = REGISTRY.filter((t) => !t.name.startsWith('mac_'));
    const got = preloadToolNames('snapshot the mac app and click', noMac);
    expect(got.every((n) => !n.startsWith('mac_'))).toBe(true);
  });
});
