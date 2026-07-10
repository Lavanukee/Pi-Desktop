import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { installImageSanitizer, MIN_IMAGE_DATA_LENGTH, sanitizeImageBlocks } from './sanitizer.js';

const goodImage = { type: 'image', data: 'A'.repeat(MIN_IMAGE_DATA_LENGTH), mimeType: 'image/png' };

describe('sanitizeImageBlocks', () => {
  it('drops image blocks with missing/short/non-string data', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: '' }, // empty
          { type: 'image', data: 'short' }, // < threshold
          { type: 'image' }, // missing data
          { type: 'image', data: 12345 }, // non-string
          goodImage, // valid — kept
        ],
      },
    ];
    const { messages: cleaned, changed } = sanitizeImageBlocks(messages);
    expect(changed).toBe(true);
    const content = (cleaned[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(2);
    expect(content).toEqual([{ type: 'text', text: 'hello' }, goodImage]);
  });

  it('leaves clean messages untouched (changed=false)', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, goodImage] },
      { role: 'assistant', content: 'plain string content' },
    ];
    const { changed } = sanitizeImageBlocks(messages);
    expect(changed).toBe(false);
  });

  it('does not mutate the original message array', () => {
    const original = [{ role: 'user', content: [{ type: 'image', data: 'x' }] }];
    const snapshot = JSON.stringify(original);
    sanitizeImageBlocks(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

type ContextHandler = (event: { messages: unknown[] }) => { messages: unknown[] } | undefined;

describe('installImageSanitizer', () => {
  it('registers a context hook that only returns a change when something was stripped', () => {
    const handlers: ContextHandler[] = [];
    const fakePi = {
      on(event: string, handler: unknown) {
        if (event === 'context') handlers.push(handler as ContextHandler);
      },
    };
    installImageSanitizer(fakePi as unknown as ExtensionAPI);
    expect(handlers).toHaveLength(1);
    const [handler] = handlers;
    if (handler === undefined) throw new Error('context handler not registered');

    const dirty = handler({ messages: [{ role: 'user', content: [{ type: 'image', data: '' }] }] });
    expect(dirty).toBeDefined();
    expect(dirty?.messages[0]).toEqual({ role: 'user', content: [] });

    const clean = handler({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
    });
    expect(clean).toBeUndefined();
  });
});
