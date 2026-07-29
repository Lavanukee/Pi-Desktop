import { describe, expect, it } from 'vitest';
import {
  buildCorpRoster,
  COMMISSION_SPECIALIST_TOOL,
  engineerId,
  MESH_SPECIALIST_KINDS,
  runCorpMesh,
  specialistId,
  specialistMeshPrompt,
  specialistToolsFor,
  TALK_TO_TOOL,
} from './corp-mesh.js';
import type { AgentTurnRequest, RunAgentTurn } from './mesh.js';

describe('buildCorpRoster', () => {
  it('makes the CEO, manager, an engineer pool, and one specialist per kind', () => {
    const roster = buildCorpRoster({ task: 'build a game', engineerCount: 3 });
    const ids = roster.map((a) => a.id);
    expect(ids).toContain('ceo');
    expect(ids).toContain('manager');
    expect(ids).toContain(engineerId(1));
    expect(ids).toContain(engineerId(3));
    for (const kind of MESH_SPECIALIST_KINDS) expect(ids).toContain(specialistId(kind));
  });

  it('lets EVERYONE reach the specialists (commission for all) + the right colleagues', () => {
    const roster = buildCorpRoster({ task: 't', engineerCount: 2 });
    const by = Object.fromEntries(roster.map((a) => [a.id, a]));
    // Every non-specialist can reach every specialist.
    for (const id of ['ceo', 'manager', engineerId(1), engineerId(2)]) {
      for (const kind of MESH_SPECIALIST_KINDS) {
        expect(by[id]?.peers).toContain(specialistId(kind));
      }
    }
    // The CEO talks to the manager; the manager to the CEO + engineers.
    expect(by.ceo?.peers).toContain('manager');
    expect(by.manager?.peers).toContain('ceo');
    expect(by.manager?.peers).toContain(engineerId(1));
    // Engineers report to the manager.
    expect(by[engineerId(1)]?.peers).toContain('manager');
  });
});

describe('runCorpMesh — an emergent build from a scripted conversation', () => {
  it('CEO → manager → engineers (contracts) → manager commissions tester → back to CEO', async () => {
    const seen: string[] = [];
    // A scripted multi-agent conversation: each agent decides what to do from its
    // incoming message. This is the shape a real run takes — the model drives it; here
    // the script stands in for the model.
    const runAgentTurn: RunAgentTurn = async (req: AgentTurnRequest) => {
      seen.push(`${req.from}->${req.agentId}`);
      switch (req.agentId) {
        case 'ceo': {
          // Prompted by the user with the task → talk to the manager with a vision.
          const delivered = await req.talk('ceo', 'manager', 'vision: a snake game');
          return { reply: `Shipped for the user. Manager said: ${delivered}` };
        }
        case 'manager': {
          // Prompted by the CEO → assign two contracts, then commission the tester.
          const a = await req.talk('manager', engineerId(1), 'contract: game loop → game.js');
          const b = await req.talk('manager', engineerId(2), 'contract: input → input.js');
          const test = await req.talk('manager', specialistId('tester'), 'does it run?');
          return { reply: `built (${a}; ${b}); tester: ${test}` };
        }
        case engineerId(1):
          return { reply: 'game.js written' };
        case engineerId(2):
          return { reply: 'input.js written' };
        case specialistId('tester'):
          return { reply: 'PASS — it loads and plays' };
        default:
          return { reply: '(idle)' };
      }
    };

    const result = await runCorpMesh({ task: 'make a snake game', engineerCount: 2, runAgentTurn });

    // The CEO's final reply carries the whole chain up.
    expect(result.reply).toContain('Shipped for the user');
    expect(result.reply).toContain('game.js written');
    expect(result.reply).toContain('input.js written');
    expect(result.reply).toContain('PASS');
    // The emergent conversation actually happened, in the right shape.
    expect(seen[0]).toBe('user->ceo');
    expect(seen).toContain('ceo->manager');
    expect(seen).toContain(`manager->${engineerId(1)}`);
    expect(seen).toContain(`manager->${engineerId(2)}`);
    expect(seen).toContain(`manager->${specialistId('tester')}`);
    // Turns: ceo + manager + 2 engineers + tester.
    expect(result.turns).toBe(5);
    expect(result.exhausted).toBe(false);
  });

  it('an engineer can commission a specialist mid-build (anyone reaches specialists)', async () => {
    let engineerCommissioned = false;
    const runAgentTurn: RunAgentTurn = async (req) => {
      switch (req.agentId) {
        case 'ceo':
          return { reply: await req.talk('ceo', 'manager', 'go') };
        case 'manager':
          return { reply: await req.talk('manager', engineerId(1), 'build it') };
        case engineerId(1): {
          const advice = await req.talk(engineerId(1), specialistId('security'), 'is this safe?');
          engineerCommissioned = true;
          return { reply: `built, security says: ${advice}` };
        }
        case specialistId('security'):
          return { reply: 'no secrets leaked' };
        default:
          return { reply: '(idle)' };
      }
    };
    const result = await runCorpMesh({ task: 't', engineerCount: 1, runAgentTurn });
    expect(engineerCommissioned).toBe(true);
    expect(result.reply).toContain('no secrets leaked');
  });
});

