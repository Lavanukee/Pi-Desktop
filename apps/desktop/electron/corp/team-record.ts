/**
 * The TEAM RECORD — which agents this project has, and where each one's
 * conversation is stored.
 *
 * A project keeps a team, not just files. Without this, a "persistent" agent is
 * only persistent for the length of one run: the session file survives on disk
 * but nothing remembers WHICH file belonged to the SFX engineer, so the next run
 * hires a new one wearing the same name. This is the small durable map that turns
 * "sessions happen to be saved" into "the same person is still here".
 *
 * Deliberately its own tiny artifact next to the org chart rather than a field
 * inside it: it is written on a hot path (the first time each agent speaks), it
 * is the one thing that MUST survive a crash mid-run, and it is legible on its own
 * — `cat .pi/corp/team.json` tells you who is on the project and where to read
 * what they said.
 *
 * Node fs only (electron-main), injected in tests. Never throws: a project whose
 * team file is unreadable starts a fresh team rather than failing the run.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Project-relative location of the team record. */
export const TEAM_RECORD_RELATIVE_PATH = path.join('.pi', 'corp', 'team.json');

/** Bumped on breaking shape changes so a loader can refuse an old file. */
export const TEAM_RECORD_VERSION = 1;

/** One agent's durable identity on this project. */
export interface TeamMember {
  /** Mesh id — `ceo`, `manager`, `engineer:frontend-1`, `specialist:tester`. */
  readonly id: string;
  /** Role family, for display and for rebuilding the roster. */
  readonly role: string;
  /** Absolute path to this agent's session file — its memory. */
  readonly sessionFile: string;
  /** ISO timestamp of the last time it was spoken to. */
  readonly lastActive: string;
}

export interface TeamRecord {
  readonly version: number;
  /** The task the team was originally stood up for (context when reopening). */
  readonly task?: string;
  readonly members: readonly TeamMember[];
}

const EMPTY: TeamRecord = { version: TEAM_RECORD_VERSION, members: [] };

/** Absolute path of the team record for a project directory. */
export function teamRecordPath(projectDir: string): string {
  return path.join(projectDir, TEAM_RECORD_RELATIVE_PATH);
}

/** Parse a team record, or the empty team for anything unrecognisable. */
export function parseTeamRecord(text: string): TeamRecord {
  try {
    const raw = JSON.parse(text) as Partial<TeamRecord>;
    if (raw.version !== TEAM_RECORD_VERSION || !Array.isArray(raw.members)) return EMPTY;
    const members = raw.members.filter(
      (m): m is TeamMember =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as TeamMember).id === 'string' &&
        typeof (m as TeamMember).role === 'string' &&
        typeof (m as TeamMember).sessionFile === 'string',
    );
    return {
      version: TEAM_RECORD_VERSION,
      ...(typeof raw.task === 'string' ? { task: raw.task } : {}),
      members,
    };
  } catch {
    return EMPTY;
  }
}

/** Read a project's team, or the empty team when it has none / is unreadable. */
export function loadTeamRecord(projectDir: string): TeamRecord {
  try {
    return parseTeamRecord(readFileSync(teamRecordPath(projectDir), 'utf8'));
  } catch {
    return EMPTY;
  }
}

/**
 * Write the team record atomically (temp + rename), so a crash mid-write can
 * never leave a project with a half-parsed team. Best-effort: an unwritable
 * project loses persistence, not the run.
 */
export function saveTeamRecord(projectDir: string, record: TeamRecord): boolean {
  const file = teamRecordPath(projectDir);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Add or update one member, preserving the rest. Pure. */
export function withMember(record: TeamRecord, member: TeamMember): TeamRecord {
  const members = record.members.filter((m) => m.id !== member.id);
  return { ...record, members: [...members, member] };
}

/**
 * A live view of one project's team: reads the record once, hands out session
 * files by agent id, and persists each new agent as it first speaks.
 *
 * `projectDir` undefined → an in-memory team (tests, throwaway runs): the same
 * API, nothing written.
 */
export class TeamBook {
  private record: TeamRecord;

  constructor(
    private readonly projectDir: string | undefined,
    task?: string,
  ) {
    this.record =
      projectDir === undefined
        ? EMPTY
        : { ...loadTeamRecord(projectDir), ...(task !== undefined ? { task } : {}) };
  }

  /** Where this agent's conversation is, if it has been on this project before. */
  sessionFileFor(agentId: string): string | undefined {
    return this.record.members.find((m) => m.id === agentId)?.sessionFile;
  }

  /** Record where an agent's conversation landed (called on its first turn). */
  remember(agentId: string, role: string, sessionFile: string): void {
    this.record = withMember(this.record, {
      id: agentId,
      role,
      sessionFile,
      lastActive: new Date().toISOString(),
    });
    if (this.projectDir !== undefined) saveTeamRecord(this.projectDir, this.record);
  }

  /** The team as it stands. */
  members(): readonly TeamMember[] {
    return this.record.members;
  }
}
