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

import { mkdirSync } from 'node:fs';
import nodePath from 'node:path';
import type { ExtensionFactory, ToolDefinition } from '@mariozechner/pi-coding-agent';
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
import {
  blockedCapabilities,
  type Capability,
  capabilityBriefing,
  probeCapabilities,
} from './capabilities';
import type { CorpModelHandle } from './role-agent';
import {
  createSubmitWorkTool,
  SUBMIT_WORK_TOOL,
  type SubmittedWork,
  submissionNote,
} from './submit-work';
import { TeamBook } from './team-record';
import { repairNote, repairShadowTree } from './workspace-paths';

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

/**
 * THE ASK, RESTATED, on every message the manager receives.
 *
 * Run 10's manager measured the product once and then sent the same engineer the
 * same diagnosis four times, long after the file had been repaired — reasoning
 * from memory about a mutable world. Run 17 shipped a library with no entry point
 * at all, a requirement stated in a sentence of its own, twenty exchanges after it
 * had last seen that sentence.
 *
 * This used to carry an automated check's verdict too. It does not any more: an
 * automated result is only meaningful for the kind of project somebody
 * anticipated, and this has to work for a film as readily as a compiler. The
 * manager finds out how the product is doing by USING it, and by sending in an
 * auditor. What the harness can honestly supply is what was asked for, unchanged.
 */
export function taskNote(task?: string): string {
  if (task === undefined || task.trim() === '') return '';
  return `--- WHAT WAS ASKED FOR (unchanged — re-read it before you judge anything) ---\n${task.trim()}`;
}

/** Map a mesh role to a corp turn purpose (for sampling + telemetry). */
const ROLE_PURPOSE: Record<string, string> = {
  ceo: 'ceo',
  manager: 'manager',
  engineer: 'engineer',
  specialist: 'review',
};

/**
 * Work tool calls one message may spend. Generous — a real piece of work is a
 * dozen reads, a few writes and several test runs — but finite, because the
 * failure it guards against is not slowness, it is a role that never stops and
 * therefore never reports. Measured against run 7, where an engineer passed
 * thirty calls inside one message and was still going.
 */
export const DEFAULT_STEPS_PER_MESSAGE = 24;

/**
 * The settings a run passes STRAIGHT THROUGH to its agent host.
 *
 * Extracted and named because forgetting one is silent: `onSubmitted` was
 * declared on both sides and forwarded by neither, so run 7's single successful
 * `submit_work` — the first any run had produced — left no record, and the
 * transcript read as though the tool had never fired. A dropped observer does not
 * fail, it just makes you believe the wrong thing about the run. Keeping the list
 * in one pure function means it can be tested rather than trusted.
 */
export const PASSTHROUGH_KEYS = [
  'maxTokens',
  'maxLiveAgents',
  'maxStepsPerMessage',
  'onActivity',
  'onSubmitted',
  'onRepaired',
] as const;

/** Copy the passthrough settings that were actually supplied. `undefined` is left
 * out entirely rather than set, so the host's own defaults still apply under
 * `exactOptionalPropertyTypes`. */
export function hostPassthrough<T extends Record<string, unknown>>(
  opts: T,
): Partial<Pick<T, (typeof PASSTHROUGH_KEYS)[number] & keyof T>> {
  const out: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (opts[key] !== undefined) out[key] = opts[key];
  }
  return out as Partial<Pick<T, (typeof PASSTHROUGH_KEYS)[number] & keyof T>>;
}

/** Config for {@link createMeshAgentHost}. */
export interface MeshAgentHostConfig {
  /** The resolved corp model (registry/auth/model) every agent runs on. */
  readonly handle: CorpModelHandle;
  /** The SHARED product workspace every agent works in (engineers write here; everyone
   * reads the same tree — one product, one truth). */
  readonly cwd: string;
  /** The user's task, verbatim — restated to the manager with every message. */
  readonly task?: string;
  /** Extra tool registrars for every role's session — the web and browser
   * factories the desktop host owns. Without these the names in a role's
   * allowlist (web_search, browser_*) resolve to nothing, which is what the mesh
   * path did: it declared them and wired neither. */
  readonly extensionFactories?: ExtensionFactory[];
  /** Extension PACKAGES every role's session loads — the chat's own tool dirs, so
   * a subagent has the chat's tools rather than a hand-picked subset. */
  readonly additionalExtensionPaths?: readonly string[];
  /** The roster (to look up each agent's system prompt / peers / built-in tools). */
  readonly roster: readonly MeshAgent[];
  /** Per-turn generation cap (default the model's own). */
  readonly maxTokens?: number;
  /** How many WORK tool calls one message may spend before the role is pushed to
   * conclude. The finishing tools are exempt — see the `freeTools` wiring below.
   * Default {@link DEFAULT_STEPS_PER_MESSAGE}. */
  readonly maxStepsPerMessage?: number;
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
  /** An engineer submitted work and its proof command was run. */
  readonly onSubmitted?: (agentId: string, work: SubmittedWork) => void;
  /** Each hop as it happens — the host derives the live plan from these. */
  readonly onHop?: (hop: MeshHop) => void;
  /** Observe files rescued out of a mangled nested path (see workspace-paths). */
  readonly onRepaired?: (agentId: string, count: number) => void;
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

