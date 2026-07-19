/**
 * The AGENT MESH — the corp's message-passing runtime (jedd's model: "EVERYONE is a
 * pi instance with a system prompt + tools that gets prompted to DO SOMETHING, and
 * anyone can talk to anyone"). This is the emergent alternative to the deterministic
 * `runCorp` pipeline: instead of a fixed vision→promote→architect→dispatch→review
 * sequence, there are persistent AGENTS that prompt each other via a `talk_to` tool,
 * and the work is whatever falls out of that conversation. The CEO is prompted with
 * the task, talks to the manager, the manager talks to engineers and specialists, and
 * replies flow back up.
 *
 * This module is the PURE, DETERMINISTIC CORE — the actual pi sessions are INJECTED
 * ({@link RunAgentTurn}), so the routing, the peer permissions, and the bounds are all
 * unit-testable with mocks (no model, no fs). It generalizes the existing `consult`
 * primitive (role-agent-seam.ts — an agent already spawns another and waits for its
 * prose) into named, PERSISTENT, ANY-TO-ANY peers: the same synchronous recursive
 * "call another agent and get its reply" shape, but the target keeps its context
 * across turns and both directions are first-class.
 *
 * Bounded by construction (a small model in an emergent loop must never run away):
 * every talk is gated by a per-agent PEER ALLOWLIST (you may only talk to declared
 * peers), a DEPTH cap (nested conversations), a TOTAL-TURN budget, and a re-entrancy
 * guard (an agent already mid-turn on the call stack is "busy" rather than deadlocked).
 * A blocked talk returns a plain-language note, never throws — the calling agent reads
 * it like any tool result and carries on. Pure; never throws.
 */

/** A persistent agent in the mesh: a stable id, its role, its system prompt, the peers
 * it may talk to, and its built-in tools. Its SESSION persists across turns (its
 * context accumulates) — modeled here by the injected {@link RunAgentTurn} keeping
 * state per `id`. */
export interface MeshAgent {
  /** Stable id used for routing (e.g. `ceo`, `manager`, `engineer:frontend-1`). */
  readonly id: string;
  /** The role family (for prompts/telemetry), e.g. `ceo` / `manager` / `engineer`. */
  readonly role: string;
  /** The composed system prompt for this agent's session. */
  readonly systemPrompt: string;
  /** The agent ids this agent may `talk_to` — a DIRECTED allowlist (declare both ways
   * for a two-way channel, e.g. ceo↔manager). Talking to a non-peer is refused. */
  readonly peers: readonly string[];
  /** Built-in tool names the agent may use (`read`/`write`/`bash`/…). */
  readonly tools: readonly string[];
}

/** The router handed INTO each agent turn: when the running agent calls its
 * `talk_to(peer, message)` tool, the seam invokes this and awaits the peer's reply
 * (synchronous + recursive — the peer may talk to ITS peers before replying). */
export type TalkFn = (from: string, to: string, message: string) => Promise<string>;

/** One prompt to a persistent agent: which agent, who is prompting it, the message,
 * and the {@link TalkFn} its `talk_to` tools call. The seam runs the agent's live
 * session (appending `message` to its context) and returns its reply. */
export interface AgentTurnRequest {
  readonly agentId: string;
  readonly from: string;
  readonly message: string;
  readonly talk: TalkFn;
}

/** The result of one agent turn: its reply to whoever prompted it (the tool result the
 * sender receives). */
export interface AgentTurnResult {
  readonly reply: string;
}

/** The injected seam that runs ONE persistent agent turn (real = a live pi session;
 * test = a mock). Should never throw — an error is the agent's problem to report as a
 * reply, not the mesh's to crash on. */
export type RunAgentTurn = (req: AgentTurnRequest) => Promise<AgentTurnResult>;

/** The mesh's bounds — the backstop against an emergent conversation running away. */
export interface MeshBudget {
  /** Max TOTAL agent turns across the whole mesh (every prompt/talk charges one). */
  readonly maxTurns: number;
  /** Max `talk_to` nesting depth (a → b → c → … ). */
  readonly maxDepth: number;
}

/** The default bounds — generous enough for a real multi-agent build, tight enough to
 * guarantee termination. */
export const DEFAULT_MESH_BUDGET: MeshBudget = { maxTurns: 200, maxDepth: 12 };

/** The synthetic sender id for the ROOT prompt (the user/task kicking off the mesh) —
 * it may talk to any agent (it has no peer allowlist of its own). */
export const ROOT_SENDER = 'user';

