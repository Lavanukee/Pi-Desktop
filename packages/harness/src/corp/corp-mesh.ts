/**
 * The CORP as an AGENT MESH (jedd's model): every role — CEO, manager, engineers,
 * specialists — is a persistent {@link MeshAgent} with a system prompt + tools, and
 * they get things done by TALKING TO each other. There is no pipeline: the CEO is
 * prompted with the task, `talk_to`s the manager, the manager `talk_to`s engineers
 * with their contracts (writing a contract IS the conversation), engineers reply when
 * they've built it (submitting IS the conversation), and ANYONE can
 * `commission_specialist` to measure/review. This module assembles that roster + the
 * peer graph, and runs it on the {@link AgentMesh} (from mesh.ts) with the pi sessions
 * injected — so the whole emergent orchestration is unit-testable with a mock runner.
 *
 * The two communication primitives every agent carries (the desktop host generates the
 * concrete tools from an agent's peer set, this module only names them + wires the
 * peer graph): `talk_to(recipient, message)` for its colleagues, and
 * `commission_specialist(specialty, request)` for the specialists (available to
 * EVERYONE — jedd: "everyone gets a specialist commission tool"). Both are the same
 * underlying conversation, routed by the mesh.
 *
 * Pure roster + orchestration; the model work is behind the injected seam.
 */

import {
  AgentMesh,
  DEFAULT_MESH_BUDGET,
  type MeshAgent,
  type MeshBudget,
  type MeshHop,
  type RunAgentTurn,
} from './mesh.js';

/** The universal peer-to-peer conversation tool every agent carries (recipient is one
 * of its colleagues). The desktop host builds the concrete tool from the agent's
 * non-specialist peers; named here so prompts + host agree. */
export const TALK_TO_TOOL = 'talk_to';

/** The specialist-commission tool EVERY agent carries (jedd's explicit ask): engage a
 * specialist to measure/review/answer, and get their report back. */
export const COMMISSION_SPECIALIST_TOOL = 'commission_specialist';

/** The specialties any agent may commission — aligned with the review lenses. Each is
 * a persistent `specialist:<kind>` agent in the roster. */
export const MESH_SPECIALIST_KINDS = [
  'tester',
  'correctness',
  'security',
  'performance',
  'visual',
  'accessibility',
] as const;
/** Named to avoid colliding with prompts.ts's review-lens `SpecialistKind`. */
export type MeshSpecialistKind = (typeof MESH_SPECIALIST_KINDS)[number];

/** The mesh agent id for a specialty / an engineer slot. */
export const specialistId = (kind: string): string => `specialist:${kind}`;
export const engineerId = (n: number): string => `engineer:${n}`;

/** All specialist agent ids (every agent may commission every one of them). */
export function specialistIds(): string[] {
  return MESH_SPECIALIST_KINDS.map(specialistId);
}

// --- Role system prompts (concise; the emergent behavior is tuned live) ------

/** The framing shared by every mesh agent: you are one person on a team, you get
 * things done by TALKING to the right people, and you always reply to whoever prompted
 * you with a useful answer. */
function meshPreamble(): string {
  return `You are one member of a production team. You get things done by TALKING to the right people — use ${TALK_TO_TOOL} to message a colleague and you'll get their reply back, and ${COMMISSION_SPECIALIST_TOOL} to bring in a specialist to measure or review something. Whoever prompted you is waiting for YOUR reply, so when you're done, reply with a clear, useful answer to them. Keep messages concrete and short.`;
}

export function ceoMeshPrompt(task: string): string {
  return `${meshPreamble()}

You are the CEO. The user asked for: ${task}

Form a clear vision of what to build (research first if you need to), then ${TALK_TO_TOOL} the manager with that vision — the manager has a whole team of engineers and can build anything you describe. Check in with the manager as you like, and commission a specialist yourself if you want an independent measurement. You focus on the user and the highest-level intent; the team handles the technical work. When the manager delivers, review it against your vision and reply to the user with what was built.`;
}

export function managerMeshPrompt(): string {
  return `${meshPreamble()}

You are the MANAGER. The CEO ${TALK_TO_TOOL}s you with a vision. Break it into concrete pieces of work and ${TALK_TO_TOOL} an engineer for each one — a "contract" is just a clear message: what to build, where it goes (the file), and how you'll both know it's done. Engineers reply when they've built their piece. Commission specialists (e.g. the tester) to check the product actually works. When it's built and it holds together, ${TALK_TO_TOOL} the CEO back with the finished result. You organize and integrate; the engineers write the code.`;
}

export function engineerMeshPrompt(): string {
  return `${meshPreamble()}

You are an ENGINEER. The manager ${TALK_TO_TOOL}s you with a contract — a piece to build. Build it for real in the workspace with your tools (read/write/bash): write the actual files, make it work. If you're blocked or need a decision, ${TALK_TO_TOOL} the manager; commission a specialist if you want your work checked. When it's built, reply to the manager with what you produced (the file(s) and a one-line summary).`;
}

