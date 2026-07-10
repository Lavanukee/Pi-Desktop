import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../types/rpc';
import {
  parseSessionJsonl,
  rehydrateMessages,
  rehydrateSessionJsonl,
  sessionMessages,
} from './rehydrate';

const here = path.dirname(fileURLToPath(import.meta.url));
const sessionText = readFileSync(path.join(here, 'test-helpers/fixtures/session-v3.jsonl'), 'utf8');

describe('parseSessionJsonl', () => {
  it('parses the v3 header and all tree entries', () => {
    const { header, entries } = parseSessionJsonl(sessionText);
    expect(header).toMatchObject({ type: 'session', version: 3, cwd: '/Users/dev/project' });
    expect(entries).toHaveLength(14);
    expect(entries.map((e) => e.type)).toContain('branch_summary');
  });

  it('tolerates a corrupt trailing line (crash mid-append)', () => {
    const { entries } = parseSessionJsonl(`${sessionText}{"type":"message","id":"tr`);
    expect(entries).toHaveLength(14);
  });
});

describe('sessionMessages (active-branch walk)', () => {
  it('follows the leaf chain and excludes abandoned branches', () => {
    const { messages, truncated } = sessionMessages(parseSessionJsonl(sessionText).entries);
    expect(messages).toHaveLength(8);
    expect(truncated).toBe(false);
    const allText = JSON.stringify(messages);
    expect(allText).not.toContain('ABANDONED BRANCH');
  });

  it('returns no messages for an empty entry list', () => {
    expect(sessionMessages([])).toEqual({ messages: [], truncated: false });
  });
});

describe('rehydrateSessionJsonl round trip', () => {
  it('produces the same ChatMsg union the live router emits', () => {
    const { messages: msgs, truncated } = rehydrateSessionJsonl(sessionText);
    expect(truncated).toBe(false);
    expect(msgs.map((m) => m.kind)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
      'bashExec',
      'user',
      'assistant',
      'user',
    ]);

    const [firstUser, firstAssistant, toolResult, , bashExec] = msgs;
    expect(firstUser).toMatchObject({
      kind: 'user',
      text: 'find the assets folder and list what is inside',
      timestamp: 1776825699954,
    });
    expect(firstAssistant).toMatchObject({
      kind: 'assistant',
      stopReason: 'toolUse',
      model: 'qwen3.6-35b-a3b',
      provider: 'llamacpp',
      isStreaming: false,
    });
    if (firstAssistant?.kind === 'assistant') {
      expect(firstAssistant.blocks.map((b) => b.type)).toEqual(['thinking', 'toolCall']);
      const call = firstAssistant.blocks[1];
      if (call?.type === 'toolCall') {
        expect(call.name).toBe('bash');
        expect(call.arguments.command).toContain('find ~');
      }
    }
    expect(toolResult).toMatchObject({
      kind: 'toolResult',
      toolCallId: 'ZpCILfZc7nFWEQzfsGlFgubamgHnobj3',
      toolName: 'bash',
      isError: false,
    });
    if (toolResult?.kind === 'toolResult') {
      expect(toolResult.text).toContain('/Users/dev/project/Assets');
    }
    expect(bashExec).toMatchObject({
      kind: 'bashExec',
      command: 'ls Assets | wc -l',
      output: '14\n',
      exitCode: 0,
    });
  });

  it('is stable as a snapshot (regression net for W3)', () => {
    expect(rehydrateSessionJsonl(sessionText)).toMatchSnapshot();
  });
});

describe('legacy session versions (pi migrates these on load; so must we)', () => {
  // v1: no header version, entries are a linear sequence with no id/parentId.
  const v1Jsonl = [
    JSON.stringify({
      type: 'session',
      id: 'abc-123',
      timestamp: '2025-01-01T00:00:00.000Z',
      cwd: '/home/user',
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2025-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'hello from v1', timestamp: 1735689601000 },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2025-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi back' }],
        timestamp: 1735689602000,
      },
    }),
  ].join('\n');

  it('rehydrates a v1 file by synthesizing the id chain (was: silently empty)', () => {
    const parsed = parseSessionJsonl(v1Jsonl);
    expect(parsed.header).toMatchObject({ type: 'session', id: 'abc-123' });
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.parentId).toBeNull();
    expect(parsed.entries[1]?.parentId).toBe(parsed.entries[0]?.id);

    const { messages, truncated } = rehydrateSessionJsonl(v1Jsonl);
    expect(truncated).toBe(false);
    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    expect(messages[0]).toMatchObject({ text: 'hello from v1' });
  });

  it('renames v2 hookMessage roles to custom (kept faithful, skipped by rendering)', () => {
    const v2Jsonl = [
      JSON.stringify({ type: 'session', version: 2, id: 's2', timestamp: 't', cwd: '/' }),
      JSON.stringify({
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: 't',
        message: { role: 'hookMessage', customType: 'x', content: 'hook', timestamp: 1 },
      }),
      JSON.stringify({
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: 't',
        message: { role: 'user', content: 'hi', timestamp: 2 },
      }),
    ].join('\n');
    const parsed = parseSessionJsonl(v2Jsonl);
    const first = parsed.entries[0];
    expect(first?.type === 'message' && first.message.role).toBe('custom');
    const { messages } = rehydrateSessionJsonl(v2Jsonl);
    expect(messages.map((m) => m.kind)).toEqual(['user']);
  });
});

