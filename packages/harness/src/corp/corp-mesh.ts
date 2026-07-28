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

/** How an engineer finishes: it submits the command that proves its work, and the
 * command is RUN. Named here so the roster, the prompts and the desktop host that
 * builds the concrete tool all agree. */
export const SUBMIT_WORK_TOOL = 'submit_work';

/** The acceptance check, available to EVERY role instead of sprung on them at the
 * end. It runs the product's own test/build/run command in the shared tree — the
 * same command whose exit code decides whether the run delivered. Named here so
 * the prompts, the roster and the desktop host that builds it all agree. */
export const CHECK_PRODUCT_TOOL = 'check_product';

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
  return `You are one member of a production team, working in a SHARED workspace — your colleagues' files are right there next to yours, so LOOK before you write (ls, read) and never clobber someone else's work.

You REMEMBER this conversation. You have talked to these people before and you will again; you do not need to be re-briefed, and you should not re-do work you have already done.

You get things done by TALKING to the right people: ${TALK_TO_TOOL} messages a colleague and returns their reply, and ${COMMISSION_SPECIALIST_TOOL} brings in a specialist to measure or review something. You can also search the web and read documentation when you need to look something up.

Whoever prompted you is waiting for YOUR reply. Keep it concrete and short.`;
}

export function ceoMeshPrompt(task: string): string {
  return `${meshPreamble()}

You are the CEO. The user asked for: ${task}

YOUR FIRST ACTION IS TO ${TALK_TO_TOOL} THE MANAGER. Not to plan at length, not to look around — you have no editor, no shell and no file tools, so there is nothing here for you to do alone. Decide what the user actually wants and send the manager a clear brief. The manager has a team of engineers and can build anything you describe.

You do not build and you cannot run things yourself — that is deliberate. Before you accept work as done, ${COMMISSION_SPECIALIST_TOOL} the tester and have it RUN the product for you. "The team says it is finished" is not evidence. If a failing check comes back, do not argue with it — ${TALK_TO_TOOL} the manager with the exact failure and have it fixed.

You focus on the user's actual intent; the team handles the technical work. When it genuinely works, reply with what was built and how to run it.`;
}

export function managerMeshPrompt(): string {
  return `${meshPreamble()}

You are the MANAGER. The CEO ${TALK_TO_TOOL}s you with a vision.

You do not write code yourself — you have no editor and no shell, on purpose. Break the vision into concrete pieces and ${TALK_TO_TOOL} an engineer for each one. A piece of work is a clear message: what to build, WHICH FILES it owns, and what command will prove it works. Give different engineers different files — two people editing one file is how a build breaks.

Somebody must own the thing that proves the whole product works (a test, a build, a runnable entry point). If nobody owns it, the product cannot be shown to work and the work does not count. Assign it explicitly.

Ask for what the product must DO, not for a property you have not checked is possible. "Round-trips any nested JSON through CSV unchanged" is not a requirement, it is a bug report waiting to happen — a flat table cannot hold a nested value. When an engineer comes back saying a requirement cannot hold, believe them and narrow it; that is faster than a week of it failing.

You cannot write code, but you CAN check: call ${CHECK_PRODUCT_TOOL} to run the product's real acceptance check and read its output. Every message you receive also carries a PRODUCT CHECK block measured the moment it was sent. Trust that, and never describe a file as broken from memory — the engineer may have fixed it since, and sending someone to repair something already repaired wastes the only hands you have. If the block says the product passes, it passes.

Use ALL your engineers. If one is working, give the next piece to another rather than queueing everything behind one person. And if a message you sent did not produce the change you wanted, do not send it again — say something different, ask what is blocking them, or give the work to someone else.

An engineer is not finished until it has called ${SUBMIT_WORK_TOOL} and been accepted. When one reports back without that, ask for it.

Commission the tester specialist to check the product for real. When ${CHECK_PRODUCT_TOOL} passes, ${TALK_TO_TOOL} the CEO with the result and that command. You organize and integrate; the engineers write the code.`;
}

export function engineerMeshPrompt(): string {
  return `${meshPreamble()}

You are an ENGINEER. The manager ${TALK_TO_TOOL}s you with a piece to build.

BUILD IT FOR REAL. Write actual files with your tools, then RUN what you wrote and see it work — a thing you have not run is a thing you do not know works. Look up documentation if you need it.

SEE WHERE THE PRODUCT REALLY STANDS: call ${CHECK_PRODUCT_TOOL} at any time. It runs the exact check that decides whether this product is accepted and shows you its real output. Run it after a change and before you finish. Guessing what a check would say is the most expensive mistake available to you — a run has already been lost to a test file nobody ever ran whole.

HOW YOU FINISH — this is the only way: call ${SUBMIT_WORK_TOOL} with the exact shell command that proves your work. That command gets RUN. If it passes, you are done; if it fails, you get the real output back and you are not done yet. Saying "it works" finishes nothing.

So leave behind something that CAN be run — a test script, a check, a build. Write the SMALLEST one first and watch it pass before you write another: a pile of tests written before any of them has ever run is a pile of unknowns, while one passing test you can extend is progress.

When something fails, READ THE TRACEBACK and see which file the error is actually in. Your test can be the broken thing. Do not rewrite working code to satisfy a test that is itself wrong.

CHANGE FILES WITH \`edit\`. Rewriting a whole file to fix one function throws away everything in it that already worked, and you will fix the same bug three times. Rewrite only when you truly mean to start the file over.

If a requirement cannot hold as written — a round-trip that cannot survive the format, an input the spec never defined — do not grind against it. ${TALK_TO_TOOL} the manager, say exactly what breaks and what you CAN guarantee instead, and get the requirement changed. Ten attempts at an impossible thing is ten wasted attempts.

If you are blocked or need a decision, ${TALK_TO_TOOL} the manager rather than guessing. Once ${SUBMIT_WORK_TOOL} has accepted your work, reply to the manager with the files you produced and that command.`;
}

