import { describe, expect, it } from 'vitest';
import {
  buildEngineerPrompt,
  buildSelfReviewPrompt,
  type DependencyContext,
  ENGINEER_SYSTEM_PROMPT,
  parseEngineerOutput,
  relativeImportSpecifier,
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
