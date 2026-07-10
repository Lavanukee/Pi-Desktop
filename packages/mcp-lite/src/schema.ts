/**
 * Translation between MCP wire shapes and pi's tool surface.
 *
 * - {@link mcpInputSchemaToTypeBox}: MCP tool `inputSchema` (opaque JSON Schema)
 *   → a TypeBox `TSchema` accepted by `pi.registerTool({ parameters })`. We wrap
 *   with `Type.Unsafe` rather than remodelling, so the server's schema reaches
 *   the model unchanged (native mode).
 * - {@link mcpResultToPiContent}: MCP `tools/call` result content → pi tool
 *   result content blocks.
 * - {@link oneLineDescription}: collapse a multi-line description to a compact
 *   one-liner for the lite-mode catalog.
 */
import { type TSchema, Type } from '@sinclair/typebox';
import type { JsonSchema, McpContentItem, McpToolCallResult } from './mcp-types';

/** pi tool result content block (structurally a pi-ai TextContent/ImageContent). */
export type PiContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Wrap an MCP tool's JSON input schema as a TypeBox schema for registerTool.
 * Missing/empty schemas become an open object so the model can still call.
 */
export function mcpInputSchemaToTypeBox(schema: JsonSchema | undefined): TSchema {
  const base =
    schema && typeof schema === 'object' && schema.type !== undefined
      ? schema
      : { type: 'object', properties: {}, ...(schema ?? {}) };
  return Type.Unsafe(base);
}

/** Map an MCP `tools/call` result into pi tool-result content blocks. */
export function mcpResultToPiContent(result: McpToolCallResult | undefined): PiContentItem[] {
  const items: McpContentItem[] = Array.isArray(result?.content) ? result.content : [];
  const content: PiContentItem[] = [];
  for (const it of items) {
    if (it.type === 'text') {
      content.push({ type: 'text', text: it.text ?? '' });
    } else if (it.type === 'image' && typeof it.data === 'string') {
      content.push({
        type: 'image',
        mimeType: typeof it.mimeType === 'string' ? it.mimeType : 'image/png',
        data: it.data,
      });
    } else {
      content.push({ type: 'text', text: JSON.stringify(it) });
    }
  }
  if (content.length === 0) {
    content.push({
      type: 'text',
      text: result?.isError ? 'MCP tool returned an error with no content.' : 'OK (no content).',
    });
  }
  return content;
}

/** Collapse whitespace and truncate a description for compact catalog listing. */
export function oneLineDescription(desc: string | undefined, max = 140): string {
  const flat = (desc ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}
