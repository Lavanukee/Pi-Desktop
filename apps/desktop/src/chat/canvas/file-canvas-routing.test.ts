/**
 * Unit coverage for the pure round-7 canvas routers: file-write detection
 * (which tool calls write files, redirect parsing, path resolution) and
 * interactive-bash → terminal classification. No React / IPC here.
 */
import type { ChatMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import { bashRedirectTarget, detectFileWrites, dirname, resolvePath } from './file-writes';
import { detectBashTerminals, isInteractiveCommand } from './terminal-routing';

type ToolCall = Extract<ContentBlock, { type: 'toolCall' }>;

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const assistant = (id: string, blocks: ContentBlock[]): ChatMsg =>
  ({ kind: 'assistant', id, blocks, timestamp: 0, isStreaming: false }) as ChatMsg;
const result = (id: string, out: string): ToolResultMsg => ({
  kind: 'toolResult',
  id,
  toolCallId: id,
  toolName: 'x',
  text: out,
  isError: false,
  timestamp: 0,
});

describe('resolvePath', () => {
  it('joins a relative path onto the cwd and collapses . / ..', () => {
    expect(resolvePath('/home/p', 'src/a.ts')).toBe('/home/p/src/a.ts');
    expect(resolvePath('/home/p', './x/../y.ts')).toBe('/home/p/y.ts');
  });
  it('passes an absolute path through', () => {
    expect(resolvePath('/home/p', '/etc/hosts')).toBe('/etc/hosts');
  });
  it('handles a missing cwd', () => {
    expect(resolvePath(undefined, 'a/b.ts')).toBe('a/b.ts');
  });
});

describe('dirname', () => {
  it('returns the parent directory', () => {
    expect(dirname('/a/b/c.ts')).toBe('/a/b');
    expect(dirname('/a')).toBe('/');
  });
});

describe('bashRedirectTarget', () => {
  it('finds a `>` / `>>` redirect target', () => {
    expect(bashRedirectTarget('echo hi > out.txt')).toBe('out.txt');
    expect(bashRedirectTarget('cat a >> log/app.log')).toBe('log/app.log');
  });
  it('finds a tee target and ignores /dev/null + fd dups', () => {
    expect(bashRedirectTarget('foo | tee -a build.log')).toBe('build.log');
    expect(bashRedirectTarget('noisy 2>&1 > /dev/null')).toBeUndefined();
  });
  it('returns undefined for a command with no redirect', () => {
    expect(bashRedirectTarget('ls -la /tmp')).toBeUndefined();
  });
});

describe('detectFileWrites', () => {
  it('detects a whole-file write with its content hint (running until a result)', () => {
    const msgs = [assistant('a1', [call('c1', 'write', { path: 'a.ts', content: 'hi' })])];
    const [ev] = detectFileWrites(msgs, '/proj');
    expect(ev?.path).toBe('/proj/a.ts');
    expect(ev?.filename).toBe('a.ts');
    expect(ev?.running).toBe(true);
    expect(ev?.contentHint).toBe('hi');
  });

  it('detects a str_replace edit as an EDIT HUNK (old/new strings), no content hint', () => {
    const msgs = [
      assistant('a1', [call('c1', 'edit', { path: '/x/b.ts', oldText: 'a', newText: 'b' })]),
      result('c1', 'ok'),
    ];
    const [ev] = detectFileWrites(msgs, '/proj');
    expect(ev?.path).toBe('/x/b.ts');
    expect(ev?.running).toBe(false);
    expect(ev?.contentHint).toBeUndefined();
    // The hunk drives the LIVE DIFF in the canvas (deletions + additions).
    expect(ev?.edit).toEqual({ oldText: 'a', newText: 'b' });
  });

  it('reads a STREAMING str_replace hunk from argsText (path closed, new_string partial)', () => {
    const streaming = assistant('a1', [
      {
        type: 'toolCall',
        id: 'c1',
        name: 'str_replace',
        arguments: {},
        argsText: '{"path":"b.ts","old_string":"foo","new_string":"ba',
      } as ContentBlock,
    ]);
    const [ev] = detectFileWrites([streaming], '/proj');
    expect(ev?.path).toBe('/proj/b.ts');
    expect(ev?.running).toBe(true);
    expect(ev?.contentHint).toBeUndefined();
    // Old string fully arrived, new string still streaming — both feed the diff.
    expect(ev?.edit).toEqual({ oldText: 'foo', newText: 'ba' });
  });

  it('keeps a whole-file write as a content hint (NOT an edit hunk)', () => {
    const msgs = [assistant('a1', [call('c1', 'write', { path: 'a.ts', content: 'hello' })])];
    const [ev] = detectFileWrites(msgs, '/proj');
    expect(ev?.contentHint).toBe('hello');
    expect(ev?.edit).toBeUndefined();
  });

  it('detects a bash redirect write and dedupes by path (last write wins)', () => {
    const msgs = [
      assistant('a1', [call('c1', 'bash', { command: 'echo one > note.md' })]),
      assistant('a2', [call('c2', 'bash', { command: 'echo two >> note.md' })]),
    ];
    const events = detectFileWrites(msgs, '/proj');
    expect(events).toHaveLength(1);
    expect(events[0]?.path).toBe('/proj/note.md');
    expect(events[0]?.callId).toBe('c2');
  });

  it('ignores non-writing tools', () => {
    const msgs = [assistant('a1', [call('c1', 'bash', { command: 'ls -la' })])];
    expect(detectFileWrites(msgs, '/proj')).toHaveLength(0);
  });
});

describe('isInteractiveCommand', () => {
  it('matches dev servers, watchers, and REPLs', () => {
    expect(isInteractiveCommand('npm run dev')).toBe(true);
    expect(isInteractiveCommand('pnpm dev')).toBe(true);
    expect(isInteractiveCommand('vite')).toBe(true);
    expect(isInteractiveCommand('tail -f app.log')).toBe(true);
    expect(isInteractiveCommand('python3 -m http.server 8000')).toBe(true);
    expect(isInteractiveCommand('node server.js &')).toBe(true);
  });
  it('rejects ordinary one-shot commands', () => {
    expect(isInteractiveCommand('ls -la')).toBe(false);
    expect(isInteractiveCommand('git status')).toBe(false);
    expect(isInteractiveCommand('echo hi')).toBe(false);
  });
});

describe('detectBashTerminals', () => {
  it('mirrors only interactive bash calls, carrying output + running state', () => {
    const msgs = [
      assistant('a1', [call('c1', 'bash', { command: 'ls' })]),
      assistant('a2', [call('c2', 'bash', { command: 'npm run dev' })]),
      result('c2', 'VITE ready'),
    ];
    const events = detectBashTerminals(msgs);
    expect(events).toHaveLength(1);
    expect(events[0]?.callId).toBe('c2');
    expect(events[0]?.output).toBe('VITE ready');
    expect(events[0]?.running).toBe(false);
  });
});
