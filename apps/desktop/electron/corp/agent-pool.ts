/**
 * The AGENT POOL — the thing that makes a corp role a PERSON rather than a
 * series of strangers.
 *
 * Before this, every message to a role built a whole new `AgentSession`, ran one
 * prompt, and threw it away (`SessionManager.inMemory()`, a fresh `mkdtemp` agent
 * dir, `dispose()` in `finally`). An engineer talked to twice had no idea it had
 * ever been talked to once. The mesh papered over that by replaying an
 * 8,000-character transcript TAIL into the next fresh prompt — a summary of the
 * conversation pasted in front of a stranger, not a conversation.
 *
 * Here a role is opened ONCE and kept. The second thing said to it is simply the
 * next thing said to someone already in the room: full history, its own tool
 * calls still in context, and the server's KV for that prefix still warm. Its
 * conversation is a real session file under the project, so the team survives the
 * run, the app, and the week — "improve the SFX" months later reaches the same
 * engineer, mid-conversation.
 *
 * Bounded on purpose. Live sessions are memory, and a corp can have many roles,
 * so the pool keeps at most {@link AgentPoolConfig.maxLive} open and evicts the
 * least-recently-spoken-to. Eviction is not forgetting: the session FILE stays,
 * and the next message to that role transparently resumes it.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  type CorpModelHandle,
  type OpenRoleSession,
  openRoleSession,
  type RoleAgentResult,
  type RoleSessionConfig,
  type RoleTurnOptions,
} from './role-agent';

/** Where a project's corp sessions live, one subdirectory per project. */
export const CORP_SESSIONS_RELATIVE_DIR = path.join('.pi', 'corp', 'sessions');

/** How the pool should open a given agent, minus where its session lives (the
 * pool owns that). */
export type AgentSpec = Omit<RoleSessionConfig, 'session'>;

export interface AgentPoolConfig {
  readonly handle: CorpModelHandle;
  /** The project root whose `.pi/corp/sessions/` holds the team's conversations.
   * Omitted → sessions are in-memory (tests, throwaway runs). */
  readonly projectDir?: string;
  /** Max simultaneously-open sessions before the least-recently-used is evicted
   * (its file is kept; it resumes on the next message). Default 6. */
  readonly maxLive?: number;
  /** Restores a previously-persisted session file for an agent id, so a reopened
   * project rehydrates its team. Absent → every agent starts fresh. */
  readonly sessionFileFor?: (agentId: string) => string | undefined;
  /** Called the first time an agent's session file exists, so the caller can
   * record it on the org chart and find the same agent next time. */
  readonly onSessionFile?: (agentId: string, file: string) => void;
  /** How a session is opened. Injected so the pool's LIFECYCLE — who is live, who
   * gets evicted, who resumes from which file — is unit-testable without a model
   * or the pi SDK. Defaults to the real {@link openRoleSession}. */
  readonly openSession?: (
    handle: CorpModelHandle,
    config: RoleSessionConfig,
  ) => Promise<OpenRoleSession>;
}

interface LiveAgent {
  readonly open: OpenRoleSession;
  /** Monotonic counter, for least-recently-used eviction. */
  usedAt: number;
}

const DEFAULT_MAX_LIVE = 6;

/**
 * A safe single path segment for an agent id (`engineer:frontend-1` →
 * `engineer-frontend-1`), so a role's session directory can never escape the
 * project or collide with another role's.
 */
export function agentDirName(agentId: string): string {
  const cleaned = agentId
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.]+/, '')
    .slice(0, 96);
  return cleaned.length > 0 ? cleaned : 'agent';
}

export class AgentPool {
  private readonly live = new Map<string, LiveAgent>();
  private readonly known = new Map<string, string>(); // agentId → session file
  private clock = 0;

  // A plain field, NOT a constructor parameter property: the real-server drivers
  // load this module under Node's strip-only TypeScript, which cannot transform
  // one (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at import time).
  private readonly config: AgentPoolConfig;