  /*
   * TELL THEM WHERE THEY ARE.
   *
   * MEASURED: an engineer whose cwd was `<run>/ws` wrote its files to
   * `ws/converter.py` — creating `<run>/ws/ws/`, a whole second copy of the
   * project one level down, invisible to the gate and to everyone else. It had
   * seen the workspace's absolute path in a relayed message and half-applied it.
   *
   * A small model given no anchor invents one. So every agent is told its
   * directory outright, and told that it is already the shell's cwd.
   */
  const workspaceNote = [
    ``,
    `YOUR WORKING DIRECTORY is ${config.cwd}`,
    `It is already the current directory for your shell and your file tools. Address`,
    `everything RELATIVE to it — a bare filename, or a path below it. Never prefix a`,
    `path with the workspace's own directories, and never write outside it.`,
  ].join('\n');

  // The run-only roles get a corner they CAN write in, so "test it like a user"
  // is possible at all. Created up front: a manager that finds no such directory
  // will decide it was told wrong and write into the product instead.
  try {
    mkdirSync(nodePath.join(config.cwd, '.scratch'), { recursive: true });
  } catch {
    // a workspace we cannot prepare is one the run will fail on anyway
  }

  /* WHAT THE MANAGER CANNOT OTHERWISE SEE.
   *
   * The manager is told an engineer has not finished until `submit_work` has
   * ACCEPTED its work — and it has no way to observe that, because acceptance
   * happens inside the engineer's own turn. Its only evidence was the engineer's
   * word, which is exactly what the rule exists to distrust. So an accepted
   * submission is stamped onto the reply the manager actually reads. */
  const submitted = new Map<string, SubmittedWork>();

