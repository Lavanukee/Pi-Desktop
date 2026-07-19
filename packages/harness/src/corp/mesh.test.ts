import { describe, expect, it } from 'vitest';
import {
  AgentMesh,
  type AgentTurnRequest,
  type MeshAgent,
  type MeshBudget,
  type RunAgentTurn,
} from './mesh.js';

/** A minimal agent spec for tests (peers/tools default to empty). */
function agent(id: string, peers: string[] = []): MeshAgent {
  return { id, role: id.split(':')[0] ?? id, systemPrompt: `You are ${id}.`, peers, tools: [] };
}

/** Build a mesh whose turn-runner dispatches to a per-agent scripted handler. Each
 * handler gets the request (incl. the `talk` router) and returns the agent's reply. */
function scriptedMesh(
  agents: MeshAgent[],
  handlers: Record<string, (req: AgentTurnRequest) => Promise<string> | string>,
  budget?: MeshBudget,
): AgentMesh {
  const run: RunAgentTurn = async (req) => {
    const h = handlers[req.agentId];
    return { reply: h === undefined ? `(${req.agentId} has nothing to say)` : await h(req) };
  };
  return budget ? new AgentMesh(run, agents, budget) : new AgentMesh(run, agents);
}

describe('AgentMesh — basic prompting', () => {
  it('prompts the root agent and returns its reply', async () => {
    const mesh = scriptedMesh([agent('ceo')], { ceo: (req) => `CEO heard: ${req.message}` });
    expect(await mesh.run('ceo', 'build a game')).toBe('CEO heard: build a game');
    expect(mesh.turns).toBe(1);
  });

  it('a missing root agent yields a plain note (never throws)', async () => {
    const mesh = scriptedMesh([agent('ceo')], {});
    expect(await mesh.run('nobody', 'hi')).toContain('no "nobody"');
  });
});

describe('AgentMesh — talk_to routing (the emergent conversation)', () => {
  it('routes CEO → manager and folds the reply back', async () => {
    const mesh = scriptedMesh([agent('ceo', ['manager']), agent('manager', ['ceo'])], {
      ceo: async (req) => {
        const reply = await req.talk('ceo', 'manager', `vision: ${req.message}`);
        return `CEO: the manager said "${reply}"`;
      },
      manager: (req) => `on it — ${req.message}`,
    });
    const out = await mesh.run('ceo', 'a 3D runner');
    expect(out).toBe('CEO: the manager said "on it — vision: a 3D runner"');
    expect(mesh.turns).toBe(2);
  });

  it('routes recursively CEO → manager → engineer', async () => {
    const agents = [
      agent('ceo', ['manager']),
      agent('manager', ['ceo', 'engineer']),
      agent('engineer', ['manager']),
    ];
    const mesh = scriptedMesh(agents, {
      ceo: (req) => req.talk('ceo', 'manager', req.message),
      manager: async (req) => {
        const built = await req.talk('manager', 'engineer', 'build the core');
        return `delivered: ${built}`;
      },
      engineer: () => 'core.ts written',
    });
    expect(await mesh.run('ceo', 'go')).toBe('delivered: core.ts written');
    expect(mesh.turns).toBe(3);
    // A hop is recorded when its turn SETTLES, so the deepest settles first.
    expect(mesh.hops.map((h) => `${h.from}->${h.to}`)).toEqual([
      'manager->engineer',
      'ceo->manager',
      'user->ceo',
    ]);
  });
});

