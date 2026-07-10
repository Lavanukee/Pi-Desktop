/**
 * Wave B #3b — skill-instructions framing. A SKILL/tool-instructions file the
 * model READS must reach it wrapped as `<skill_instructions>`, never as a bare
 * (user-looking) turn. These cover the pure detector/wrapper and the context
 * hook, structurally (no live pi).
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  isSkillPath,
  registerSkillInstructions,
  SKILL_INSTRUCTIONS_TAG,
  type SkillContextMessage,
  skillNameFromPath,
  withSkillInstructions,
  wrapSkillContent,
} from './skill-instructions.js';

const OPEN = `<${SKILL_INSTRUCTIONS_TAG}`;
const CLOSE = `</${SKILL_INSTRUCTIONS_TAG}>`;

const readCall = (id: string, path: string, name = 'read'): SkillContextMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: { path } }],
    timestamp: 0,
  }) as unknown as SkillContextMessage;

const toolResult = (id: string, text: string, toolName = 'read'): SkillContextMessage =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
  }) as unknown as SkillContextMessage;

const userMsg = (text: string): SkillContextMessage =>
  ({ role: 'user', content: text, timestamp: 0 }) as unknown as SkillContextMessage;

const SKILL_MD = '/Users/jedd/.pi/agent/skills/code-review/SKILL.md';

/** Concatenated text of a toolResult message (mirrors the provider's join). */
function resultText(msg: SkillContextMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b as { text?: unknown }).text)
    .filter((t): t is string => typeof t === 'string')
    .join('');
}

describe('isSkillPath', () => {
  it('matches SKILL.md and pi skills-dir files, case-insensitively', () => {
    expect(isSkillPath(SKILL_MD)).toBe(true);
    expect(isSkillPath('/Users/jedd/.pi/agent/skills/code-review/skill.md')).toBe(true);
    // Project skills dir (<cwd>/.pi/skills/…) and a skill's supporting file.
    expect(isSkillPath('/repo/.pi/skills/debugging/SKILL.md')).toBe(true);
    expect(isSkillPath('/Users/jedd/.pi/agent/skills/pdf-toolkit/references/forms.md')).toBe(true);
    // Windows separators.
    expect(isSkillPath('C:\\Users\\j\\.pi\\agent\\skills\\x\\SKILL.md')).toBe(true);
  });

  it('does NOT match plain files or undefined', () => {
    expect(isSkillPath('/repo/src/index.ts')).toBe(false);
    expect(isSkillPath('/repo/docs/SKILLS.md')).toBe(false); // not SKILL.md, not under skills/
    expect(isSkillPath(undefined)).toBe(false);
    expect(isSkillPath('')).toBe(false);
  });
});

describe('skillNameFromPath', () => {
  it('uses the folder holding SKILL.md (pi convention)', () => {
    expect(skillNameFromPath(SKILL_MD)).toBe('code-review');
  });
  it('uses the segment after skills/ for a supporting file', () => {
    expect(skillNameFromPath('/x/.pi/agent/skills/pdf-toolkit/references/f.md')).toBe(
      'pdf-toolkit',
    );
  });
});

describe('wrapSkillContent', () => {
  it('wraps a content-block array in the named marker', () => {
    const wrapped = wrapSkillContent([{ type: 'text', text: 'Do the thing.' }], 'code-review');
    const text = (wrapped as { text: string }[]).map((b) => b.text).join('');
    expect(text).toBe(`${OPEN} name="code-review">\nDo the thing.\n${CLOSE}`);
  });

  it('wraps a plain string', () => {
    expect(wrapSkillContent('body', 'x')).toBe(`${OPEN} name="x">\nbody\n${CLOSE}`);
  });

  it('is idempotent — returns the SAME reference when already wrapped', () => {
    const once = wrapSkillContent([{ type: 'text', text: 'body' }], 'x');
    expect(wrapSkillContent(once, 'x')).toBe(once);
  });
});

describe('withSkillInstructions', () => {
  it('wraps the tool result of a skill read, keyed by toolCallId', () => {
    const { messages, changed } = withSkillInstructions([
      userMsg('review my diff'),
      readCall('c1', SKILL_MD),
      toolResult('c1', 'You are a code reviewer. Do X.'),
    ]);
    expect(changed).toBe(true);
    const text = resultText(messages[2] as SkillContextMessage);
    expect(text).toContain(`${OPEN} name="code-review">`);
    expect(text).toContain('You are a code reviewer. Do X.');
    expect(text.trimEnd().endsWith(CLOSE)).toBe(true);
  });

  it('leaves a NORMAL file read untouched (no change)', () => {
    const input = [readCall('c1', '/repo/src/app.ts'), toolResult('c1', 'export const x = 1;')];
    const { changed } = withSkillInstructions(input);
    expect(changed).toBe(false);
  });

  it('does NOT reframe an edit/write to a skill file (only reads)', () => {
    const input = [
      readCall('c1', SKILL_MD, 'edit'), // an edit call, not a read
      toolResult('c1', 'ok', 'edit'),
    ];
    const { changed } = withSkillInstructions(input);
    expect(changed).toBe(false);
  });

  it('is idempotent across calls — feeding its output back re-wraps only once', () => {
    const base = [readCall('c1', SKILL_MD), toolResult('c1', 'instructions')];
    const first = withSkillInstructions(base).messages;
    const second = withSkillInstructions(first);
    expect(second.changed).toBe(false);
    const occurrences =
      resultText(second.messages[1] as SkillContextMessage).split(OPEN).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('registerSkillInstructions', () => {
  it("registers a 'context' handler that wraps skill reads", () => {
    const handlers: Record<string, (e: { messages: SkillContextMessage[] }) => unknown> = {};
    const pi = {
      on: (event: string, h: (e: { messages: SkillContextMessage[] }) => unknown) => {
        handlers[event] = h;
      },
    } as unknown as ExtensionAPI;
    registerSkillInstructions(pi);
    expect(handlers.context).toBeDefined();
    const out = handlers.context?.({
      messages: [readCall('c1', SKILL_MD), toolResult('c1', 'body')],
    }) as { messages: SkillContextMessage[] } | undefined;
    expect(out).toBeDefined();
    expect(resultText((out?.messages[1] ?? userMsg('')) as SkillContextMessage)).toContain(OPEN);
  });

  it('returns undefined (no change) when there is no skill read', () => {
    const handlers: Record<string, (e: { messages: SkillContextMessage[] }) => unknown> = {};
    const pi = {
      on: (event: string, h: (e: { messages: SkillContextMessage[] }) => unknown) => {
        handlers[event] = h;
      },
    } as unknown as ExtensionAPI;
    registerSkillInstructions(pi);
    expect(handlers.context?.({ messages: [userMsg('hi')] })).toBeUndefined();
  });
});