describe('mid-file corruption (broken parent chain must be signalled, not silent)', () => {
  const line = (obj: unknown): string => JSON.stringify(obj);
  const msg = (id: string, parentId: string | null, role: string, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2025-01-01T00:00:00.000Z',
    message:
      role === 'user'
        ? { role, content: text, timestamp: 1 }
        : { role, content: [{ type: 'text', text }], timestamp: 1 },
  });

  it('flags truncated history when a middle line is corrupt', () => {
    const text = [
      line({ type: 'session', version: 3, id: 's1', timestamp: 't', cwd: '/' }),
      line(msg('e1', null, 'user', 'first question')),
      line(msg('e2', 'e1', 'assistant', 'first answer')),
      // e3 truncated mid-write:
      line(msg('e3', 'e2', 'user', 'second question')).slice(0, 40),
      line(msg('e4', 'e3', 'assistant', 'second answer')),
      line(msg('e5', 'e4', 'user', 'third question')),
    ].join('\n');
    const { messages, truncated } = rehydrateSessionJsonl(text);
    // The rendered branch stays consistent with pi's own walk (no
    // reconstruction) — but the loss is now visible to the caller.
    expect(messages).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('a corrupt trailing line (the documented crash-mid-append case) is not truncation', () => {
    const text = [
      line({ type: 'session', version: 3, id: 's1', timestamp: 't', cwd: '/' }),
      line(msg('e1', null, 'user', 'first question')),
      line(msg('e2', 'e1', 'assistant', 'first answer')),
      line(msg('e3', 'e2', 'user', 'second question')).slice(0, 40),
    ].join('\n');
    const { messages, truncated } = rehydrateSessionJsonl(text);
    expect(messages).toHaveLength(2);
    expect(truncated).toBe(false);
  });
});

describe('rehydrateMessages edge shapes', () => {
  it('handles string content, missing fields, and unknown roles', () => {
    const raw = [
      { role: 'user', content: 'plain string', timestamp: 1 },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: '', mimeType: 'image/png' },
          { type: 'text', text: 'b' },
        ],
        timestamp: 2,
      },
      { role: 'custom', customType: 'x', content: 'hidden', display: false, timestamp: 3 },
      { role: 'branchSummary', summary: 's', fromId: 'f', timestamp: 4 },
      null,
    ] as unknown as AgentMessage[];
    const msgs = rehydrateMessages(raw);
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'user']);
    expect(msgs[1]).toMatchObject({ text: 'a\nb', images: ['data:image/png;base64,'] });
  });

  it('preserves user image attachments as data URIs', () => {
    const raw = [
      {
        role: 'user',
        content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
        timestamp: 1,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this screenshot?' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        ],
        timestamp: 2,
      },
      // Malformed image blocks (non-string data) are skipped, not crashed on.
      {
        role: 'user',
        content: [
          { type: 'text', text: 'plain' },
          { type: 'image', data: 42, mimeType: 'image/png' },
        ],
        timestamp: 3,
      },
    ] as unknown as AgentMessage[];
    const msgs = rehydrateMessages(raw);
    expect(msgs[0]).toMatchObject({
      kind: 'user',
      text: '',
      images: ['data:image/png;base64,iVBORw0KGgo='],
    });
    expect(msgs[1]).toMatchObject({
      kind: 'user',
      text: 'what is in this screenshot?',
      images: ['data:image/png;base64,iVBORw0KGgo='],
    });
    expect(msgs[2]).toMatchObject({ kind: 'user', text: 'plain' });
    expect((msgs[2] as { images?: string[] }).images).toBeUndefined();
  });

  it('assigns unique ids to blocks missing tool call ids', () => {
    const raw = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'bash', arguments: {} },
          { type: 'toolCall', name: 'read', arguments: {} },
        ],
        stopReason: 'toolUse',
        timestamp: 5,
      },
    ] as unknown as AgentMessage[];
    const [assistant] = rehydrateMessages(raw);
    if (assistant?.kind !== 'assistant') throw new Error('expected assistant');
    const ids = assistant.blocks.flatMap((b) => (b.type === 'toolCall' ? [b.id] : []));
    expect(new Set(ids).size).toBe(2);
  });
});
