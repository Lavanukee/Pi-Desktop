/**
 * `use` — call a tool the model has been TOLD about but which is not in its
 * advertised tool list.
 *
 * This is what makes a capability cost nothing. The advertised set stays fixed,
 * so the prompt prefix is never rewritten and no turn pays a re-prefill; a
 * capability just appends a result naming the tools it may now use, and `use`
 * carries the call. Measured against the running server: told about
 * `mac_snapshot` in prose, the model emitted
 * `use({tool:"mac_snapshot",args:{app:"Safari"}})` correctly on the first try.
 *
 * It dispatches through the registry in ./tool-registry.ts, which captures each
 * tool's real `execute` as it registers — pi's own `getAllTools()` omits it.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { ToolRegistry } from './tool-registry.js';

export const USE_TOOL_NAME = 'use';

/** Names that must never be reachable this way — `use` calling itself, mainly. */
const NEVER = new Set([USE_TOOL_NAME]);

export interface UseToolOptions {
  readonly registry: ToolRegistry;
  /** Tools the model already has advertised — it should call those directly. */
  readonly active: () => readonly string[];
}

export function registerUseTool(pi: ExtensionAPI, opts: UseToolOptions): void {
  pi.registerTool({
    name: USE_TOOL_NAME,
    label: 'Use',
    description:
      'Call a tool that a capability told you about but which is not in your tool list. Pass ' +
      'the tool name and its arguments. Tools already IN your list should be called directly ' +
      'rather than through this.',
    promptSnippet: 'Call a tool a capability made available',
    parameters: Type.Object({
      tool: Type.String({ description: 'The tool name, exactly as the capability named it.' }),
      args: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "That tool's arguments." }),
      ),
    }),
    async execute(id, params, ...rest) {
      const p = (params ?? {}) as { tool?: unknown; args?: unknown };
      const name = typeof p.tool === 'string' ? p.tool.trim() : '';
      if (name === '' || NEVER.has(name)) {
        return {
          content: [{ type: 'text', text: 'Pass the name of the tool you want to call.' }],
          details: undefined,
        };
      }
      const target = opts.registry.get(name);
      if (target === undefined) {
        // Say what IS reachable — a bare "unknown tool" invites another guess.
        const known = opts.registry.names().slice(0, 40).join(', ');
        return {
          content: [
            {
              type: 'text',
              text:
                `There is no tool called "${name}". Turn on the capability that provides it, ` +
                `or use one of these: ${known}`,
            },
          ],
          details: undefined,
        };
      }
      const args = p.args !== undefined && p.args !== null ? p.args : {};
      // The target's own errors belong to the target — let them surface as its
      // result rather than being reworded here.
      return (await target.execute(id, args, ...rest)) as never;
    },
  });
}
