/**
 * `tool_search` — an always-available tool that lets the model discover tools
 * that are registered but not currently active, then pull them into the active
 * set. This is how the "never load all tools at once" rule stays workable: the
 * classifier loads a small preset, and the model expands it on demand.
 *
 * The matching logic ({@link searchTools}) is a pure function so it is unit
 * tested without a live pi session; {@link registerToolSearch} wires it to
 * `pi.getAllTools()` / `pi.setActiveTools()`.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Static, Type } from '@sinclair/typebox';

/** Minimal structural view of a tool for matching (subset of pi's ToolInfo). */
export interface ToolLike {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface ToolMatch {
  readonly name: string;
  readonly description: string;
  readonly score: number;
  /** Whether the tool is currently active. */
  readonly active: boolean;
}

const NAME_WEIGHT = 5;
const NAME_PARTIAL_WEIGHT = 3;
const DESC_WEIGHT = 2;
const PARAM_WEIGHT = 1;

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Extract declared property names from a JSON-Schema/TypeBox-shaped params object. */
function paramNames(parameters: unknown): string[] {
  if (parameters === null || typeof parameters !== 'object') return [];
  const props = (parameters as { properties?: unknown }).properties;
  if (props === null || typeof props !== 'object') return [];
  return Object.keys(props as Record<string, unknown>);
}

export interface SearchToolsOptions {
  readonly limit?: number;
  /** Names currently active, used to tag matches (does not affect scoring). */
  readonly activeToolNames?: readonly string[];
}

/**
 * Score `tools` against a free-text `query` and return the best matches,
 * highest score first. Matches on tool name (highest weight), description, and
 * parameter names (lowest). Tools with zero score are excluded.
 */
export function searchTools(
  tools: readonly ToolLike[],
  query: string,
  opts: SearchToolsOptions = {},
): ToolMatch[] {
  const { limit = 10, activeToolNames = [] } = opts;
  const active = new Set(activeToolNames);
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored: ToolMatch[] = [];
  for (const tool of tools) {
    const nameTokens = new Set(tokenize(tool.name));
    const descTokens = new Set(tokenize(tool.description ?? ''));
    const paramTokens = new Set(paramNames(tool.parameters).flatMap(tokenize));
    const nameLower = tool.name.toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (nameTokens.has(term)) score += NAME_WEIGHT;
      else if (nameLower.includes(term)) score += NAME_PARTIAL_WEIGHT;
      if (descTokens.has(term)) score += DESC_WEIGHT;
      if (paramTokens.has(term)) score += PARAM_WEIGHT;
    }
    if (score > 0) {
      scored.push({
        name: tool.name,
        description: tool.description ?? '',
        score,
        active: active.has(tool.name),
      });
    }
  }

  return scored
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
    .slice(0, limit)
    .map(({ m }) => m);
}

const ToolSearchParams = Type.Object({
  query: Type.String({
    description: 'What capability you need, e.g. "read a pdf" or "http request".',
  }),
  activate: Type.Optional(
    Type.Boolean({
      description: 'If true, add the matched tools to the active tool set so you can call them.',
      default: false,
    }),
  ),
  limit: Type.Optional(Type.Number({ description: 'Max results (default 10).', default: 10 })),
});
type ToolSearchInput = Static<typeof ToolSearchParams>;

export interface ToolSearchOptions {
  /** Override the tool name (default "tool_search"). */
  readonly name?: string;
  /** Called after tools are activated, for status/telemetry. */
  readonly onActivate?: (added: readonly string[]) => void;
}

/**
 * Register the `tool_search` tool on a pi session. It queries `pi.getAllTools()`,
 * returns ranked matches, and — when `activate` is set — unions the matches into
 * the currently active tools via `pi.setActiveTools()`.
 */
export function registerToolSearch(pi: ExtensionAPI, opts: ToolSearchOptions = {}): void {
  const name = opts.name ?? 'tool_search';
  pi.registerTool({
    name,
    label: 'Tool Search',
    description:
      'Search all registered tools by capability and optionally activate them. Use this when you ' +
      'need a tool that is not currently available.',
    promptSnippet:
      'tool_search: find and activate tools that are registered but not currently active.',
    parameters: ToolSearchParams,
    async execute(_toolCallId, params: ToolSearchInput, _signal, _onUpdate, _ctx) {
      const all = pi.getAllTools();
      const active = pi.getActiveTools();
      const matches = searchTools(all, params.query, {
        limit: params.limit ?? 10,
        activeToolNames: active,
      });

      if (matches.length === 0) {
        return {
          content: [{ type: 'text', text: `No tools matched "${params.query}".` }],
          details: { matches: [], activated: [] as string[] },
        };
      }

      let activated: string[] = [];
      if (params.activate) {
        const toAdd = matches.filter((m) => !m.active).map((m) => m.name);
        if (toAdd.length > 0) {
          const next = Array.from(new Set([...active, ...toAdd]));
          pi.setActiveTools(next);
          activated = toAdd;
          opts.onActivate?.(toAdd);
        }
      }

      const lines = matches.map(
        (m) => `- ${m.name}${m.active ? ' (active)' : ''} — ${m.description || 'no description'}`,
      );
      const header = params.activate
        ? activated.length > 0
          ? `Activated: ${activated.join(', ')}\n`
          : 'All matches were already active.\n'
        : '';
      return {
        content: [{ type: 'text', text: `${header}${lines.join('\n')}` }],
        details: { matches: matches.map((m) => m.name), activated },
      };
    },
  });
}
