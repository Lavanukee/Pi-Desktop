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

  it('splits a JSON-form <tool_call>{…}</tool_call> out of a SETTLED message (prose kept)', () => {
    const text =
      'Now run it.\n<tool_call>{"name":"bash","arguments":{"command":"ls src"}}</tool_call>';
    const blocks = transcriptToBlocks([line({ kind: 'message', text })]);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Now run it.' });
    // bash → the bash row reads `command`; write/edit would read `path` (file row).
    expect(blocks[1]).toMatchObject({
      type: 'toolCall',
      name: 'bash',
      arguments: { command: 'ls src' },
    });
    // No raw tag survives anywhere.
    expect(JSON.stringify(blocks)).not.toMatch(/<tool_call>|<\/tool_call>|<function=/);
  });

  it('handles a bare <tool_call>…</tool_call> wrapper (no <function=) — no raw tag', () => {
    const text =
      'Working.\n<tool_call>{"name":"write","parameters":{"path":"a.ts","content":"x"}}</tool_call>';
    const blocks = transcriptToBlocks([line({ kind: 'message', text })]);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Working.' });
    // A write renders as the file row (path surfaced), sourced from "parameters".
    expect(blocks[1]).toMatchObject({
      type: 'toolCall',
      name: 'write',
      arguments: { path: 'a.ts', content: 'x' },
    });
  });

  it('suppresses scaffolding MID-STREAM: keeps prose before the opener, no raw tag', () => {
    const text = 'Let me run this. <tool_call>\n<function=bash>';
    const blocks = transcriptToBlocks([line({ kind: 'message', text, streaming: true })]);
    expect(blocks).toEqual([{ type: 'text', text: 'Let me run this.' }]);
    expect((blocks[0] as { text: string }).text).not.toMatch(/<tool_call>|<function=/);
  });

  it('shows a placeholder (never raw XML) for a still-streaming tag with no prose before it', () => {
    const text = '<tool_call>\n<function=write>\n<parameter=path>\nsrc/x.ts';
    const blocks = transcriptToBlocks([line({ kind: 'message', text, streaming: true })]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text' });
    // A minimal live block stands in; no raw scaffolding leaks.
    expect((blocks[0] as { text: string }).text).not.toMatch(/<tool_call>|<function=|<parameter=/);
  });

  it('scrubs an orphan </tool_call> token from a SETTLED message (no raw tag)', () => {
    const blocks = transcriptToBlocks([line({ kind: 'message', text: 'All done.</tool_call>' })]);
    expect(blocks).toEqual([{ type: 'text', text: 'All done.' }]);
  });

  it('suppresses a written <function=bash> mid-stream INSIDE a Thought (prose kept)', () => {
    const text = 'Now run it. <tool_call>\n<function=bash>\n<parameter=command>';
    const blocks = transcriptToBlocks([line({ kind: 'thinking', text, streaming: true })]);
    expect(blocks).toEqual([{ type: 'thinking', thinking: 'Now run it.' }]);
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

describe('transcriptToBlocks — manager contract array → commission rows (D1)', () => {
  const contract = (
    id: string,
    title: string,
    owner: string,
    slot: string,
    deps: string[] = [],
  ) => ({
    id,
    title,
    ownerNodeId: owner,
    input: `input for ${id}`,
    output: `output for ${id}`,
    slot,
    available: { tools: ['read', 'write'], imports: [] },
    reviewRubric: 'works + tested',
    dependsOn: deps,
    status: 'queued',
  });
  const CONTRACTS = [
    contract('combat-1', 'Player movement controller', 'combat-eng-1', 'src/combat/move.ts'),
    contract('combat-2', 'Hit detection', 'combat-eng-2', 'src/combat/hit.ts', ['combat-1']),
  ];

  it('splits a bare contract array into ONE commission tool-call row per contract (no JSON dump)', () => {
    const blocks = transcriptToBlocks([line({ kind: 'message', text: JSON.stringify(CONTRACTS) })]);
    const tools = blocks.filter(isTool);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      type: 'toolCall',
      name: 'commission_contract',
      arguments: {
        title: 'Player movement controller',
        owner: 'combat-eng-1',
        slot: 'src/combat/move.ts',
      },
    });
    expect(tools[1]).toMatchObject({
      name: 'commission_contract',
      arguments: { title: 'Hit detection', owner: 'combat-eng-2', dependsOn: ['combat-1'] },
    });
    // NOT a raw ```json code block, and no raw contract JSON leaked as text.
    expect(blocks.some((b) => b.type === 'text')).toBe(false);
    expect(JSON.stringify(blocks)).not.toMatch(/```json|reviewRubric/);
  });

  it('detects a contract array wrapped in a ```json fence + surrounding prose', () => {
    const text = `Here are the contracts:\n\`\`\`json\n${JSON.stringify(CONTRACTS)}\n\`\`\``;
    const blocks = transcriptToBlocks([line({ kind: 'message', text })]);
    // The lead-in prose is kept as text; the array becomes commission rows.
    expect(blocks[0]).toEqual({ type: 'text', text: 'Here are the contracts:' });
    expect(blocks.filter(isTool)).toHaveLength(2);
    expect(JSON.stringify(blocks)).not.toMatch(/```/);
  });

  it('gives commission rows index-stable ids and coalesces into one activity chain', () => {
    const blocks = transcriptToBlocks([line({ kind: 'message', text: JSON.stringify(CONTRACTS) })]);
    const ids = blocks.filter(isTool).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
  });

  it('leaves a NON-contract JSON array as a fenced ```json block (no false positives)', () => {
    const arr = JSON.stringify([
      { contract: 'part-0', files: ['src/a.ts'] },
      { contract: 'part-1', files: ['src/b.ts'] },
    ]);
    const [block] = transcriptToBlocks([line({ kind: 'message', text: arr })]);
    expect(block).toMatchObject({ type: 'text' });
    expect((block as { text: string }).text).toMatch(/^```json\n/);
  });

  it('does NOT split a still-streaming contract array (mid-stream stays fenced)', () => {
    const partial = JSON.stringify(CONTRACTS).slice(0, 60); // truncated, unparseable
    const blocks = transcriptToBlocks([line({ kind: 'message', text: partial, streaming: true })]);
    expect(blocks.filter(isTool)).toHaveLength(0);
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
