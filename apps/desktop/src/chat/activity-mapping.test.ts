/**
 * Unit coverage for the pure THEME 3 mapping: the chain GROUPING RULE
 * (segmentBlocks), tool→kind classification, and the per-kind step data
 * (bash command+output, edit diff, read preview, media opensInCanvas + tabSpec).
 */
import type { AssistantMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import {
  type GroupSegment,
  mapThinkingStep,
  mapToolStep,
  segmentBlocks,
  segmentGroup,
  toolStepKind,
} from './activity-mapping';

type ToolCall = Extract<ContentBlock, { type: 'toolCall' }>;
type Thinking = Extract<ContentBlock, { type: 'thinking' }>;

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const think = (t: string): Thinking => ({ type: 'thinking', thinking: t });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const result = (id: string, out: string): ToolResultMsg => ({
  kind: 'toolResult',
  id,
  toolCallId: id,
  toolName: 'x',
  text: out,
  isError: false,
  timestamp: 0,
});

describe('segmentBlocks (grouping rule)', () => {
  it('coalesces consecutive thinking + tool calls into one chain, split by text', () => {
    const segments = segmentBlocks([
      text('Let me look.'),
      think('planning'),
      call('c1', 'bash', { command: 'ls' }),
      call('c2', 'edit', { path: 'a.txt' }),
      text('Done.'),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(['text', 'chain', 'text']);
    const chain = segments[1];
    expect(chain?.kind).toBe('chain');
    if (chain?.kind === 'chain') expect(chain.blocks).toHaveLength(3);
  });

  it('renders a run of only thoughts (no tool call) as standalone thoughts', () => {
    const segments = segmentBlocks([think('just thinking'), text('answer')]);
    expect(segments.map((s) => s.kind)).toEqual(['thoughts', 'text']);
  });

  it('drops empty text blocks', () => {
    expect(segmentBlocks([text(''), call('c1', 'bash', {})]).map((s) => s.kind)).toEqual(['chain']);
  });
});

const assistant = (id: string, blocks: ContentBlock[], streaming = false): AssistantMsg => ({
  kind: 'assistant',
  id,
  blocks,
  isStreaming: streaming,
  timestamp: 0,
});

describe('segmentGroup (A1 — inline artifact interleaving)', () => {
  it('splices an artifact BETWEEN the text before and after its fence', () => {
    const seg = segmentGroup([
      assistant('m1', [
        text('Before the drawing.\n\n```svg\n<svg><circle/></svg>\n```\n\nAfter the drawing.'),
      ]),
    ]);
    expect(seg.map((s) => s.kind)).toEqual(['text', 'artifact', 'text']);
    const [before, art, after] = seg;
    expect(before?.kind === 'text' && before.text).toBe('Before the drawing.');
    expect(after?.kind === 'text' && after.text).toBe('After the drawing.');
    if (art?.kind === 'artifact') {
      expect(art.artifact.id).toBe('m1-a0');
      expect(art.artifact.kind).toBe('svg');
    }
  });

  it('keeps artifact ids stable + sequential across the message (matches detection)', () => {
    const seg = segmentGroup([
      assistant('m1', [text('```svg\n<svg/>\n```\ntween\n```html\n<b>hi</b>\n```')]),
    ]);
    const ids = seg
      .filter((s): s is Extract<GroupSegment, { kind: 'artifact' }> => s.kind === 'artifact')
      .map((s) => s.artifact.id);
    expect(ids).toEqual(['m1-a0', 'm1-a1']);
  });

  it('leaves a plain (non-artifact) code fence inside the markdown run', () => {
    const seg = segmentGroup([assistant('m1', [text('text\n```js\nconst x = 1;\n```')])]);
    expect(seg.map((s) => s.kind)).toEqual(['text']);
    expect(seg[0]?.kind === 'text' && seg[0].text).toContain('```js');
  });

  it('coalesces a tool chain across message boundaries while interleaving artifacts', () => {
    const seg = segmentGroup([
      assistant('m1', [text('Here:\n```svg\n<svg/>\n```'), call('c1', 'bash', { command: 'ls' })]),
      assistant('m2', [call('c2', 'edit', { path: 'a.txt' }), text('done')]),
    ]);
    // one chain spans c1 (m1) + c2 (m2); the svg stays inline before it.
    expect(seg.map((s) => s.kind)).toEqual(['text', 'artifact', 'chain', 'text']);
    const chain = seg[2];
    if (chain?.kind === 'chain') expect(chain.blocks).toHaveLength(2);
  });
});

describe('toolStepKind', () => {
  it('classifies tools by name', () => {
    expect(toolStepKind('bash')).toBe('bash');
    expect(toolStepKind('shell')).toBe('bash');
    expect(toolStepKind('str_replace_editor')).toBe('edit');
    expect(toolStepKind('write_file')).toBe('edit');
    expect(toolStepKind('web_search')).toBe('search');
    expect(toolStepKind('generate_image')).toBe('image');
    expect(toolStepKind('make_pdf')).toBe('pdf');
    expect(toolStepKind('read_file')).toBe('read');
    expect(toolStepKind('grep')).toBe('read');
  });

  it('classifies browser-use tools by verb (#17) — never the generic file read', () => {
    expect(toolStepKind('browser_navigate')).toBe('browser-navigate');
    expect(toolStepKind('browser_click')).toBe('browser-click');
    expect(toolStepKind('browser_type')).toBe('browser-type');
    expect(toolStepKind('browser_read')).toBe('browser-read');
    expect(toolStepKind('browser_snapshot')).toBe('browser-read');
    expect(toolStepKind('browser_scroll')).toBe('browser-click');
    expect(toolStepKind('playwright_goto')).toBe('browser-navigate');
    // A plain file read must stay a file read, not get diverted to a browser kind.
    expect(toolStepKind('read_file')).toBe('read');
  });
});

describe('mapToolStep', () => {
  it('past-tense on done, present tense + running status while running', () => {
    expect(mapToolStep(call('c1', 'bash', { command: 'ls' }), undefined, false).data.label).toBe(
      'Ran a command',
    );
    const running = mapToolStep(call('c1', 'bash', { command: 'ls' }), undefined, true).data;
    expect(running.label).toBe('Running a command');
    expect(running.status).toBe('running');
  });

  it('bash carries command + output', () => {
    const step = mapToolStep(
      call('c1', 'bash', { command: 'ls -la' }),
      result('c1', 'total 8'),
      false,
    ).data;
    expect(step).toMatchObject({ kind: 'bash', command: 'ls -la', output: 'total 8' });
  });

  it('edit builds a diff from old/new text and carries the filename', () => {
    const step = mapToolStep(
      call('c1', 'edit', { path: '/tmp/hello.txt', oldText: 'Hello', newText: 'Hi world' }),
      undefined,
      false,
    ).data;
    expect(step.kind).toBe('edit');
    expect(step).toMatchObject({ filename: 'hello.txt' });
    if (step.kind === 'edit') {
      expect(step.diff?.[0]?.lines).toEqual([
        { kind: 'del', text: 'Hello' },
        { kind: 'add', text: 'Hi world' },
      ]);
    }
  });

  it('read carries the tool output as inline preview', () => {
    const step = mapToolStep(
      call('c1', 'read_file', { path: 'a.ts' }),
      result('c1', 'file body'),
      false,
    ).data;
    expect(step).toMatchObject({ kind: 'read', filename: 'a.ts', preview: 'file body' });
  });

  it('classifies a SKILL / skills-dir read as `skill` → "Read a skill" (Wave B #3a)', () => {
    const step = mapToolStep(
      call('c1', 'read', { path: '/Users/jedd/.pi/agent/skills/code-review/SKILL.md' }),
      result('c1', 'You are a reviewer.'),
      false,
    ).data;
    expect(step.kind).toBe('skill');
    expect(step.label).toBe('Read a skill');
    expect(step).toMatchObject({ filename: 'SKILL.md', preview: 'You are a reviewer.' });
    // Present tense while running.
    expect(
      mapToolStep(call('c1', 'read', { path: '/x/.pi/skills/debugging/SKILL.md' }), undefined, true)
        .data.label,
    ).toBe('Reading a skill');
  });

  it('leaves a NORMAL file read as `read` (a look-alike name is not a skill)', () => {
    expect(
      mapToolStep(call('c1', 'read', { path: '/repo/src/app.ts' }), undefined, false).data.kind,
    ).toBe('read');
    // A doc that merely mentions skills but isn't a SKILL.md / under skills/.
    expect(
      mapToolStep(call('c1', 'read', { path: '/repo/docs/SKILLS.md' }), undefined, false).data.kind,
    ).toBe('read');
  });

  it('does NOT promote an EDIT of a skill file to `skill` (only reads)', () => {
    expect(
      mapToolStep(
        call('c1', 'edit', { path: '/x/.pi/agent/skills/x/SKILL.md', oldText: 'a', newText: 'b' }),
        undefined,
        false,
      ).data.kind,
    ).toBe('edit');
  });

  it('browser navigate carries the url + a page-tense label (#17)', () => {
    const step = mapToolStep(
      call('c1', 'browser_navigate', { url: 'https://neal.fun' }),
      undefined,
      false,
    ).data;
    expect(step.kind).toBe('browser-navigate');
    expect(step.label).toBe('Visited a page');
    if (step.kind === 'browser-navigate') expect(step.url).toBe('https://neal.fun');
  });

  it('browser read expands the returned page text inline (#17)', () => {
    const step = mapToolStep(
      call('c1', 'browser_read', {}),
      result('c1', 'the page body'),
      false,
    ).data;
    expect(step.kind).toBe('browser-read');
    if (step.kind === 'browser-read') expect(step.preview).toBe('the page body');
  });

  it('image opens in canvas and yields a media tab spec', () => {
    const mapped = mapToolStep(
      call('c1', 'generate_image', {}),
      result('c1', 'data:image/png;base64,AAAA'),
      false,
    );
    expect(mapped.data).toMatchObject({ kind: 'image', opensInCanvas: true });
    expect(mapped.tabSpec).toMatchObject({
      kind: 'image',
      key: 'c1',
      mediaSrc: 'data:image/png;base64,AAAA',
    });
    // B1: the tab spec must NOT hard-control the load status — the surface
    // self-manages from the media element's load/error events.
    expect(mapped.tabSpec?.mediaStatus).toBeUndefined();
  });
});

describe('mapThinkingStep', () => {
  it('maps a thought to a thinking step with past/present labels', () => {
    expect(mapThinkingStep(think('hmm'), false).data).toMatchObject({
      kind: 'thinking',
      label: 'Thought',
      thought: 'hmm',
    });
    expect(mapThinkingStep(think('hmm'), true).data.label).toBe('Thinking…');
  });
});