describe('AgentMesh — bounds (an emergent loop must never run away)', () => {
  it('refuses a talk to a non-peer', async () => {
    const mesh = scriptedMesh([agent('ceo', ['manager']), agent('manager'), agent('tester')], {
      ceo: (req) => req.talk('ceo', 'tester', 'review'), // tester is NOT a CEO peer
    });
    expect(await mesh.run('ceo', 'go')).toContain('not set up to talk to "tester"');
  });

  it('refuses a talk to an unknown agent', async () => {
    const mesh = scriptedMesh([agent('ceo', ['ghost'])], {
      ceo: (req) => req.talk('ceo', 'ghost', 'hi'),
    });
    expect(await mesh.run('ceo', 'go')).toContain('no "ghost"');
  });

  it('caps talk_to nesting depth (a chain that would nest forever)', async () => {
    // A distinct-agent CHAIN a→b→c→d→e (no cycle, so the busy guard never fires) —
    // the depth cap is what stops it.
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const agents = ids.map((id, i) => agent(id, i + 1 < ids.length ? [ids[i + 1] as string] : []));
    const handlers = Object.fromEntries(
      ids.map((id, i) => {
        const next = ids[i + 1];
        return [id, (req: AgentTurnRequest) => (next ? req.talk(id, next, 'go') : 'leaf')];
      }),
    );
    const mesh = scriptedMesh(agents, handlers, { maxTurns: 100, maxDepth: 3 });
    await mesh.run('a', 'start');
    expect(mesh.hops.some((h) => h.refused === 'too-deep')).toBe(true);
  });

  it('caps total turns across the mesh (a fan-out beyond the budget)', async () => {
    // A hub that talks to more peers than the turn budget allows — the later talks are
    // refused for out-of-turns (no cycle, so nothing is "busy").
    const peers = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const agents = [agent('hub', peers), ...peers.map((p) => agent(p, ['hub']))];
    const handlers: Record<string, (req: AgentTurnRequest) => Promise<string> | string> = {
      hub: async (req) => {
        for (const p of peers) await req.talk('hub', p, 'do');
        return 'done';
      },
    };
    for (const p of peers) handlers[p] = () => 'ok';
    const mesh = scriptedMesh(agents, handlers, { maxTurns: 4, maxDepth: 100 });
    await mesh.run('hub', 'go');
    expect(mesh.turns).toBe(4);
    expect(mesh.exhausted).toBe(true);
    expect(mesh.hops.some((h) => h.refused === 'out-of-turns')).toBe(true);
  });

  it('abort() halts the run — a mid-turn talk is refused and the peer never runs', async () => {
    // The CEO stops the run mid-turn, then tries to talk to its manager: the talk is
    // refused 'aborted' and the manager's handler never executes.
    let managerRan = false;
    const mesh = scriptedMesh([agent('ceo', ['manager']), agent('manager')], {
      ceo: async (req) => {
        mesh.abort();
        return `manager said: ${await req.talk('ceo', 'manager', 'do the thing')}`;
      },
      manager: () => {
        managerRan = true;
        return 'done';
      },
    });
    const out = await mesh.run('ceo', 'go');
    expect(out).toContain('the run was stopped');
    expect(managerRan).toBe(false);
    expect(mesh.hops.some((h) => h.refused === 'aborted')).toBe(true);
  });

  it('abort() before run refuses even the root prompt (no turn runs)', async () => {
    const mesh = scriptedMesh([agent('ceo')], { ceo: () => 'hi' });
    mesh.abort();
    expect(await mesh.run('ceo', 'go')).toContain('the run was stopped');
    expect(mesh.turns).toBe(0);
  });

  it('reports a re-entrant talk to a busy (mid-turn) agent instead of deadlocking', async () => {
    // ceo prompts manager; while manager is mid-turn it tries to talk BACK to ceo,
    // who is still on the stack → "busy".
    let sawBusy = '';
    const mesh = scriptedMesh([agent('ceo', ['manager']), agent('manager', ['ceo'])], {
      ceo: (req) => req.talk('ceo', 'manager', req.message),
      manager: async (req) => {
        sawBusy = await req.talk('manager', 'ceo', 'quick question');
        return 'done anyway';
      },
    });
    const out = await mesh.run('ceo', 'go');
    expect(sawBusy).toContain('busy');
    expect(out).toBe('done anyway');
  });

  it('a throwing seam becomes the agent’s reply, never a mesh crash', async () => {
    const run: RunAgentTurn = async (req) => {
      if (req.agentId === 'manager') throw new Error('kaboom');
      return { reply: await req.talk('ceo', 'manager', 'go') };
    };
    const mesh = new AgentMesh(run, [agent('ceo', ['manager']), agent('manager', ['ceo'])]);
    const out = await mesh.run('ceo', 'go');
    expect(out).toContain('kaboom');
  });
});
