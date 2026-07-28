/**
 * The PERSISTENT-SESSION HOST for the agent mesh (jedd's model — desktop side): it
 * implements the harness `RunAgentTurn` seam over REAL pi agents. Every mesh agent
 * (CEO, manager, engineers, specialists) is a PERSISTENT pi session that stays open
 * across turns — its history, its own tool calls and the server's warm KV all still
 * there when it is next spoken to — and its universal
 * `talk_to` / `commission_specialist` tools route through the mesh — so anyone can talk
 * to anyone. Writing a contract (manager → engineer), submitting it (engineer →
 * manager), and commissioning a specialist are all the SAME conversation.
 *
 * Turns run through the {@link AgentPool}, which opens each role's session ONCE and
 * keeps it (bounded, LRU-evicted, resumable from its file). It inherits the sampling,
 * the per-call abort watchdog, the live activity stream and the tool loop unchanged;
 * this host adds the communication tools as `ToolDefinition`s whose async `execute`
 * calls the mesh router — the exact shape the `consult` tool already uses to spawn an
 * advisor and await its reply.
 *
 * WHAT THIS REPLACED: an 8,000-character transcript TAIL, replayed into a brand-new
 * session on every turn. That is a summary handed to a stranger, and it cost a full
 * re-prefill each time. A role now simply remembers.
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
import { AgentPool } from './agent-pool';
import { type GateResult, gateFeedback, runProductGate } from './product-gate';
import type { CorpModelHandle } from './role-agent';
import { TeamBook } from './team-record';

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
  /** The project whose `.pi/corp/sessions/` holds the team's conversations, so a
   * role's memory outlives the run. Omitted → in-memory sessions (tests). */
  readonly projectDir?: string;
  /** Max simultaneously-open agent sessions before the least-recently-used is
   * evicted (its file kept; it resumes on the next message). */
  readonly maxLiveAgents?: number;
  /** Restore a persisted session file for an agent id — how a reopened project
   * gets its SAME team back rather than a new one wearing the same names. */
  readonly sessionFileFor?: (agentId: string) => string | undefined;
  /** Record where an agent's conversation landed, so it can be found next time. */
  readonly onSessionFile?: (agentId: string, file: string) => void;
}

/** A mesh host, plus the pool behind it (for lifecycle + telemetry). */
export type MeshAgentHost = RunAgentTurn & {
  /** The live/resumable agent sessions this host is driving. */
  readonly pool: AgentPool;
  /** Cut every in-flight agent turn short. Sessions stay open. */
  abort(): void;
  /** Close every open session. Their files are kept — they resume on next use. */
  dispose(): void;
};

/**
 * Build the {@link RunAgentTurn} the {@link import('@pi-desktop/harness/corp').AgentMesh}
 * calls: each turn runs the target agent as a real pi run ({@link runRoleAgent}) with
 * its system prompt, its built-in tools, and its communication tools, prompting it with
 * its accumulated MEMORY + the incoming message, and returning its reply. The agent's
 * memory is kept (bounded) so the NEXT time it is talked to, it remembers. Never
 * throws — a session error becomes the reply.
 */
export function createMeshAgentHost(config: MeshAgentHostConfig): MeshAgentHost {
  const roster = new Map(config.roster.map((a) => [a.id, a]));
  const pool = new AgentPool({
    handle: config.handle,
    ...(config.projectDir !== undefined ? { projectDir: config.projectDir } : {}),
    ...(config.maxLiveAgents !== undefined ? { maxLive: config.maxLiveAgents } : {}),
    ...(config.sessionFileFor !== undefined ? { sessionFileFor: config.sessionFileFor } : {}),
    ...(config.onSessionFile !== undefined ? { onSessionFile: config.onSessionFile } : {}),
  });

  /*
   * THE `talk` CLOSURE PROBLEM.
   *
   * An agent's communication tools close over the mesh's `talk`, and they are
   * built ONCE, when its session opens. But `talk` arrives per TURN. So the tools
   * read it through this holder, which each turn updates — the tools stay the same
   * objects (the session keeps them), while the routing they use is always the
   * current one.
   */
  const talkRef = new Map<string, TalkFn>();
  const talkThrough =
    (agentId: string): TalkFn =>
    (from, to, msg) => {
      const live = talkRef.get(agentId);
      if (live === undefined) return Promise.resolve('(this conversation is no longer open.)');
      return live(from, to, msg);
    };

  const run: RunAgentTurn = async ({ agentId, from, message, talk }) => {
    const agent = roster.get(agentId);
    if (agent === undefined) return { reply: `(there is no ${agentId} on this team.)` };
    talkRef.set(agentId, talk);

    // NO REPLAYED TRANSCRIPT. The agent's session is still open (or resumes from
    // its file), so it already remembers everything it has done and been told —
    // this is just the next thing said to it.
    const incoming = `Message from ${from}:\n${message}`;
    let reply = '';
    try {
      const result = await pool.talk(
        agentId,
        {
          purpose: ROLE_PURPOSE[agent.role] ?? 'engineer',
          systemPrompt: agent.systemPrompt,
          // The comm-tool NAMES must be in the allowlist or the SDK never offers them.
          tools: [...agent.tools, TALK_TO_TOOL, COMMISSION_SPECIALIST_TOOL],
          customTools: communicationTools(agent, talkThrough(agentId)),
          cwd: config.cwd,
          thinking: true,
          samplingMode: 'thinking-general',
          ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        },
        incoming,
        {
          ...(config.onActivity !== undefined
            ? { onActivity: (r: RoleAgentActivity) => config.onActivity?.(agentId, r) }
            : {}),
        },
      );
      reply = result.finalText.trim();
    } catch (err) {
      reply = `(${agentId} hit a problem: ${err instanceof Error ? err.message : String(err)})`;
    }
    if (reply === '') reply = '(no reply)';
    return { reply };
  };

  return Object.assign(run, {
    pool,
    abort: () => pool.abortAll(),
    dispose: () => pool.disposeAll(),
  });
}