  constructor(config: AgentPoolConfig) {
    this.config = config;
  }

  /** The session file backing an agent, once it has one. */
  sessionFile(agentId: string): string | undefined {
    return this.known.get(agentId) ?? this.config.sessionFileFor?.(agentId);
  }

  /** Every agent this pool has opened, with where its conversation is stored. */
  sessionFiles(): ReadonlyMap<string, string> {
    return new Map(this.known);
  }

  /** True while this agent's session is open in memory (vs. resumable from disk). */
  isLive(agentId: string): boolean {
    return this.live.has(agentId);
  }

  /**
   * Say something to an agent, opening or resuming its session as needed. The
   * session stays open afterwards — that is the whole point.
   */
  async talk(
    agentId: string,
    spec: AgentSpec,
    message: string,
    options: RoleTurnOptions = {},
  ): Promise<RoleAgentResult> {
    const agent = await this.acquire(agentId, spec);
    agent.usedAt = ++this.clock;
    return agent.open.prompt(message, options);
  }

  /** How full an agent's context is (0..100), when it is live and readable. */
  contextPercent(agentId: string): number | undefined {
    return this.live.get(agentId)?.open.contextPercent();
  }

  /** Close an agent's session, KEEPING its file — it resumes on the next message. */
  evict(agentId: string): void {
    const agent = this.live.get(agentId);
    if (agent === undefined) return;
    this.live.delete(agentId);
    try {
      agent.open.dispose();
    } catch {
      // a failing dispose must never break the run
    }
  }

  /**
   * Stop every agent that is mid-turn, immediately. Sessions stay OPEN (and their
   * files intact) — this cuts the work, it does not end the conversation. The
   * mesh's own abort only refuses new talks; without this, an agent already
   * looping keeps looping long past the run's budget.
   */
  abortAll(): void {
    for (const agent of this.live.values()) {
      try {
        agent.open.abort();
      } catch {
        // a failing abort must never break teardown
      }
    }
  }

  /** Close every open session (end of run / app quit). Files are kept. */
  disposeAll(): void {
    for (const id of [...this.live.keys()]) this.evict(id);
  }

  private async acquire(agentId: string, spec: AgentSpec): Promise<LiveAgent> {
    const existing = this.live.get(agentId);
    if (existing !== undefined) return existing;

    // Over the cap → close the agent nobody has spoken to for longest. Its file
    // survives, so this costs a re-prefill on its next message, not its memory.
    const maxLive = this.config.maxLive ?? DEFAULT_MAX_LIVE;
    while (this.live.size >= Math.max(1, maxLive)) {
      let oldest: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, a] of this.live) {
        if (a.usedAt < oldestAt) {
          oldest = id;
          oldestAt = a.usedAt;
        }
      }
      if (oldest === undefined) break;
      this.evict(oldest);
    }

    const openWith = this.config.openSession ?? openRoleSession;
    const open = await openWith(this.config.handle, {
      ...spec,
      ...(this.sessionPlacement(agentId) ?? {}),
    });
    const file = open.sessionFile;
    if (file !== undefined && this.known.get(agentId) !== file) {
      this.known.set(agentId, file);
      this.config.onSessionFile?.(agentId, file);
    }
    const agent: LiveAgent = { open, usedAt: ++this.clock };
    this.live.set(agentId, agent);
    return agent;
  }

  /** Resume this agent's conversation if it has one, else start it a new one in
   * the project. No project → in-memory (the session field stays absent). */
  private sessionPlacement(agentId: string): Pick<RoleSessionConfig, 'session'> | undefined {
    const prior = this.sessionFile(agentId);
    if (prior !== undefined) return { session: { kind: 'resume', file: prior } };
    const projectDir = this.config.projectDir;
    if (projectDir === undefined) return undefined;
    const dir = path.join(projectDir, CORP_SESSIONS_RELATIVE_DIR, agentDirName(agentId));
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return undefined; // unwritable project → fall back to in-memory, never fail
    }
    return { session: { kind: 'create', dir } };
  }
}
