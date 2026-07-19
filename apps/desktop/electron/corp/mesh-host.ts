/**
 * The PERSISTENT-SESSION HOST for the agent mesh (jedd's model — desktop side): it
 * implements the harness `RunAgentTurn` seam over REAL pi agents. Every mesh agent
 * (CEO, manager, engineers, specialists) is a live pi run that KEEPS ITS MEMORY across
 * turns (its prior conversation is replayed into each new prompt), and its universal
 * `talk_to` / `commission_specialist` tools route through the mesh — so anyone can talk
 * to anyone. Writing a contract (manager → engineer), submitting it (engineer →
 * manager), and commissioning a specialist are all the SAME conversation.
 *
 * It REUSES the tested {@link runRoleAgent} per turn rather than refactoring the pi
 * session lifecycle, so it inherits the sampling, the per-call abort watchdog, the live
 * activity stream, and the tool loop unchanged. This host only adds (a) per-agent
 * MEMORY replay and (b) the communication tools as `ToolDefinition`s whose async
 * `execute` calls the mesh router (the exact shape the `consult` tool already uses to
 * spawn an advisor and await its reply). Fully ADDITIVE — it never touches the existing
 * deterministic corp path.
 *
 * VERIFICATION: the routing, the peer permissions, and the bounds this sits on ARE
 * unit-tested (mesh.ts / corp-mesh.ts). This host itself runs REAL pi sessions, so it
 * is verified end-to-end only on a LIVE run — no unit test exercises a real model.
 */

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import {
  AgentMesh,
  buildCorpRoster,
  COMMISSION_SPECIALIST_TOOL,
  MESH_SPECIALIST_KINDS,
  type MeshAgent,
  type MeshHop,
  type RoleAgentActivity,
  type RunAgentTurn,
  specialistId,
  TALK_TO_TOOL,
  type TalkFn,
} from '@pi-desktop/harness/corp';
import { type CorpModelHandle, runRoleAgent } from './role-agent';

/** Keep an agent's replayed memory bounded so a long conversation never blows the
 * context window — we keep the TAIL (the most recent exchanges). */
const MAX_MEMORY_CHARS = 8000;

/** A pi tool result carrying a single text block (the reply the calling agent reads). */
function textResult(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  details: undefined;
} {
  return { content: [{ type: 'text', text }], details: undefined };
}

/** Build the two universal communication tools for `agent`, bound to the mesh router
 * `talk`: `talk_to` (its non-specialist peers) + `commission_specialist` (all
 * specialties — everyone gets it). Each tool's async execute calls `talk` and returns
 * the peer's reply, exactly like the consult tool awaits an advisor. */
function communicationTools(agent: MeshAgent, talk: TalkFn): ToolDefinition[] {
  const colleagues = agent.peers.filter((p) => !p.startsWith('specialist:'));
  const tools: Array<Record<string, unknown>> = [];

  if (colleagues.length > 0) {
    tools.push({
      name: TALK_TO_TOOL,
      label: TALK_TO_TOOL,
      description: `Send a message to a colleague and get their reply back. This is how you delegate, ask, and report — writing a contract to an engineer, submitting your work to the manager, and asking a question are all just messages. Recipients: ${colleagues.join(', ')}.`,
      promptSnippet: 'Message a colleague and get their reply.',
      parameters: {
        type: 'object',
        properties: {
          recipient: { type: 'string', enum: colleagues, description: 'Who to message.' },
          message: {
            type: 'string',
            description: 'What to say — a request, a contract, a question, or your result.',
          },
        },
        required: ['recipient', 'message'],
      },
      execute: async (_id: unknown, params: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>;
        const recipient = typeof p.recipient === 'string' ? p.recipient : '';
        const message = typeof p.message === 'string' ? p.message : '';
        return textResult(await talk(agent.id, recipient, message));
      },
    });
  }

  tools.push({
    name: COMMISSION_SPECIALIST_TOOL,
    label: COMMISSION_SPECIALIST_TOOL,
    description: `Bring in a specialist to measure or review the product, and get their report back. Specialties: ${MESH_SPECIALIST_KINDS.join(', ')}.`,
    promptSnippet: 'Commission a specialist to measure/review something.',
    parameters: {
      type: 'object',
      properties: {
        specialty: {
          type: 'string',
          enum: [...MESH_SPECIALIST_KINDS],
          description: 'Which specialist to bring in.',
        },
        request: {
          type: 'string',
          description: 'What you want them to check, measure, or answer.',
        },
      },
      required: ['specialty', 'request'],
    },
    execute: async (_id: unknown, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const specialty = typeof p.specialty === 'string' ? p.specialty : MESH_SPECIALIST_KINDS[0];
      const request = typeof p.request === 'string' ? p.request : '';
      return textResult(await talk(agent.id, specialistId(specialty), request));
    },
  });

  return tools as unknown as ToolDefinition[];
}

