import { describe, expect, it } from 'vitest';
import {
  AGENT_ENGINEER_ADDENDUM,
  AGENT_ENGINEER_SYSTEM_PROMPT,
  buildAgentEngineerPrompt,
  buildBumpContinuePrompt,
  buildConsultTools,
  buildEngineerPrompt,
  buildEngineerSubmitGate,
  buildSelfReviewPrompt,
  buildSubmitContractTool,
  CALL_PEER_TOOL,
  CALL_SPECIALIST_TOOL,
  CONSULT_SPECIALIST_LENSES,
  type DependencyContext,
  ENGINEER_SYSTEM_PROMPT,
  engineerAgentToolAllowlist,
  MAX_ENGINEER_BUMPS,
  parseEngineerOutput,
  relativeImportSpecifier,
  SUBMIT_CONTRACT_TOOL,
} from './engineer.js';
import type { Contract } from './org-chart.js';

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'fe-1',
    title: 'App shell layout',
    ownerNodeId: 'fe-eng-1',
    input: 'design tokens + route list',
    output: 'AppShell component (typed props)',
    slot: 'src/AppShell.tsx',
    available: { tools: ['read', 'write'], imports: ['@pi-desktop/ui'] },
    reviewRubric: 'renders all routes; keyboard navigable',
    dependsOn: [],
    status: 'ready',
    ...overrides,
  };
}

