/**
 * A project keeps a TEAM, not just files.
 *
 * Without this record, "persistent agents" are persistent for exactly one run:
 * the session files survive on disk but nothing remembers which file belonged to
 * the SFX engineer, so the next run hires a new one wearing the same name. These
 * tests pin the durability that makes "improve the SFX" reach the same person.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadTeamRecord,
  parseTeamRecord,
  saveTeamRecord,
  TEAM_RECORD_VERSION,
  TeamBook,
  teamRecordPath,
  withMember,
} from './team-record';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pd-team-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the team record survives the run', () => {
  it('round-trips through disk', () => {
    const record = {
      version: TEAM_RECORD_VERSION,
      task: 'build a converter',
      members: [
        { id: 'engineer:sfx', role: 'engineer', sessionFile: '/s/a.jsonl', lastActive: 'now' },
      ],
    };
    expect(saveTeamRecord(dir, record)).toBe(true);
    expect(loadTeamRecord(dir)).toEqual(record);
  });

  it('an absent, corrupt or wrong-version file yields an EMPTY team, never a throw', () => {
    expect(loadTeamRecord(dir).members).toEqual([]);
    mkdirSync(path.dirname(teamRecordPath(dir)), { recursive: true });
    writeFileSync(teamRecordPath(dir), '{ not json');
    expect(loadTeamRecord(dir).members).toEqual([]);
    writeFileSync(teamRecordPath(dir), JSON.stringify({ version: 99, members: [{ id: 'x' }] }));
    expect(loadTeamRecord(dir).members).toEqual([]);
    // A run must never die because the team file is damaged — it starts a new team.
    expect(() => loadTeamRecord('/nonexistent/project')).not.toThrow();
  });

  it('drops malformed members but keeps the good ones', () => {
    const parsed = parseTeamRecord(
      JSON.stringify({
        version: TEAM_RECORD_VERSION,
        members: [
          { id: 'ok', role: 'engineer', sessionFile: '/a.jsonl', lastActive: 'now' },
          { id: 'no-file', role: 'engineer' },
          null,
        ],
      }),
    );
    expect(parsed.members.map((m) => m.id)).toEqual(['ok']);
  });

  it('withMember replaces by id rather than appending a duplicate', () => {
    const one = withMember(
      { version: TEAM_RECORD_VERSION, members: [] },
      { id: 'a', role: 'engineer', sessionFile: '/1.jsonl', lastActive: 't1' },
    );
    const two = withMember(one, {
      id: 'a',
      role: 'engineer',
      sessionFile: '/2.jsonl',
      lastActive: 't2',
    });
    expect(two.members).toHaveLength(1);
    expect(two.members[0]?.sessionFile).toBe('/2.jsonl');
  });
});

describe('TeamBook — the same people are still here', () => {
  it('hands back the SAME session file on a later run', () => {
    const first = new TeamBook(dir, 'build a converter');
    expect(first.sessionFileFor('engineer:sfx')).toBeUndefined();
    first.remember('engineer:sfx', 'engineer', path.join(dir, 'sfx.jsonl'));

    // A whole new process reopening the project.
    const later = new TeamBook(dir);
    expect(later.sessionFileFor('engineer:sfx')).toBe(path.join(dir, 'sfx.jsonl'));
    expect(later.members().map((m) => m.id)).toEqual(['engineer:sfx']);
  });

  it('writes atomically — the file on disk is always parseable', () => {
    const book = new TeamBook(dir);
    book.remember('ceo', 'ceo', '/a.jsonl');
    book.remember('manager', 'manager', '/b.jsonl');
    const text = readFileSync(teamRecordPath(dir), 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    expect(parseTeamRecord(text).members).toHaveLength(2);
  });

  it('runs anonymously with no project dir — same API, nothing written', () => {
    const book = new TeamBook(undefined);
    book.remember('ceo', 'ceo', '/a.jsonl');
    expect(book.sessionFileFor('ceo')).toBe('/a.jsonl');
    expect(() => readFileSync(teamRecordPath(dir), 'utf8')).toThrow();
  });
});