/** Map a mesh role to a corp turn purpose (for sampling + telemetry). */
const ROLE_PURPOSE: Record<string, string> = {
  ceo: 'ceo',
  manager: 'manager',
  engineer: 'engineer',
  specialist: 'review',
};

/** Config for {@link createMeshAgentHost}. */
export interface MeshAgentHostConfig {
  /** The resolved corp model (registry/auth/model) every agent runs on. */
  readonly handle: CorpModelHandle;
  /** The SHARED product workspace every agent works in (engineers write here; everyone
   * reads the same tree — one product, one truth). */
  readonly cwd: string;
  /** The roster (to look up each agent's system prompt / peers / built-in tools). */
  readonly roster: readonly MeshAgent[];
  /** Per-turn generation cap (default the model's own). */
  readonly maxTokens?: number;
  /** Live activity sink for the situation room, tagged with the emitting agent. */
  readonly onActivity?: (agentId: string, record: RoleAgentActivity) => void;
}

/**
 * Build the {@link RunAgentTurn} the {@link import('@pi-desktop/harness/corp').AgentMesh}
 * calls: each turn runs the target agent as a real pi run ({@link runRoleAgent}) with
 * its system prompt, its built-in tools, and its communication tools, prompting it with
 * its accumulated MEMORY + the incoming message, and returning its reply. The agent's
 * memory is kept (bounded) so the NEXT time it is talked to, it remembers. Never
 * throws — a session error becomes the reply.
 */
export function createMeshAgentHost(config: MeshAgentHostConfig): RunAgentTurn {
  const roster = new Map(config.roster.map((a) => [a.id, a]));
  const memory = new Map<string, string>();

  return async ({ agentId, from, message, talk }) => {
    const agent = roster.get(agentId);
    if (agent === undefined) return { reply: `(there is no ${agentId} on this team.)` };

    const prior = memory.get(agentId) ?? '';
    const incoming = `Message from ${from}:\n${message}`;
    const userPrompt = prior === '' ? incoming : `${prior}\n\n———\n${incoming}`;

    let reply = '';
    try {
      const result = await runRoleAgent(config.handle, {
        purpose: ROLE_PURPOSE[agent.role] ?? 'engineer',
        systemPrompt: agent.systemPrompt,
        userPrompt,
        // The comm-tool NAMES must be in the allowlist or the SDK never offers them.
        tools: [...agent.tools, TALK_TO_TOOL, COMMISSION_SPECIALIST_TOOL],
        customTools: communicationTools(agent, talk),
        cwd: config.cwd,
        thinking: true,
        samplingMode: 'thinking-general',
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.onActivity !== undefined
          ? { onActivity: (r: RoleAgentActivity) => config.onActivity?.(agentId, r) }
          : {}),
      });
      reply = result.finalText.trim();
    } catch (err) {
      reply = `(${agentId} hit a problem: ${err instanceof Error ? err.message : String(err)})`;
    }
    if (reply === '') reply = '(no reply)';

    // Remember this exchange for the agent's next turn — bounded to the recent tail.
    const nextMemory = `${userPrompt}\n\nYou replied:\n${reply}`;
    memory.set(
      agentId,
      nextMemory.length > MAX_MEMORY_CHARS ? nextMemory.slice(-MAX_MEMORY_CHARS) : nextMemory,
    );
    return { reply };
  };
}

/** The outcome of a live corp mesh run. */
export interface CorpMeshRunResult {
  /** The CEO's final reply — the product of the whole emergent conversation. */
  readonly reply: string;
  /** Every talk that happened (telemetry / the situation room). */
  readonly hops: readonly MeshHop[];
  /** How many agent turns ran. */
  readonly turns: number;
}

/**
 * Run a whole task as a LIVE corp mesh: build the roster, stand up the persistent
 * host, and prompt the CEO — the build emerges from the CEO talking to the manager,
 * the manager to the engineers and specialists, everyone to anyone. Files land in
 * `cwd` (the shared product). Returns the CEO's final reply + the hop transcript.
 * Never throws (the mesh swallows seam errors into replies).
 */
export async function runCorpMeshTask(opts: {
  readonly handle: CorpModelHandle;
  readonly task: string;
  readonly cwd: string;
  readonly engineerCount?: number;
  readonly maxTokens?: number;
  readonly onActivity?: (agentId: string, record: RoleAgentActivity) => void;
}): Promise<CorpMeshRunResult> {
  const roster = buildCorpRoster({
    task: opts.task,
    ...(opts.engineerCount !== undefined ? { engineerCount: opts.engineerCount } : {}),
  });
  const runAgentTurn = createMeshAgentHost({
    handle: opts.handle,
    cwd: opts.cwd,
    roster,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.onActivity !== undefined ? { onActivity: opts.onActivity } : {}),
  });
  const mesh = new AgentMesh(runAgentTurn, roster);
  const reply = await mesh.run('ceo', opts.task);
  return { reply, hops: mesh.hops, turns: mesh.turns };
}