describe('ENGINEER_SYSTEM_PROMPT', () => {
  it('carries the engineer disposition, the handbook, and the file-only output rule', () => {
    expect(ENGINEER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    // Library base disposition.
    expect(ENGINEER_SYSTEM_PROMPT).toContain('You are an engineer');
    // The engineering handbook (carried in every contract, spec §7).
    expect(ENGINEER_SYSTEM_PROMPT).toContain('legible to a worker who does not share your context');
    // The load-bearing output rule: the reply IS the file.
    expect(ENGINEER_SYSTEM_PROMPT).toContain('COMPLETE file');
    expect(ENGINEER_SYSTEM_PROMPT.toLowerCase()).toContain('fenced code block');
    expect(ENGINEER_SYSTEM_PROMPT.toLowerCase()).toContain('never a diff');
  });

  it('scopes imports to this standalone project (Fix 0 — no host `@pi-desktop/*` imports)', () => {
    // The real slice-4 defect: an engineer imported the HOST app's `@pi-desktop/ui`
    // in a standalone project. The system prompt now forbids unrelated internal
    // packages while allowing declared / relative / genuine third-party imports.
    expect(ENGINEER_SYSTEM_PROMPT).toContain('Import ONLY from');
    expect(ENGINEER_SYSTEM_PROMPT).toContain('@pi-desktop/*');
    expect(ENGINEER_SYSTEM_PROMPT.toLowerCase()).toContain('standalone project');
    // Still permits the three legitimate import sources.
    expect(ENGINEER_SYSTEM_PROMPT).toContain('relative specifiers');
    expect(ENGINEER_SYSTEM_PROMPT).toContain('third-party');
  });
});

describe('buildEngineerPrompt', () => {
  it('carries the full contract surface (slot, io, tools, imports, rubric)', () => {
    const prompt = buildEngineerPrompt(contract(), []);
    expect(prompt).toContain('App shell layout');
    expect(prompt).toContain('src/AppShell.tsx');
    expect(prompt).toContain('design tokens + route list');
    expect(prompt).toContain('AppShell component (typed props)');
    expect(prompt).toContain('read, write');
    expect(prompt).toContain('@pi-desktop/ui');
    expect(prompt).toContain('renders all routes; keyboard navigable');
    // No dependencies + no region → those sections are absent.
    expect(prompt).not.toContain('DEPENDENCIES');
    expect(prompt).not.toContain('YOUR MODULE REGION');
  });

  it('includes optional notes only when present', () => {
    expect(buildEngineerPrompt(contract(), [])).not.toContain('- Notes:');
    const withNotes = buildEngineerPrompt(contract({ notes: 'use grid, not flexbox' }), []);
    expect(withNotes).toContain('- Notes: use grid, not flexbox');
  });

  it("inlines each dependency's REAL produced file so the engineer builds against real code", () => {
    const deps: DependencyContext[] = [
      {
        contractId: 'gp-1',
        title: 'Game state store',
        slot: 'src/game/state.ts',
        output: 'GameState store (typed)',
        content: 'export interface GameState { score: number }\n',
      },
    ];
    const prompt = buildEngineerPrompt(contract({ dependsOn: ['gp-1'] }), deps);
    expect(prompt).toContain('DEPENDENCIES');
    expect(prompt).toContain('Game state store (gp-1) → src/game/state.ts');
    expect(prompt).toContain('Provides: GameState store (typed)');
    // The actual produced code is inlined, not just the description.
    expect(prompt).toContain('export interface GameState { score: number }');
  });

  it('hands the engineer the EXACT relative import specifier for each dependency', () => {
    // fromSlot src/AppShell.tsx → toSlot src/game/state.ts ⇒ ./game/state
    const deps: DependencyContext[] = [
      {
        contractId: 'gp-1',
        title: 'Game state store',
        slot: 'src/game/state.ts',
        output: 'GameState store (typed)',
      },
    ];
    const prompt = buildEngineerPrompt(contract({ dependsOn: ['gp-1'] }), deps);
    expect(prompt).toContain("Import from './game/state' (do not guess the path");
  });

  it('falls back to the description when a dependency has no produced content', () => {
    const deps: DependencyContext[] = [
      {
        contractId: 'gp-1',
        title: 'Game state store',
        slot: 'src/game/state.ts',
        output: 'GameState store (typed)',
      },
    ];
    const prompt = buildEngineerPrompt(contract({ dependsOn: ['gp-1'] }), deps);
    expect(prompt).toContain('Produced file not available');
    expect(prompt).toContain('Provides: GameState store (typed)');
  });

  it('adds the module region when supplied', () => {
    const prompt = buildEngineerPrompt(
      contract(),
      [],
      '  - src/ui/ (owner Frontend): the UI shell',
    );
    expect(prompt).toContain('YOUR MODULE REGION');
    expect(prompt).toContain('src/ui/ (owner Frontend): the UI shell');
  });
});

describe('AGENT_ENGINEER_ADDENDUM (self-contained module-builder framing)', () => {
  it('drives WRITE → bash → submit_contract, forbids exploration, and describes the §164 review', () => {
    const a = AGENT_ENGINEER_ADDENDUM;
    // Writing is the single required action; the submit tool closes the turn.
    expect(a).toContain('write tool');
    expect(a).toContain('submit_contract');
    // Kill the over-exploration defect.
    expect(a.toLowerCase()).toContain('do not explore');
    expect(a).toContain('ls / find / grep');
    // Read ONLY declared deps; a quick bash self-check.
    expect(a.toLowerCase()).toContain('read only');
    expect(a).toContain('bash');
    // The §164 self-review bounce: one chance to improve before it is final.
    expect(a.toLowerCase()).toContain('improve the file before it is final');
    // No corporation lore — the engineer builds ONE module, alone.
    expect(a.toLowerCase()).toContain('one self-contained module');
    for (const lore of ['CEO', 'manager', 'division', 'corporation']) expect(a).not.toContain(lore);
  });
});

describe('AGENT_ENGINEER_SYSTEM_PROMPT (scoped, lore-free)', () => {
  it('is self-contained: handbook + import rule + the write flow, and NO corp lore', () => {
    const s = AGENT_ENGINEER_SYSTEM_PROMPT;
    expect(s).toContain('one self-contained module'.replace('one', 'ONE'));
    // The engineering handbook is carried.
    expect(s).toContain('legible to a worker who does not share your context');
    // Import scoping preserved (no host @pi-desktop/* imports).
    expect(s).toContain('@pi-desktop/*');
    // The write flow addendum is included.
    expect(s).toContain('submit_contract');
    // A model that does NOT know the corporation exists — no org structure lore.
    for (const lore of ['CEO', 'manager', 'division', 'corporation', 'peer', 'escalat'])
      expect(s).not.toContain(lore);
  });
});

describe('buildAgentEngineerPrompt (agent path — drives to a write + submit)', () => {
  it('opens on the slot as the single deliverable and keeps the exact-path marker', () => {
    const prompt = buildAgentEngineerPrompt(contract(), []);
    expect(prompt).toContain('single required deliverable is the file at src/AppShell.tsx');
    // The exact-path line the dispatch relies on to identify the slot.
    expect(prompt).toContain('write your file to THIS exact path): src/AppShell.tsx');
    // Closes on WRITE → bash → submit_contract.
    expect(prompt).toContain('submit_contract');
    expect(prompt.toLowerCase()).toContain('do not explore');
  });

  it('tells an engineer with NO deps to read nothing and go straight to writing', () => {
    const prompt = buildAgentEngineerPrompt(contract(), []);
    expect(prompt).toContain('DEPENDENCIES: none');
    expect(prompt.toLowerCase()).toContain('go straight to writing');
  });

  it('lists declared deps as read-only exact paths with the import specifier', () => {
    const deps: DependencyContext[] = [
      {
        contractId: 'gp-1',
        title: 'Game state store',
        slot: 'src/game/state.ts',
        output: 'GameState store (typed)',
      },
    ];
    const prompt = buildAgentEngineerPrompt(contract({ dependsOn: ['gp-1'] }), deps);
    expect(prompt).toContain('Read ONLY these exact files');
    expect(prompt).toContain('Read file: src/game/state.ts');
    expect(prompt).toContain("Import from './game/state'");
  });

  it('appends CEO revision notes when re-dispatched', () => {
    const prompt = buildAgentEngineerPrompt(contract(), [], undefined, 'fix the null case');
    expect(prompt).toContain('CEO REVISION NOTES');
    expect(prompt).toContain('fix the null case');
  });
});

describe('buildSubmitContractTool (§164 submission interceptor)', () => {
  it('carries the slot + the model-free self-review prompt, and names the slot in the description', () => {
    const c = contract({ slot: 'src/game/physics.ts' });
    const tool = buildSubmitContractTool(c);
    expect(tool.name).toBe(SUBMIT_CONTRACT_TOOL);
    expect(tool.name).toBe('submit_contract');
    // The §164 payload: the slot to verify + the strengthened submit GATE prompt.
    expect(tool.submitReview?.slot).toBe('src/game/physics.ts');
    expect(tool.submitReview?.reviewPrompt).toBe(buildEngineerSubmitGate(c));
    expect(tool.submitReview?.reviewPrompt).toContain(c.reviewRubric);
    // The gate DEMANDS real verification (compile + check deps), not a re-read.
    expect(tool.submitReview?.reviewPrompt).toContain('COMPILE');
    expect(tool.submitReview?.reviewPrompt.toLowerCase()).toContain('dependency files');
    // The description frames the one-review-then-final flow.
    expect(tool.description).toContain('src/game/physics.ts');
    expect(tool.description.toLowerCase()).toContain('improve');
    // A well-formed, arg-light JSON schema (no required args).
    const params = tool.parameters as { type: string; required: string[] };
    expect(params.type).toBe('object');
    expect(params.required).toEqual([]);
  });
});

describe('F1 — submit_contract is a bounded, TERMINATING two-step submit', () => {
  it('the review-gate (first-call bounce) declares the next submit FINAL and turn-ending', () => {
    const gate = buildEngineerSubmitGate(contract());
    // The verification pass improves the file, then the NEXT submit is terminal.
    expect(gate).toContain('FINAL');
    expect(gate.toLowerCase()).toContain('ends your turn');
    // No affirm-and-continue after the finalizing submit; no confirm loop.
    expect(gate.toLowerCase()).toContain('do not');
    expect(gate.toLowerCase()).toContain('confirm loop');
  });

  it('the tool description frames a two-call submit whose SECOND call finalizes + ends the turn', () => {
    const tool = buildSubmitContractTool(contract());
    expect(tool.description).toContain('FINALIZES');
    expect(tool.description.toLowerCase()).toContain('ends your turn');
    // Bounded: never call it more than twice.
    expect(tool.description.toLowerCase()).toContain('twice');
  });

  it('the agent addendum + agent prompt both say the SECOND submit ends the turn (output nothing after)', () => {
    expect(AGENT_ENGINEER_ADDENDUM.toLowerCase()).toContain('ends your turn');
    expect(AGENT_ENGINEER_ADDENDUM.toLowerCase()).toContain('do not keep re-submitting');
    const prompt = buildAgentEngineerPrompt(contract(), []);
    expect(prompt).toContain('FINALIZES');
    expect(prompt.toLowerCase()).toContain('ends your turn');
  });
});

describe('engineerAgentToolAllowlist (submit_contract + file tools)', () => {
  it('adds submit_contract to the built-in engineer toolset (the allowlist gotcha)', () => {
    const tools = engineerAgentToolAllowlist(['write']);
    expect(tools).toContain('submit_contract');
    // Keeps the file tools an engineer needs to read deps + write its slot + check.
    expect(tools).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash']));
  });

  it('honours a genuinely-declared subset but always keeps read/write + submit', () => {
    const tools = engineerAgentToolAllowlist(['read', 'write', 'bash']);
    expect(tools).toEqual(expect.arrayContaining(['read', 'write', 'bash', 'submit_contract']));
  });

  it('also lists the two consult tools by NAME (the allowlist gotcha for custom tools)', () => {
    const tools = engineerAgentToolAllowlist(['write']);
    expect(tools).toEqual(expect.arrayContaining([CALL_PEER_TOOL, CALL_SPECIALIST_TOOL]));
  });
});

describe('buildBumpContinuePrompt (completeness backstop — bounded)', () => {
  it('names the slot, demands write + submit, and offers the unfulfillable escape', () => {
    const prompt = buildBumpContinuePrompt(contract());
    expect(prompt).toContain('without submitting');
    expect(prompt).toContain('src/AppShell.tsx'); // the exact slot
    expect(prompt).toContain('submit_contract');
    expect(prompt.toLowerCase()).toContain('unfulfillable, because');
  });

  it('bounds bump-to-continue to 2 (a completeness backstop, not a per-agent cap)', () => {
    expect(MAX_ENGINEER_BUMPS).toBe(2);
  });
});

describe('buildConsultTools (peer + specialist consults, advice-only)', () => {
  it('builds call_peer with a clean-context peer prompt + the stuck-contract context', () => {
    const [peer] = buildConsultTools(contract(), { promptId: 'frontend-dev', domain: 'the UI' });
    expect(peer?.name).toBe(CALL_PEER_TOOL);
    expect(peer?.consult?.kind).toBe('peer');
    // A peer is a clean-context instance of the engineer's own division/role.
    expect(peer?.consult?.systemPrompt).toContain('PEER');
    expect(peer?.consult?.systemPrompt).toContain('ADVICE ONLY');
    // Minimal relevant context — the stuck contract's slot + what it must produce.
    expect(peer?.consult?.context).toContain('src/AppShell.tsx');
    expect(peer?.consult?.context).toContain('AppShell component (typed props)');
  });

  it('builds call_specialist with correctness/security/performance lenses from PROMPT_LIBRARY', () => {
    const tools = buildConsultTools(contract());
    const specialist = tools.find((t) => t.name === CALL_SPECIALIST_TOOL);
    expect(specialist?.consult?.kind).toBe('specialist');
    const lenses = Object.keys(specialist?.consult?.lensPrompts ?? {});
    expect(lenses).toEqual([...CONSULT_SPECIALIST_LENSES]);
    // The lens prompts are the evidence-grounded advisory-reviewer prompts.
    expect(specialist?.consult?.lensPrompts?.correctness).toContain('advisory specialist');
    // The `lens` argument is required so the model names which lens it wants.
    expect(specialist?.parameters).toMatchObject({ required: expect.arrayContaining(['lens']) });
  });
});

describe('buildSelfReviewPrompt (model-free bounce)', () => {
  it('asks the engineer to re-check against the contract + rubric and return the final file', () => {
    const prompt = buildSelfReviewPrompt(contract());
    expect(prompt.toLowerCase()).toContain('review');
    expect(prompt).toContain('src/AppShell.tsx'); // the slot
    expect(prompt).toContain('renders all routes; keyboard navigable'); // the rubric
    expect(prompt).toContain('FINAL file');
    expect(prompt.toLowerCase()).toContain('output only the file');
  });
});

describe('parseEngineerOutput', () => {
  it('extracts the file body from a fenced, prose-wrapped reply (keeps code verbatim)', () => {
    const reply = `Sure, here is the file for the slot:

\`\`\`tsx
export function AppShell() {
  return <div className="shell" />;
}
\`\`\`

Let me know if you want changes.`;
    expect(parseEngineerOutput(reply)).toBe(
      'export function AppShell() {\n  return <div className="shell" />;\n}',
    );
  });

  it('returns a plain (unfenced) reply verbatim, trimming only outer blank lines', () => {
    const reply = '\n\nexport const x = 1;\nexport const y = 2;\n\n';
    expect(parseEngineerOutput(reply)).toBe('export const x = 1;\nexport const y = 2;');
  });

  it('prefers the LARGEST fenced block (the file over a stray inline snippet)', () => {
    const reply = `First a tiny example: \`\`\`ts
const a = 1;
\`\`\`

Now the actual file:

\`\`\`ts
export function big() {
  const one = 1;
  const two = 2;
  const three = 3;
  return one + two + three;
}
\`\`\``;
    const out = parseEngineerOutput(reply);
    expect(out).toContain('export function big()');
    expect(out).not.toContain('const a = 1;');
  });

  it('recovers the body from an opening fence with no closer (truncated reply)', () => {
    const reply = `Here is the file:

\`\`\`ts
export function cut() {
  return 42;`;
    expect(parseEngineerOutput(reply)).toBe('export function cut() {\n  return 42;');
  });

  it('preserves internal blank lines and indentation inside the fence', () => {
    const reply = '```ts\nline1\n\n    indented\n```';
    expect(parseEngineerOutput(reply)).toBe('line1\n\n    indented');
  });

  it('returns "" for empty / non-string input (never throws)', () => {
    expect(parseEngineerOutput('')).toBe('');
    // @ts-expect-error — exercising the runtime guard for a non-string reply.
    expect(parseEngineerOutput(undefined)).toBe('');
  });
});

describe('relativeImportSpecifier', () => {
  it('yields ./name for a same-directory sibling (extension stripped)', () => {
    expect(relativeImportSpecifier('src/mechanics/gameLoop.ts', 'src/mechanics/state.ts')).toBe(
      './state',
    );
    expect(relativeImportSpecifier('src/a.ts', 'src/b.ts')).toBe('./b');
  });

  it('yields ../dir/name for a sibling directory', () => {
    expect(relativeImportSpecifier('src/mechanics/gameLoop.ts', 'src/engine/state.ts')).toBe(
      '../engine/state',
    );
    expect(relativeImportSpecifier('src/ui/hud.tsx', 'src/api/client.ts')).toBe('../api/client');
  });

  it('yields ./sub/name for a nested subdirectory', () => {
    expect(relativeImportSpecifier('src/a.ts', 'src/ui/theme/tokens.ts')).toBe('./ui/theme/tokens');
    expect(relativeImportSpecifier('index.ts', 'lib/util.ts')).toBe('./lib/util');
  });

  it('walks up multiple levels when the target is shallower / elsewhere', () => {
    expect(relativeImportSpecifier('src/a/b/c.ts', 'src/x/y.ts')).toBe('../../x/y');
    expect(relativeImportSpecifier('src/deep/nested/file.ts', 'src/root.ts')).toBe('../../root');
  });

  it('does not falsely share a prefix between `foo` and `foobar`', () => {
    expect(relativeImportSpecifier('src/foo/a.ts', 'src/foobar/b.ts')).toBe('../foobar/b');
  });

  it('handles root-level files on both sides', () => {
    expect(relativeImportSpecifier('a.ts', 'b.ts')).toBe('./b');
    expect(relativeImportSpecifier('src/a.ts', 'b.ts')).toBe('../b');
  });

  it('tolerates backslash separators and redundant . segments', () => {
    expect(relativeImportSpecifier('src\\mechanics\\loop.ts', 'src/mechanics/state.ts')).toBe(
      './state',
    );
    expect(relativeImportSpecifier('./src/a.ts', './src/b.ts')).toBe('./b');
  });

  it('strips only the final extension (keeps .test-style stems)', () => {
    expect(relativeImportSpecifier('src/a.ts', 'src/state.test.ts')).toBe('./state.test');
  });

  it('always produces a dot-anchored specifier', () => {
    for (const spec of [
      relativeImportSpecifier('src/a.ts', 'src/b.ts'),
      relativeImportSpecifier('src/a/b.ts', 'src/c.ts'),
      relativeImportSpecifier('a.ts', 'sub/deep/x.ts'),
    ]) {
      expect(spec.startsWith('./') || spec.startsWith('../')).toBe(true);
    }
  });
});
