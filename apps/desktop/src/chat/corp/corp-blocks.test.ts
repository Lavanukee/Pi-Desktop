/**
 * The pure corp → pi-block adapter. A watched corp node's transcript lines become
 * the SAME `ContentBlock` shapes the normal chat streams, so `AssistantGroup`
 * renders them identically. Covered: block-kind mapping, index-stable ids, the
 * text-form tool-call split (prose kept, call extracted), JSON-payload fencing,
 * and the "only the current action shimmers" synthetic-result set.
 */

import type { WorkerTranscriptLine, WorkerTranscriptView } from '@pi-desktop/coordination';
import type { ContentBlock } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import { transcriptToAssistantView, transcriptToBlocks } from './corp-blocks';

function line(
  over: Partial<WorkerTranscriptLine> & Pick<WorkerTranscriptLine, 'kind'>,
): WorkerTranscriptLine {
  return { at: 0, text: '', ...over };
}

const isTool = (b: ContentBlock): b is Extract<ContentBlock, { type: 'toolCall' }> =>
  b.type === 'toolCall';

describe('transcriptToBlocks — line → ContentBlock mapping', () => {
  it('maps message/thinking/tool/file lines to the matching block kinds', () => {
    const blocks = transcriptToBlocks([
      line({ kind: 'message', text: 'Splitting the work.' }),
      line({ kind: 'thinking', text: 'Weighing the plan.' }),
      line({ kind: 'tool-call', text: 'bash', label: 'Ran', detail: 'ls src' }),
      line({ kind: 'file-touch', text: 'writing src/x.ts', path: 'src/x.ts', addedLines: 12 }),
    ]);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Splitting the work.' });
    expect(blocks[1]).toEqual({ type: 'thinking', thinking: 'Weighing the plan.' });
    // A bash tool-call's detail lands in `command` (what mapToolStep's bash reads).
    expect(blocks[2]).toMatchObject({
      type: 'toolCall',
      name: 'bash',
      arguments: { command: 'ls src' },
    });
    // A file write → a `write` call carrying the live +N (addedLines) for the ±stat.
    expect(blocks[3]).toMatchObject({
      type: 'toolCall',
      name: 'write',
      arguments: { path: 'src/x.ts', addedLines: 12 },
    });
  });

  it('gives tool-call blocks index-stable ids (append never shifts existing ids)', () => {
    const before = transcriptToBlocks([
      line({ kind: 'file-touch', path: 'a.ts', addedLines: 1 }),
      line({ kind: 'tool-call', text: 'bash', detail: 'ls' }),
    ]).filter(isTool);
    const after = transcriptToBlocks([
      line({ kind: 'file-touch', path: 'a.ts', addedLines: 1 }),
      line({ kind: 'tool-call', text: 'bash', detail: 'ls' }),
      line({ kind: 'tool-call', text: 'read', detail: 'b.ts' }),
    ]).filter(isTool);
    // The two original ids are unchanged when a third line appends.
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[1]?.id).toBe(before[1]?.id);
    expect(after[2]?.id).not.toBe(after[1]?.id);
  });

  it('splits a written <function=write> call out of a SETTLED message (prose kept)', () => {
    const text =
      'Writing the file.\n<function=write>\n<parameter=path>\nsrc/x.ts\n</parameter>\n<parameter=content>\nexport const x = 1;\n</parameter>\n</function>';
    const blocks = transcriptToBlocks([line({ kind: 'message', text })]);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Writing the file.' });
    expect(blocks[1]).toMatchObject({
      type: 'toolCall',
      name: 'write',
      arguments: { path: 'src/x.ts', content: 'export const x = 1;' },
    });
  });

  it('splits a <function=bash> written INSIDE a Thought (prose stays a thought)', () => {
    const text =
      'Now run it.\n<tool_call>\n<function=bash>\n<parameter=command>\nnode x.ts\n</parameter>\n</function>\n</tool_call>';
    const blocks = transcriptToBlocks([line({ kind: 'thinking', text })]);
    expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'Now run it.' });
    expect(blocks[1]).toMatchObject({
      type: 'toolCall',
      name: 'bash',
      arguments: { command: 'node x.ts' },
    });
  });

  it('keeps a STILL-STREAMING (incomplete) tool-call tag as live text — no split', () => {
    const text = '<tool_call>\n<function=write>\n<parameter=path>\nsrc/x.ts';
    const blocks = transcriptToBlocks([line({ kind: 'message', text, streaming: true })]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text });
  });

  it('fences a settled JSON payload to a ```json text block, prose stays prose', () => {
    const [json] = transcriptToBlocks([line({ kind: 'message', text: '{"contract":"emitter"}' })]);
    expect(json).toMatchObject({ type: 'text' });
    expect((json as { text: string }).text).toMatch(/^```json\n/);
    const [prose] = transcriptToBlocks([
      line({ kind: 'message', text: '{spec: the emitter owns lifetimes}' }),
    ]);
    expect(prose).toEqual({ type: 'text', text: '{spec: the emitter owns lifetimes}' });
  });
});

describe('transcriptToAssistantView — streaming + running control', () => {
  const view = (lines: WorkerTranscriptLine[]): WorkerTranscriptView => ({
    nodeId: 'n',
    role: 'engineer',
    briefing: { workerName: 'n', roleLine: 'Builder', title: 't', goal: 'g', deliverables: [] },
    lines,
  });

  it('marks the group streaming while working and settles it otherwise', () => {
    const lines = [line({ kind: 'message', text: 'hi' })];
    expect(transcriptToAssistantView(view(lines), true).group[0]?.isStreaming).toBe(true);
    expect(transcriptToAssistantView(view(lines), false).group[0]?.isStreaming).toBe(false);
  });

  it('gives every tool call but the LAST a settled result while working (only the current action shimmers)', () => {
    const lines = [
      line({ kind: 'file-touch', path: 'a.ts', addedLines: 1 }),
      line({ kind: 'tool-call', text: 'bash', detail: 'ls' }),
      line({ kind: 'file-touch', path: 'b.ts', addedLines: 2 }),
    ];
    const working = transcriptToAssistantView(view(lines), true);
    const toolIds = working.group[0]?.blocks.filter(isTool).map((b) => b.id) ?? [];
    expect(toolIds).toHaveLength(3);
    // The first two are settled (have a result); the last (current action) is not.
    expect(working.resultByCallId.has(toolIds[0] as string)).toBe(true);
    expect(working.resultByCallId.has(toolIds[1] as string)).toBe(true);
    expect(working.resultByCallId.has(toolIds[2] as string)).toBe(false);
    // A settled node runs nothing — no synthetic results at all.
    expect(transcriptToAssistantView(view(lines), false).resultByCallId.size).toBe(0);
  });
});