  const run: RunAgentTurn = async ({ agentId, from, message, talk }) => {
    const agent = roster.get(agentId);
    if (agent === undefined) return { reply: `(there is no ${agentId} on this team.)` };
    talkRef.set(agentId, talk);

    // NO REPLAYED TRANSCRIPT. The agent's session is still open (or resumes from
    // its file), so it already remembers everything it has done and been told —
    // this is just the next thing said to it.
    //
    // ...except the ONE fact that goes stale between messages. Run 10's manager
    // measured the product once, at 920s, and then sent the same diagnosis to the
    // same engineer four times — "cli.py is truncated at line 101" — long after
    // the file had been repaired. It was reasoning from memory about a mutable
    // world. So the manager, whose whole job is integrating other people's work,
    // gets the CURRENT verdict stapled to every message it receives. It is the
    // same lesson as L17 one level up: a check the model must decide to run is a
    // check that does not get run, so put the answer in front of it instead.
    const incoming =
      agent.role === 'manager'
        ? `Message from ${from}:\n${message}\n\n${taskNote(config.task)}`
        : `Message from ${from}:\n${message}`;
    let reply = '';
    try {
      const result = await pool.talk(
        agentId,
        {
          purpose: ROLE_PURPOSE[agent.role] ?? 'engineer',
          systemPrompt: `${agent.systemPrompt}\n${workspaceNote}`,
          // The comm-tool NAMES must be in the allowlist or the SDK never offers them.
          tools: [
            ...agent.tools,
            TALK_TO_TOOL,
            COMMISSION_SPECIALIST_TOOL,
            ...(agent.role === 'engineer' ? [SUBMIT_WORK_TOOL] : []),
          ],
          /*
           * TOOL SEARCH IS FOR ROLES THAT DO WORK. Run 12's CEO spent 23 of its 31
           * turns in `tool_search`, on one model slot, while the engineer that was
           * a single missing import from a passing gate ran out of budget. The CEO
           * needs exactly two verbs — brief the manager, answer questions — and a
           * search tool is only an invitation to find a third.
           */
          /*
           * TOOL SEARCH IS FOR ROLES THAT DO WORK — and neither lead does.
           *
           * This excluded only the CEO, on run 12's measurement: 31 turns, 23 of
           * them `tool_search`, to send two messages. The manager has the same
           * two-verb job one level down — split the work, check what comes back —
           * and once every role gained the app's whole tool surface there was far
           * more corpus to trawl. Measured immediately after: a manager spent 13
           * turns in `tool_search`, tried twice to write the product itself, and
           * never messaged a single engineer. Its session was the only one that
           * existed besides the lead's.
           *
           * An agent with a capability and no work for it will find work for it.
           * The people who need to reach for an unfamiliar tool are the ones
           * actually building and measuring; they keep it.
           */
          enableToolSearch: agent.role !== 'ceo' && agent.role !== 'manager',
          customTools: [
            ...communicationTools(agent, talkThrough(agentId)),
            // ENGINEERS ONLY. This is how a piece comes back: what was built, how
            // they checked it, and — when a command makes sense for this kind of
            // work — the output of the harness running it, so the manager reads
            // what really happened rather than an account of it. Four runs in a
            // row produced working code that was verified BY HAND and reported done,
            ...(agent.role === 'engineer'
              ? [
                  createSubmitWorkTool({
                    cwd: config.cwd,
                    onSubmitted: (w) => {
                      submitted.set(agentId, w);
                      config.onSubmitted?.(agentId, w);
                    },
                  }) as unknown as ToolDefinition,
                ]
              : []),
          ],
          cwd: config.cwd,
          thinking: true,
          samplingMode: 'thinking-general',
          // A BUDGET ON WORK, NOT ON FINISHING. One message gets a bounded number
          // of real tool calls; the tools that END a message — submitting proof,
          // replying to a colleague — are never charged and never blocked. Run 7
          // died in the gap this closes: an engineer spent thirty-odd bash calls
          // inside a single message rewriting one file, never finished its turn,
          // and so never submitted anything. Running out of budget now reads as
          // "conclude", which is the one thing a 4B model needs said out loud.
          maxSteps: config.maxStepsPerMessage ?? DEFAULT_STEPS_PER_MESSAGE,
          // RUN, DO NOT WRITE — for everyone whose job is not building. The
          // manager needs a shell to see a failure with its own eyes; it does not
          // need one to write `gui_app.py`, which is what it did the moment it had
          // one. Engineers keep the ability to write; nobody else has it.
          /*
           * THE LEAD CAN BUILD. It is the chat the user was already talking to,
           * and jedd is explicit: "the CEO should have all the tools ... it
           * should be able to write and work and do small things itself as well
           * as drive and test anything or make small changes."
           *
           * I had gated it, after a run where it wrote the product instead of
           * delegating. That fixed the wrong thing: a lead that CANNOT write is a
           * lead that has to convene a corporation to change one line, which is
           * absurd for the single-html-file case. The judgement of when a job
           * warrants a team belongs to the lead, and lives in its brief.
           *
           * The MANAGER is a different animal — it exists only inside a
           * corporation and its entire job is to hand work out, so writing the
           * product itself is never the right move for it. It stays gated.
           */
          mayWriteFiles: agent.role === 'engineer' || agent.role === 'ceo',
          ...(config.additionalExtensionPaths !== undefined
            ? { additionalExtensionPaths: config.additionalExtensionPaths }
            : {}),
          ...(config.extensionFactories !== undefined
            ? { extensionFactories: config.extensionFactories }
            : {}),
          freeTools: [
            TALK_TO_TOOL,
            COMMISSION_SPECIALIST_TOOL,
            ...(agent.role === 'engineer' ? [SUBMIT_WORK_TOOL] : []),
          ],
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
      const work = submitted.get(agentId);
      if (work !== undefined) {
        submitted.delete(agentId);
        // The manager reads the evidence, not the engineer's summary of it — and
        // anything the engineer noticed outside its own files rides along, because
        // routing that is the manager's job and nobody else's.
        reply = `${reply}\n\n${submissionNote(agentId, work)}`;
      }
      // Rescue anything written into a re-stated copy of the workspace path
      // BEFORE the next agent looks at the tree. Run 11 lost its whole product
      // this way: the engineer built it four levels down in `ws/private/tmp/…/ws`
      // and then submitted `python3 run_tests.py` eight times, refused every time
      // with "No such file or directory". Cheap (a handful of stats) and silent
      // when there is nothing to move, which is almost always.
      const rescued = repairShadowTree(config.cwd);
      if (rescued.length > 0) {
        config.onRepaired?.(agentId, rescued.length);
        reply = `${reply}\n\n${repairNote(rescued)}`;
      }
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
  /** What the machine was probed to have before the team was briefed. */
  readonly capabilities: readonly Capability[];
  /** Named toolchains that were missing — what a human needs to look at. */
  readonly blocked: readonly string[];
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
  /** Each hop as it happens — lets the caller show work being handed out live. */
  readonly onHop?: (hop: MeshHop) => void;
  /** Cooperative stop: fires the mesh's abort so no new agent turns start. */
  readonly signal?: AbortSignal;
  /** Where the TEAM is kept — `.pi/corp/` under this directory. Defaults to the
   * product workspace, so a project's agents live with the code they work on.
   * Explicit `null` runs an anonymous, in-memory team (tests). */
  readonly teamDir?: string | null;
  /** Tool registrars for every role — see MeshAgentHostConfig.extensionFactories. */
  readonly extensionFactories?: ExtensionFactory[];
  /** Extension packages every role loads — see MeshAgentHostConfig. */
  readonly additionalExtensionPaths?: readonly string[];
  readonly maxLiveAgents?: number;
  /** How many times a failing product check is handed back to the team before the
  /** Observe every `submit_work`, accepted or refused. This was declared on the
   * host and NOT forwarded here, so run 7's one successful submission — the first
   * a run had ever produced — left no trace in the transcript, and the run read as
   * though the tool had never fired. */
  readonly onSubmitted?: (agentId: string, work: SubmittedWork) => void;
  /** Observe files rescued out of a mangled nested path (see workspace-paths). */
  readonly onRepaired?: (agentId: string, count: number) => void;
  /** How many WORK tool calls one message may spend before the role is pushed to
   * conclude ({@link DEFAULT_STEPS_PER_MESSAGE}). */
  readonly maxStepsPerMessage?: number;
  /** Skip the capability probe (tests — it shells out). */
  readonly skipCapabilityProbe?: boolean;
}): Promise<CorpMeshRunResult> {
  /*
   * WHAT THIS MACHINE ACTUALLY HAS, measured before anyone is prompted.
   *
   * Not a permission gate — a PLANNING input. A manager that writes twenty pieces
   * of work against Godot on a machine with no Godot has wasted the night, and a
   * team that discovers pyyaml is missing on its last turn has wasted it
   * differently. Present things become facts the team can rely on; absent ones
   * become a named gap it must work around and report, rather than a run that
   * dies at 4am with nobody awake to fix it.
   */
  const capabilities: Capability[] =
    opts.skipCapabilityProbe === true ? [] : probeCapabilities(opts.task);
  const briefing = capabilityBriefing(capabilities);
  const openingMessage = briefing === '' ? opts.task : `${opts.task}\n\n${briefing}`;

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
    task: opts.task,
    ...(opts.additionalExtensionPaths !== undefined
      ? { additionalExtensionPaths: opts.additionalExtensionPaths }
      : {}),
    ...(opts.extensionFactories !== undefined
      ? { extensionFactories: opts.extensionFactories }
      : {}),
    ...(teamDir !== undefined ? { projectDir: teamDir } : {}),
    ...hostPassthrough(opts),
    sessionFileFor: (id) => team.sessionFileFor(id),
    onSessionFile: (id, file) => team.remember(id, roleOf.get(id) ?? 'engineer', file),
  });
  const mesh = new AgentMesh(host, roster, undefined, opts.onHop);
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
    /*
     * THE RUN ENDS WHEN THE CEO SAYS THE VISION IS MET. Nothing automated decides.
     *
     * This used to run a discovered check and hand its failure back to the CEO,
     * bounded by `maxGateRounds`, and the run's verdict was that check's exit
     * code. jedd's correction, and it is the right one: that is a coding-shaped
     * assumption welded into a harness that has to be able to make a film, a
     * document, a dataset — things with no test suite and no exit code. Worse, an
     * automated check that is WRONG holds up a product that is fine, and there is
     * no appeal.
     *
     * The verification is the hierarchy itself, which is how it works with people:
     * the engineer says it is done, the manager USES the thing and looks for what
     * is broken, an auditor traces anything wrong back to whoever owns it, that
     * engineer is sent a fresh contract, and the manager re-checks. When the
     * manager is satisfied it goes to the CEO, who asks the only question that
     * finally matters — is this what was actually asked for? — and either accepts
     * it or sends it back down with what is missing.
     *
     * So this awaits one thing: the CEO's answer. Everything else is the team's
     * own business, and the loops live where the judgement lives.
     */
    const reply = await mesh.run('ceo', openingMessage);
    return {
      reply,
      hops: mesh.hops,
      turns: mesh.turns,
      capabilities,
      blocked: blockedCapabilities(capabilities),
    };
  } finally {
    // Close the live sessions; their FILES stay, so the next run resumes them.
    host.dispose();
  }
}