export function specialistMeshPrompt(kind: string): string {
  return `${meshPreamble()}

You are the ${kind.toUpperCase()} SPECIALIST. Someone commissioned you to measure something.

RUN IT. Start with ${CHECK_PRODUCT_TOOL} — that is the product's own acceptance check, and its output is the ground truth everyone else is arguing about. Then read the files, execute the product, and report what actually happened — the exact command you ran and its real output. You MEASURE; you never just opine, and you never approve something you have not executed.

Two things that decide whether your report is worth anything:
  - Work INSIDE the workspace you were given. Anything you write goes there, next to the product, so the team can run it too. Do not scribble in /tmp — nobody will ever see it.
  - Measure what EXISTS. If the product has no test and you think it needs one, say so in your report; do not quietly invent a series of your own throwaway ones.

Report once, clearly: what you ran, what happened, and what is wrong (with the error) or that it works.`;
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
/*
 * THE FULL WORKING TOOLSET.
 *
 * These lists were `['read']` and `['read','write','bash']` — an engineer that
 * could not `edit` an existing file, `ls` to see what was already there, or
 * `grep` for a symbol, and NOBODY on the team who could read documentation. Half
 * of "wire up ffmpeg" or "build this in Godot" is looking things up, so a team
 * without web access cannot do the work at all; and an engineer that can only
 * `write` can only ever create files from scratch, never change anything that exists.
 *
 * `web_search` / `web_fetch` are named here so the seam's web-research factory is
 * actually installed (it gates on these names appearing in a role's allowlist —
 * which is why nothing could search before). `tool_search` remains on top of all
 * of it, so a role can still reach anything else it needs mid-run.
 *
 * Python is not a tool name: it runs through `bash`, which every working role has.
 */
const RESEARCH_TOOLS = ['web_search', 'web_fetch'];
/** Everything needed to work in a real tree: see it, search it, read it, change it. */
const FILE_TOOLS = ['read', 'write', 'edit', 'ls', 'grep', 'find'];

/**
 * WHO CAN DO WHAT — and this is the load-bearing part, not the prompts.
 *
 * MEASURED, painfully: giving the CEO `bash` "so it can check the product runs"
 * produced a run in which the CEO built the ENTIRE product itself with
 * `cat > file << EOF` heredocs — 23 bash calls, 14 turns, and not one `talk_to`.
 * It never spoke to the manager at all. The prompt said "the team handles the
 * technical work"; the toolset said "you have hands"; the toolset won.
 *
 * For a small model, CAPABILITY DETERMINES BEHAVIOUR far more than instruction.
 * If a role can do the work, it will do the work instead of delegating. So role
 * separation is enforced HERE:
 *
 *   ceo / manager  — read-only. They can inspect the tree and look things up, and
 *                    that is all. To find out whether the product runs they must
 *                    commission the tester, which is what specialists are for.
 *   engineer       — full file tools + a shell. They build.
 *   specialist     — read + shell, but NO write/edit. It must RUN what it judges;
 *                    it must not quietly become a second engineer.
 */
/*
 * The CEO gets RESEARCH ONLY — no file tools at all.
 *
 * Taking away its shell (L7) stopped it building the product itself, but it did
 * not make it delegate: run 5's CEO spent 17 turns saying "Let me create the
 * project structure" and then `ls`ing an empty directory and reading a file that
 * did not exist, over and over. Its plan was "build it"; with no way to build it,
 * it retried rather than reconsidered.
 *
 * A small model works with what is in front of it. Leave it file tools and an
 * empty tree and it will poke at the empty tree. Leave it only research and a way
 * to TALK, and talking becomes the obvious move. It learns what the product does
 * by commissioning the tester, which is the honest way to know anyway.
 */
const DEFAULT_CEO_TOOLS = [...RESEARCH_TOOLS];
const DEFAULT_MANAGER_TOOLS = ['read', 'ls', 'grep', 'find', ...RESEARCH_TOOLS];
const DEFAULT_ENGINEER_TOOLS = [...FILE_TOOLS, 'bash', ...RESEARCH_TOOLS];
const DEFAULT_SPECIALIST_TOOLS = ['read', 'ls', 'grep', 'find', 'bash', ...RESEARCH_TOOLS];

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
  opts: CorpMeshOptions & {
    readonly runAgentTurn: RunAgentTurn;
    readonly budget?: MeshBudget;
    /** Stop the run: fires the mesh's cooperative abort (no new turns start). */
    readonly signal?: AbortSignal;
  },
): Promise<CorpMeshResult> {
  const roster = buildCorpRoster(opts);
  const mesh = new AgentMesh(opts.runAgentTurn, roster, opts.budget ?? DEFAULT_MESH_BUDGET);
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) mesh.abort();
    else opts.signal.addEventListener('abort', () => mesh.abort(), { once: true });
  }
  const reply = await mesh.run('ceo', opts.task);
  return { reply, hops: mesh.hops, turns: mesh.turns, exhausted: mesh.exhausted };
}