/** Why a talk was refused (surfaced to the caller as a plain note, never thrown). */
export type TalkRefusal = 'unknown-agent' | 'not-a-peer' | 'busy' | 'too-deep' | 'out-of-turns';

/** The plain-language note a refused talk returns to the calling agent. Pure. */
export function refusalNote(kind: TalkRefusal, to: string): string {
  switch (kind) {
    case 'unknown-agent':
      return `(there is no "${to}" to talk to.)`;
    case 'not-a-peer':
      return `(you are not set up to talk to "${to}".)`;
    case 'busy':
      return `(${to} is busy right now and can't respond — carry on and check back later.)`;
    case 'too-deep':
      return '(this conversation has nested too many times — wrap up and report back.)';
    case 'out-of-turns':
      return '(the team is out of time for now — wrap up with what you have.)';
  }
}

/** One recorded talk in the mesh transcript (for telemetry / the situation room). */
export interface MeshHop {
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly reply: string;
  readonly depth: number;
  /** Present when the talk was refused (no agent turn ran). */
  readonly refused?: TalkRefusal;
}

/**
 * The message-passing runtime. Construct with the injected turn-runner + the agent
 * roster, then {@link run} kicks it off by prompting a root agent (e.g. the CEO with
 * the task). Everything else emerges from `talk_to`. Every hop is recorded in
 * {@link hops} for telemetry. Not reusable across runs (the budget/transcript are
 * per-instance); make a new mesh per task.
 */
export class AgentMesh {
  private readonly agents = new Map<string, MeshAgent>();
  private readonly active = new Set<string>();
  private turnsUsed = 0;
  /** The ordered transcript of every talk (including refusals). */
  readonly hops: MeshHop[] = [];

  constructor(
    private readonly runTurn: RunAgentTurn,
    agents: readonly MeshAgent[],
    private readonly budget: MeshBudget = DEFAULT_MESH_BUDGET,
  ) {
    for (const a of agents) this.agents.set(a.id, a);
  }

  /** True once no more turns may run (the total-turn budget is spent). */
  get exhausted(): boolean {
    return this.turnsUsed >= this.budget.maxTurns;
  }

  /** How many agent turns have run so far. */
  get turns(): number {
    return this.turnsUsed;
  }

  /**
   * Kick off the mesh: prompt `rootId` with `message` (e.g. the CEO with the user's
   * task). Returns the root agent's final reply — the product of the whole emergent
   * conversation. A missing root or a spent budget yields a plain note, never throws.
   */
  async run(rootId: string, message: string): Promise<string> {
    return this.deliver(ROOT_SENDER, rootId, message, 0);
  }

  /** Route one message from `from` to `to`, enforcing the peer allowlist, the
   * re-entrancy/busy guard, and the depth + turn budgets. Records the hop. Never
   * throws — a refusal or a seam error becomes the reply text. */
  private async deliver(from: string, to: string, message: string, depth: number): Promise<string> {
    const refusal = this.refuse(from, to, depth);
    if (refusal !== undefined) {
      const reply = refusalNote(refusal, to);
      this.hops.push({ from, to, message, reply, depth, refused: refusal });
      return reply;
    }

    this.turnsUsed += 1;
    this.active.add(to);
    let reply: string;
    try {
      const talk: TalkFn = (f, t, m) => this.deliver(f, t, m, depth + 1);
      const out = await this.runTurn({ agentId: to, from, message, talk });
      reply = out.reply;
    } catch (err) {
      // A seam that throws is the agent's failure to report, not a mesh crash.
      reply = `(${to} hit a problem: ${err instanceof Error ? err.message : String(err)})`;
    } finally {
      this.active.delete(to);
    }
    this.hops.push({ from, to, message, reply, depth });
    return reply;
  }

  /** The bounds check for a talk: returns the refusal kind, or `undefined` when the
   * talk may proceed. Pure over the mesh's state. */
  private refuse(from: string, to: string, depth: number): TalkRefusal | undefined {
    if (!this.agents.has(to)) return 'unknown-agent';
    // The root may talk to anyone; an agent may talk only to its DECLARED peers.
    if (from !== ROOT_SENDER && this.agents.get(from)?.peers.includes(to) !== true) {
      return 'not-a-peer';
    }
    // An agent already mid-turn on the call stack can't be re-prompted (its session is
    // busy) — report "busy" rather than deadlock.
    if (this.active.has(to)) return 'busy';
    if (depth > this.budget.maxDepth) return 'too-deep';
    if (this.turnsUsed >= this.budget.maxTurns) return 'out-of-turns';
    return undefined;
  }
}
