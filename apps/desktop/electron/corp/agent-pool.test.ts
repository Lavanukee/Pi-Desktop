/**
 * The pool is what turns a role from a series of strangers into a person, so the
 * behaviour worth pinning is IDENTITY: is this the same session I spoke to before,
 * and when it has to be closed for memory, does it come BACK as itself?
 *
 * The session opener is injected, so all of that is testable without a model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentPool, type AgentSpec, agentDirName, CORP_SESSIONS_RELATIVE_DIR } from './agent-pool';
import type {
  CorpModelHandle,
  OpenRoleSession,
  RoleAgentResult,
  RoleSessionConfig,
  RoleTurnOptions,
} from './role-agent';

const handle = {} as CorpModelHandle;
const spec: AgentSpec = {
  purpose: 'engineer',
  systemPrompt: 'you build things',
  tools: ['read', 'write'],
  cwd: '/tmp/product',
  thinking: true,
  samplingMode: 'thinking-coding',
};

/** A fake session that records what it was opened with and what it was told. */
function fakeOpener() {
  const opened: RoleSessionConfig[] = [];
  const disposed: string[] = [];
  let serial = 0;
  const open = async (_h: CorpModelHandle, config: RoleSessionConfig): Promise<OpenRoleSession> => {
    opened.push(config);
    const id = `session-${++serial}`;
    const said: string[] = [];
    return {
      prompt: async (message: string, _options?: RoleTurnOptions): Promise<RoleAgentResult> => {
        said.push(message);
        return {
          finalText: `${id} heard ${said.length} message(s)`,
          filesWritten: [],
          toolCalls: [],
          stats: undefined,
          turns: 1,
          bumps: 0,
          maxTurnOutputTokens: 0,
          terminatedReason: 'stop' as const,
          samplingCalls: 1,
          sentSampling: undefined,
        };
      },
      sessionFile:
        config.session?.kind === 'resume'
          ? config.session.file
          : config.session?.kind === 'create'
            ? path.join(config.session.dir, `${id}.jsonl`)
            : undefined,
      contextPercent: () => 12,
      dispose: () => disposed.push(id),
    };
  };
  return { open, opened, disposed };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pd-pool-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('an agent is opened once and kept', () => {
  it('talking twice reuses ONE session — the whole point', async () => {
    const fake = fakeOpener();
    const pool = new AgentPool({ handle, openSession: fake.open });

    const first = await pool.talk('engineer:sfx', spec, 'build the audio bus');
    const second = await pool.talk('engineer:sfx', spec, 'now make it louder');

    expect(fake.opened).toHaveLength(1); // NOT one per turn
    expect(first.finalText).toContain('1 message');
    expect(second.finalText).toContain('2 message'); // same session, it remembers
    expect(pool.isLive('engineer:sfx')).toBe(true);
  });

  it('different agents get different sessions', async () => {
    const fake = fakeOpener();
    const pool = new AgentPool({ handle, openSession: fake.open });
    await pool.talk('engineer:a', spec, 'hello');
    await pool.talk('engineer:b', spec, 'hello');
    expect(fake.opened).toHaveLength(2);
  });
});

describe('eviction is not forgetting', () => {
  it('closes the least-recently-spoken-to agent over the cap', async () => {
    const fake = fakeOpener();
    const pool = new AgentPool({ handle, openSession: fake.open, maxLive: 2, projectDir: dir });

    await pool.talk('a', spec, '1');
    await pool.talk('b', spec, '1');
    await pool.talk('a', spec, '2'); // `a` is now the most recent
    await pool.talk('c', spec, '1'); // over the cap → `b` goes, not `a`

    expect(pool.isLive('a')).toBe(true);
    expect(pool.isLive('b')).toBe(false);
    expect(pool.isLive('c')).toBe(true);
    expect(fake.disposed).toHaveLength(1);
  });

  it('an evicted agent RESUMES its own conversation, it does not start over', async () => {
    const fake = fakeOpener();
    const pool = new AgentPool({ handle, openSession: fake.open, maxLive: 1, projectDir: dir });

    await pool.talk('a', spec, 'first');
    const aFile = pool.sessionFile('a');
    expect(aFile).toBeDefined();
    await pool.talk('b', spec, 'first'); // evicts `a`
    expect(pool.isLive('a')).toBe(false);

    await pool.talk('a', spec, 'still there?'); // brings `a` back
    const reopened = fake.opened.at(-1);
    expect(reopened?.session).toEqual({ kind: 'resume', file: aFile });
  });
});

describe('where a conversation is stored', () => {
  it('creates a per-agent directory under the project and reports the file', async () => {
    const fake = fakeOpener();
    const files: Array<[string, string]> = [];
    const pool = new AgentPool({
      handle,
      openSession: fake.open,
      projectDir: dir,
      onSessionFile: (id, file) => files.push([id, file]),
    });
    await pool.talk('engineer:frontend-1', spec, 'hello');

    const expectedDir = path.join(dir, CORP_SESSIONS_RELATIVE_DIR, 'engineer-frontend-1');
    expect(fake.opened[0]?.session).toEqual({ kind: 'create', dir: expectedDir });
    expect(files).toHaveLength(1);
    expect(files[0]?.[0]).toBe('engineer:frontend-1');
    expect(pool.sessionFile('engineer:frontend-1')).toBe(files[0]?.[1]);
  });

  it('resumes from a team record on a reopened project', async () => {
    const fake = fakeOpener();
    const pool = new AgentPool({
      handle,
      openSession: fake.open,
      projectDir: dir,
      sessionFileFor: (id) => (id === 'engineer:sfx' ? '/saved/sfx.jsonl' : undefined),
    });
    await pool.talk('engineer:sfx', spec, 'improve the sfx');
    expect(fake.opened[0]?.session).toEqual({ kind: 'resume', file: '/saved/sfx.jsonl' });
  });

  it('runs in-memory with no project — never writes, never fails', async () => {
    const fake = fakeOpener();
    const pool = new AgentPool({ handle, openSession: fake.open });
    await pool.talk('ceo', spec, 'hello');
    expect(fake.opened[0]?.session).toBeUndefined();
    expect(pool.sessionFile('ceo')).toBeUndefined();
  });

  it('an agent id can never escape the project directory', () => {
    expect(agentDirName('engineer:frontend-1')).toBe('engineer-frontend-1');
    expect(agentDirName('...')).toBe('agent');
    expect(agentDirName('')).toBe('agent');
    // Separators become hyphens and LEADING dots are stripped, so a traversal
    // collapses into one inert segment. Dots elsewhere survive (they are legal in
    // a name) but can no longer form a `..` SEGMENT, which is what matters.
    expect(agentDirName('../../etc/passwd')).toBe('-..-etc-passwd');
    for (const hostile of ['../../etc/passwd', '/absolute/path', '..', './..', 'a/../../b']) {
      const segment = agentDirName(hostile);
      expect(segment).not.toContain(path.sep);
      expect(segment.split(path.sep)).not.toContain('..');
      expect(path.resolve('/p', segment).startsWith(`${path.sep}p${path.sep}`)).toBe(true);
    }
  });
});

describe('teardown', () => {
  it('disposeAll closes every live session', async () => {
    const fake = fakeOpener();
    const pool = new AgentPool({ handle, openSession: fake.open });
    await pool.talk('a', spec, '1');
    await pool.talk('b', spec, '1');
    pool.disposeAll();
    expect(fake.disposed).toHaveLength(2);
    expect(pool.isLive('a')).toBe(false);
  });

  it('a throwing dispose can never break the run', async () => {
    const pool = new AgentPool({
      handle,
      openSession: async () => ({
        prompt: async () => {
          throw new Error('unused');
        },
        sessionFile: undefined,
        contextPercent: () => undefined,
        dispose: () => {
          throw new Error('dispose exploded');
        },
      }),
    });
    await pool.talk('a', spec, '1').catch(() => undefined);
    expect(() => pool.disposeAll()).not.toThrow();
  });
});
