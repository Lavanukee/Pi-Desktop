import { describe, expect, it } from 'vitest';
import { mcpInputSchemaToTypeBox, mcpResultToPiContent, oneLineDescription } from './schema';

describe('mcpInputSchemaToTypeBox', () => {
  it('carries the MCP JSON schema through unchanged', () => {
    const schema = {
      type: 'object',
      properties: { message: { type: 'string' }, count: { type: 'number' } },
      required: ['message'],
    };
    const out = mcpInputSchemaToTypeBox(schema) as unknown as Record<string, unknown>;
    expect(out.type).toBe('object');
    expect(out.properties).toEqual(schema.properties);
    expect(out.required).toEqual(['message']);
  });

  it('defaults a missing schema to an open object', () => {
    const out = mcpInputSchemaToTypeBox(undefined) as unknown as Record<string, unknown>;
    expect(out.type).toBe('object');
    expect(out.properties).toEqual({});
  });
});

describe('mcpResultToPiContent', () => {
  it('maps text content', () => {
    expect(mcpResultToPiContent({ content: [{ type: 'text', text: 'hi' }] })).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });

  it('maps image content with a default mime type', () => {
    expect(mcpResultToPiContent({ content: [{ type: 'image', data: 'AAAA' }] })).toEqual([
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  it('serialises unknown content blocks as JSON text', () => {
    const res = mcpResultToPiContent({ content: [{ type: 'resource', uri: 'x://y' }] });
    expect(res[0]?.type).toBe('text');
    expect(res[0]).toMatchObject({ type: 'text' });
    expect((res[0] as { text: string }).text).toContain('x://y');
  });

  it('falls back to a placeholder when there is no content', () => {
    expect(mcpResultToPiContent({ content: [] })[0]?.type).toBe('text');
    expect(mcpResultToPiContent(undefined)).toHaveLength(1);
  });

  it('notes errors in the empty-content fallback', () => {
    const res = mcpResultToPiContent({ content: [], isError: true });
    expect((res[0] as { text: string }).text).toMatch(/error/i);
  });
});

describe('oneLineDescription', () => {
  it('collapses whitespace', () => {
    expect(oneLineDescription('a\n  b\t c')).toBe('a b c');
  });

  it('truncates with an ellipsis', () => {
    const out = oneLineDescription('x'.repeat(200), 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles undefined', () => {
    expect(oneLineDescription(undefined)).toBe('');
  });
});
