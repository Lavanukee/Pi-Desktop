/**
 * The `capability` tool — the replacement for `tool_search`.
 *
 * Called bare it lists what is on offer; called with a name it turns that group
 * on and says, in the result, exactly which tools the model now has and how to
 * use them well. One call, a fixed set, no scoring, nothing to loop on.
 *
 * See ./presets/capabilities.ts for why a named group beats a search.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import {
  CAPABILITIES,
  CAPABILITY_TOOL_NAME,
  capabilityActivated,
  capabilityMenu,
  findCapability,
} from '../presets/capabilities.js';

export interface CapabilityToolOptions {
  /** Turn the named tools on. The harness unions them into the active set. */
  readonly onActivate: (tools: readonly string[]) => void;
  /** Every tool name registered in this build. */
  readonly available: () => readonly string[];
}

export function registerCapabilityTool(pi: ExtensionAPI, opts: CapabilityToolOptions): void {
  const names = CAPABILITIES.map((c) => c.name).join(', ');
  pi.registerTool({
    name: CAPABILITY_TOOL_NAME,
    label: 'Capability',
    description:
      'Turn on a group of tools you need but do not currently have. Call it with no argument ' +
      `to see what is available, or with a name to switch that group on: ${names}. The tools ` +
      'arrive immediately and you can use them in your very next action. Turn on only what the ' +
      'task actually needs.',
    promptSnippet: 'Turn on a group of tools (browser, computer-use, personal, …)',
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description: `The capability to turn on: ${names}. Omit to list them.`,
        }),
      ),
    }),
    async execute(_id, params) {
      const raw = (params as { name?: unknown })?.name;
      const wanted = typeof raw === 'string' ? raw.trim() : '';
      if (wanted === '') {
        return { content: [{ type: 'text', text: capabilityMenu() }], details: undefined };
      }
      const cap = findCapability(wanted);
      if (cap === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: `There is no "${wanted}" capability.\n\n${capabilityMenu()}`,
            },
          ],
          details: undefined,
        };
      }
      const available = opts.available();
      const present = cap.tools.filter((t) => available.includes(t));
      // Activate only what exists — naming an absent tool would have the model
      // call into nothing, and the message below says so honestly instead.
      if (present.length > 0) opts.onActivate(present);
      return {
        content: [{ type: 'text', text: capabilityActivated(cap, available) }],
        details: undefined,
      };
    },
  });
}
