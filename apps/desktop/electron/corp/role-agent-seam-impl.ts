/**
 * The APP's impl of the harness {@link RunRoleAgentFn} seam — it adapts the
 * ELECTRON-MAIN role-agent runtime ({@link ./role-agent}) to the pi-AGNOSTIC
 * interface the harness ({@link runCorp}) injects.
 *
 * The harness never imports the pi SDK; it declares the shape it needs
 * ({@link RoleAgentRunInput} → {@link RoleAgentRunOutput}) and this closure fills
 * it, building the in-process keyless `corp-local` provider ONCE (against the same
 * resolved baseUrl/model the chat seam uses) and running each engineer contract as
 * a scoped {@link runRoleAgent} AgentSession.
 *
 * ELECTRON-MAIN ONLY (Node): value-imports the pi SDK via `./role-agent`, which is
 * fine here (the renderer never imports this). It is electron-free, so it stays
 * unit-testable and loadable from the real-server validation script.
 */

import type { AgentToolResult, ToolDefinition } from '@mariozechner/pi-coding-agent';
import type {
  RoleAgentCustomTool,
  RoleAgentRunInput,
  RoleAgentRunOutput,
  RunRoleAgentFn,
} from '@pi-desktop/harness/corp';
import { createCorpModelProvider, runRoleAgent, type SamplingMode } from './role-agent';

/**
 * Convert a harness-neutral {@link RoleAgentCustomTool} (the `function` half of an
 * OpenAI function-tool) into a pi {@link ToolDefinition}. The `parameters` are a
 * plain JSON Schema; the SDK serializes them to the LLM tool schema and does NOT
 * TypeBox-validate custom-tool arguments before dispatch, so a plain object is
 * safe here — the single cast is confined to this seam boundary. The `execute`
 * body is a no-op ack: the CALL itself is the signal (captured via the runtime's
 * `tool_call` event into `toolCalls`); the harness parses the arguments, so the
 * tool never needs to DO anything.
 */
function toToolDefinition(tool: RoleAgentCustomTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as ToolDefinition['parameters'],
    execute: async (): Promise<AgentToolResult<unknown>> => ({
      content: [{ type: 'text', text: `${tool.name} recorded.` }],
      details: undefined,
    }),
  };
}

/** The resolved corp server the role-agents talk to (same baseUrl/model as chat). */
export interface RunRoleAgentConfig {
  /** OpenAI-compat base URL ending in `/v1` (the local llama-server). */
  readonly baseUrl: string;
  /** The served model id. */
  readonly model: string;
}

/**
 * Build the {@link RunRoleAgentFn} the harness injects for engineer (and, later,
 * other) roles. The provider handle is created once and reused across contracts;
 * each call runs one bounded AgentSession and maps its recorded result back to the
 * harness's neutral {@link RoleAgentRunOutput}. Never throws — a misbehaving turn
 * surfaces as a recorded terminal state (the underlying `runRoleAgent` guarantee).
 */
export function createRunRoleAgent(config: RunRoleAgentConfig): RunRoleAgentFn {
  const handle = createCorpModelProvider({ baseUrl: config.baseUrl, model: config.model });

  return async (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
    const result = await runRoleAgent(handle, {
      purpose: input.purpose,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      tools: [...input.tools],
      cwd: input.cwd,
      thinking: input.thinking,
      // The harness SamplingMode and the runtime's SamplingMode are the same
      // string union; keep the narrow cast at the single seam boundary.
      samplingMode: input.samplingMode as SamplingMode,
      ...(input.customTools !== undefined && input.customTools.length > 0
        ? { customTools: input.customTools.map(toToolDefinition) }
        : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });

    return {
      filesWritten: result.filesWritten.map((f) => ({ path: f.path, bytes: f.bytes })),
      finalText: result.finalText,
      toolCalls: result.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      terminatedReason: result.terminatedReason,
      maxTurnOutputTokens: result.maxTurnOutputTokens,
      turns: result.turns,
    };
  };
}