/** The outcome of a live corp mesh run. */
export interface CorpMeshRunResult {
  /** The CEO's final reply — the product of the whole emergent conversation. */
  readonly reply: string;
  /** Every talk that happened (telemetry / the situation room). */
  readonly hops: readonly MeshHop[];
  /** How many agent turns ran. */
  readonly turns: number;
  /** What happened when the product's own check was RUN. `ok` is the only honest
   * "it works" in the whole result — everything else is what people said. */
  readonly gate: GateResult;
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
  /** Cooperative stop: fires the mesh's abort so no new agent turns start. */
  readonly signal?: AbortSignal;
  /** Where the TEAM is kept — `.pi/corp/` under this directory. Defaults to the
   * product workspace, so a project's agents live with the code they work on.
   * Explicit `null` runs an anonymous, in-memory team (tests). */
  readonly teamDir?: string | null;
  readonly maxLiveAgents?: number;
  /** How many times a failing product check is handed back to the team before the
   * failing verdict stands. Default 2. */
  readonly maxGateRounds?: number;
  /** Observe each gate attempt (logging / the situation room). */
  readonly onGate?: (result: GateResult, round: number) => void;
}): Promise<CorpMeshRunResult> {
  const roster = buildCorpRoster({
    task: opts.task,
    ...(opts.engineerCount !== undefined ? { engineerCount: opts.engineerCount } : {}),
  });
  // The team lives with the product unless told otherwise, so reopening the
  // project reaches the SAME people rather than new ones wearing their names.
  const teamDir = opts.teamDir === null ? undefined : (opts.teamDir ?? opts.cwd);
  const team = new TeamBook(teamDir, opts.task);
  const roleOf = new Map(roster.map((a) => [a.id, a.role]));

  const host = createMeshAgentHost({
    handle: opts.handle,
    cwd: opts.cwd,
    roster,
    ...(teamDir !== undefined ? { projectDir: teamDir } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.maxLiveAgents !== undefined ? { maxLiveAgents: opts.maxLiveAgents } : {}),
    ...(opts.onActivity !== undefined ? { onActivity: opts.onActivity } : {}),
    sessionFileFor: (id) => team.sessionFileFor(id),
    onSessionFile: (id, file) => team.remember(id, roleOf.get(id) ?? 'engineer', file),
  });
  const mesh = new AgentMesh(host, roster);
  // A stop must reach BOTH layers: the mesh refuses new talks, and the host cuts
  // whatever is already running. Only one of those existed before, so a spent
  // budget left the in-flight agent churning.
  const stop = () => {
    mesh.abort();
    host.abort();
  };
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) stop();
    else opts.signal.addEventListener('abort', stop, { once: true });
  }
  try {
    let reply = await mesh.run('ceo', opts.task);

    /*
     * THE GATE. The conversation is free; DONE is not a conversation outcome.
     *
     * The team says it has finished, and then the product's own check is RUN. If
     * it fails, the failure output goes straight back to the CEO as the next
     * message — and because the CEO's session is persistent, that is a follow-up
     * to the same person who just told us it was done, not a fresh briefing. A
     * concrete failing command with its real output is the single most useful
     * thing you can hand a small model; "please improve the code" is the least.
     *
     * Bounded: after `maxGateRounds` the honest failing verdict stands rather
     * than looping forever.
     */
    const rounds = opts.maxGateRounds ?? 2;
    let gate = await runProductGate(opts.cwd);
    for (let round = 0; !gate.ok && round < rounds && !mesh.exhausted; round += 1) {
      if (opts.signal?.aborted === true) break;
      opts.onGate?.(gate, round);
      reply = await mesh.run('ceo', gateFeedback(gate));
      gate = await runProductGate(opts.cwd);
    }
    opts.onGate?.(gate, rounds);
    return { reply, hops: mesh.hops, turns: mesh.turns, gate };
  } finally {
    // Close the live sessions; their FILES stay, so the next run resumes them.
    host.dispose();
  }
}