export function specialistMeshPrompt(kind: string): string {
  return `${meshPreamble()}

You are the ${kind.toUpperCase()} SPECIALIST. Someone commissioned you to measure or review something. Inspect the REAL product with your tools (read/bash) — run it, read it, check it — and report concrete, evidence-grounded findings back to whoever asked. You MEASURE; you never just opine. If it's good, say so plainly; if not, say exactly what's wrong and where.`;
}

// --- Roster ------------------------------------------------------------------

/** Options for {@link buildCorpRoster} / {@link runCorpMesh}. */
export interface CorpMeshOptions {
  /** The user's task (seeds the CEO). */
  readonly task: string;
  /** How many engineer agents to make available to the manager (a pool it assigns
   * work to; default 4). */
  readonly engineerCount?: number;
  /** Built-in tool allowlists per role (the desktop host maps these to real tools). */
  readonly ceoTools?: readonly string[];
  readonly managerTools?: readonly string[];
  readonly engineerTools?: readonly string[];
  readonly specialistTools?: readonly string[];
}

const DEFAULT_ENGINEERS = 4;
const DEFAULT_CEO_TOOLS = ['read'];
const DEFAULT_MANAGER_TOOLS = ['read'];
const DEFAULT_ENGINEER_TOOLS = ['read', 'write', 'bash'];
const DEFAULT_SPECIALIST_TOOLS = ['read', 'bash'];

/**
 * Assemble the corp roster: the CEO, the manager, a pool of engineers, and one
 * specialist per {@link MESH_SPECIALIST_KINDS}. The PEER GRAPH encodes who may talk to
 * whom — and EVERY agent's peers include every specialist (so everyone can commission
 * one). Colleagues vs specialists is a display distinction the host draws from the
 * peer set; the mesh routes both the same. Pure.
 */
export function buildCorpRoster(opts: CorpMeshOptions): MeshAgent[] {
  const engineers = opts.engineerCount ?? DEFAULT_ENGINEERS;
  const specs = specialistIds();
  const engIds = Array.from({ length: engineers }, (_, i) => engineerId(i + 1));

  const ceo: MeshAgent = {
    id: 'ceo',
    role: 'ceo',
    systemPrompt: ceoMeshPrompt(opts.task),
    peers: ['manager', ...specs],
    tools: opts.ceoTools ?? DEFAULT_CEO_TOOLS,
  };
  const manager: MeshAgent = {
    id: 'manager',
    role: 'manager',
    systemPrompt: managerMeshPrompt(),
    peers: ['ceo', ...engIds, ...specs],
    tools: opts.managerTools ?? DEFAULT_MANAGER_TOOLS,
  };
  const engineerAgents: MeshAgent[] = engIds.map((id) => ({
    id,
    role: 'engineer',
    systemPrompt: engineerMeshPrompt(),
    peers: ['manager', ...specs],
    tools: opts.engineerTools ?? DEFAULT_ENGINEER_TOOLS,
  }));
  const specialistAgents: MeshAgent[] = MESH_SPECIALIST_KINDS.map((kind) => ({
    id: specialistId(kind),
    role: 'specialist',
    systemPrompt: specialistMeshPrompt(kind),
    // A specialist replies via the commission's return value; it may consult OTHER
    // specialists, and talk to the manager/CEO to escalate.
    peers: ['manager', 'ceo', ...specs.filter((s) => s !== specialistId(kind))],
    tools: opts.specialistTools ?? DEFAULT_SPECIALIST_TOOLS,
  }));

  return [ceo, manager, ...engineerAgents, ...specialistAgents];
}

/** The outcome of a corp mesh run. */
export interface CorpMeshResult {
  /** The CEO's final reply — the product of the whole emergent conversation. */
  readonly reply: string;
  /** Every talk that happened, in settle order (telemetry / the situation room). */
  readonly hops: readonly MeshHop[];
  /** How many agent turns ran. */
  readonly turns: number;
  /** True if the run hit the total-turn budget. */
  readonly exhausted: boolean;
}

/**
 * Run the corp as an agent mesh: build the roster, then prompt the CEO with the task
 * and let the build EMERGE from the conversation. The pi sessions are injected via
 * `runAgentTurn` (real = persistent sessions; test = a scripted mock). Returns the
 * CEO's final reply + the full hop transcript. Never throws (the mesh swallows seam
 * errors into replies).
 */
export async function runCorpMesh(
  opts: CorpMeshOptions & { readonly runAgentTurn: RunAgentTurn; readonly budget?: MeshBudget },
): Promise<CorpMeshResult> {
  const roster = buildCorpRoster(opts);
  const mesh = new AgentMesh(opts.runAgentTurn, roster, opts.budget ?? DEFAULT_MESH_BUDGET);
  const reply = await mesh.run('ceo', opts.task);
  return { reply, hops: mesh.hops, turns: mesh.turns, exhausted: mesh.exhausted };
}