describe('corp-mesh tool names', () => {
  it('exposes the two universal communication primitives', () => {
    expect(TALK_TO_TOOL).toBe('talk_to');
    expect(COMMISSION_SPECIALIST_TOOL).toBe('commission_specialist');
  });
});

describe('the producing specialists (jedd’s presets)', () => {
  // Four specialists whose output is an ARTIFACT rather than an answer: an
  // improved image, a rendered clip, a critique, a research deliverable. They
  // needed their own spine — the measuring spine forbids the very thing they are
  // for ("you have no editor") — and their own tools.
  const prompt = (k: string) => specialistMeshPrompt(k);

  it('are in the roster, so anyone can commission them', () => {
    for (const kind of ['image', 'motion', 'ui-critic', 'research']) {
      expect(MESH_SPECIALIST_KINDS).toContain(kind);
      const agent = buildCorpRoster({ task: 't' }).find((a) => a.id === specialistId(kind));
      expect(agent).toBeDefined();
      expect(agent?.role).toBe('specialist');
    }
  });

  it('can WRITE, unlike every lens — their deliverable is a file', () => {
    for (const kind of ['image', 'motion', 'ui-critic', 'research']) {
      expect(specialistToolsFor(kind)).toContain('write');
    }
    // The measuring lenses still cannot: a measurer that edits destroys the evidence.
    for (const kind of ['auditor', 'correctness', 'security', 'tester']) {
      expect(specialistToolsFor(kind)).not.toContain('write');
    }
  });

  it('carry the producer spine, not the "you do not build" one', () => {
    for (const kind of ['image', 'motion', 'ui-critic', 'research']) {
      expect(prompt(kind)).toContain('COME BACK WITH FILES');
      expect(prompt(kind)).not.toContain('You MEASURE. You do not build');
    }
    expect(prompt('auditor')).toContain('You MEASURE. You do not build');
  });

  it('each gets the kit its job actually needs, not one shared list', () => {
    // Capability decides behaviour, so the kits differ on purpose.
    expect(specialistToolsFor('image')).toContain('generate_image');
    expect(specialistToolsFor('motion')).toContain('generate_video'); // HyperFrames path
    expect(specialistToolsFor('motion')).toContain('mcp_call'); // + the ffmpeg façade
    expect(specialistToolsFor('ui-critic')).toContain('browser_navigate');
    expect(specialistToolsFor('research')).toContain('browser_screenshot');
    // A critic has no shell — it judges an interface, it does not run builds.
    expect(specialistToolsFor('ui-critic')).not.toContain('bash');
    // An unknown kind still gets a workable default rather than nothing.
    expect(specialistToolsFor('whatever')).toContain('read');
  });

  it('tell the truth about what they can SEE', () => {
    // The one lie the system cannot catch. The image specialist is held to the
    // same rule as the visual one.
    expect(prompt('image')).toContain('NEVER describe an image you have not looked at');
    expect(prompt('visual')).toContain('NEVER describe what something looks like');
  });

  it('the researcher delivers the FORM that was asked for', () => {
    const p = prompt('research');
    expect(p).toContain('READ THE DELIVERABLE FIRST');
    expect(p).toContain('folder');
    expect(p).toContain('CITE EVERYTHING');
  });

  it('the motion specialist checks its own render instead of trusting it', () => {
    // A black MP4 of the right length is how this fails silently.
    expect(prompt('motion')).toContain('CHECK THE RENDER');
  });
});

describe('the CEO is the chat you were already talking to', () => {
  // jedd: the initial model IS the CEO — it just becomes one the moment it calls
  // talk_to. Stripping its tools at that moment means "hi" and "hi, and build me
  // this" put you in front of two different assistants.
  const ceo = () => buildCorpRoster({ task: 't' }).find((a) => a.id === 'ceo');

  it('keeps the ordinary tool surface — it does not lose the web when it delegates', () => {
    const tools = ceo()?.tools ?? [];
    for (const t of ['read', 'write', 'edit', 'ls', 'bash', 'web_search', 'browser_navigate']) {
      expect(tools).toContain(t);
    }
  });

  it('still has the manager and the specialists as peers', () => {
    expect(ceo()?.peers).toContain('manager');
    expect(ceo()?.peers).toContain(specialistId('auditor'));
  });
});
