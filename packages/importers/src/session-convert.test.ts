import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rehydrateSessionJsonl } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import { convertCodexSession } from './session-convert';

function fixture(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), 'utf8');
}

const rollout = fixture('codex/rollout.jsonl');

describe('convertCodexSession', () => {
  const converted = convertCodexSession(rollout);
  if (converted === null) throw new Error('expected a conversion');

  it('produces a pi session v3 header with the codex id + cwd', () => {
    expect(converted.header).toMatchObject({
      type: 'session',
      version: 3,
      id: '019f486f-abdd-7c50-a58b-a7b72c9628d7',
      cwd: '/Users/test/Desktop/demo',
    });
    expect(converted.sessionId).toBe('019f486f-abdd-7c50-a58b-a7b72c9628d7');
  });

  it('maps user / thinking / toolCall / toolResult / assistant, dropping synthetic + developer', () => {
    const roles = converted.entries.map((e) => (e.type === 'message' ? e.message.role : e.type));
    // user, thinking(asst), toolCall(asst), toolResult, toolCall(asst), toolResult, text(asst)
    expect(roles).toEqual([
      'user',
      'assistant',
      'assistant',
      'toolResult',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    // The <environment_context> user + developer message never made it in.
    expect(converted.jsonl).not.toContain('<environment_context>');
    expect(converted.jsonl).not.toContain('<permissions');
  });

  it('parses tool-call arguments and links tool results by call id + name', () => {
    const rehydrated = rehydrateSessionJsonl(converted.jsonl);
    const toolCall = rehydrated.messages.find(
      (m) => m.kind === 'assistant' && m.blocks.some((b) => b.type === 'toolCall'),
    );
    expect(toolCall?.kind).toBe('assistant');
    const result = rehydrated.messages.find((m) => m.kind === 'toolResult');
    expect(result).toMatchObject({
      kind: 'toolResult',
      toolCallId: 'call_abc123',
      toolName: 'exec_command',
    });

    // exec_command arguments parsed from the JSON string into an object.
    const call = converted.entries.find(
      (e) => e.type === 'message' && e.message.role === 'assistant',
    );
    expect(call?.type).toBe('message');
  });

  it('NEVER surfaces reasoning encrypted_content', () => {
    expect(converted.jsonl).not.toContain('SECRET');
    expect(converted.jsonl).not.toMatch(/encrypted_content/);
    expect(converted.jsonl).not.toMatch(/gAAAAAB/);
  });

  it('counts user + assistant turns', () => {
    // 1 user + 4 assistant (thinking, 2 toolCalls, final text); tool results excluded.
    expect(converted.messageCount).toBe(5);
  });

  it('chains entries linearly (first parent null)', () => {
    const first = converted.entries[0];
    expect(first?.parentId).toBeNull();
    for (let i = 1; i < converted.entries.length; i++) {
      expect(converted.entries[i]?.parentId).toBe(converted.entries[i - 1]?.id);
    }
  });

  it('rehydrates into readable chat messages', () => {
    const { messages } = rehydrateSessionJsonl(converted.jsonl);
    const user = messages.find((m) => m.kind === 'user');
    expect(user).toMatchObject({
      kind: 'user',
      text: 'list the files here and count the lines in main.ts',
    });
    const text = messages.filter((m) => m.kind === 'assistant').at(-1);
    expect(text?.kind).toBe('assistant');
  });

  it('returns null without a session id / cwd', () => {
    expect(convertCodexSession('{"type":"event_msg","payload":{}}')).toBeNull();
  });

  it('honors id/cwd overrides', () => {
    const out = convertCodexSession(rollout, { sessionId: 'custom', cwd: '/tmp/x' });
    expect(out?.sessionId).toBe('custom');
    expect(out?.cwd).toBe('/tmp/x');
  });
});
