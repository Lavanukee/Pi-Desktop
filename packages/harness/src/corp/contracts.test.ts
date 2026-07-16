import { describe, expect, it } from 'vitest';
import { buildManagerContractPrompt, parseManagerContracts } from './contracts.js';

describe('buildManagerContractPrompt', () => {
  const division = { name: 'Frontend', purpose: 'build the UI shell' };
  const prompt = buildManagerContractPrompt(division, '  Build a note-taking app.  ');

  it('carries the division, its purpose, and the trimmed vision', () => {
    expect(prompt).toContain('Frontend');
    expect(prompt).toContain('build the UI shell');
    expect(prompt).toContain('Build a note-taking app.');
    expect(prompt).not.toContain('  Build a note-taking app.  '); // vision was trimmed
  });

  it('states the BOUNDED small-focused principle (6–12, else sub-divisions) and asks for a JSON array', () => {
    expect(prompt).toMatch(/6[–-]12/); // the bounded contract-count range
    expect(prompt.toLowerCase()).toContain('sub-division');
    expect(prompt.toLowerCase()).toContain('json array');
    expect(prompt).not.toContain('100'); // the runaway "100 small contracts" framing is gone
  });

  it('adds a terminator, sharper tools-vs-imports guidance, and a distinct-slot nudge', () => {
    expect(prompt).toContain(
      'Output between 6 and 12 contracts as a JSON array, then STOP and close the array.',
    );
    expect(prompt).toContain('"typescript"'); // the NOT-an-import example
    expect(prompt.toLowerCase()).toContain('is not an import');
    expect(prompt).toContain('DISTINCT slot'); // two contracts must not target the same file
  });

  it('names every required Contract field plus the optional notes', () => {
    for (const field of [
      'id',
      'title',
      'ownerNodeId',
      'input',
      'output',
      'slot',
      'available',
      'reviewRubric',
      'dependsOn',
      'notes',
      'status',
    ]) {
      expect(prompt).toContain(`"${field}"`);
    }
  });
});

describe('parseManagerContracts', () => {
  /** A well-formed contract the model might emit (one with notes, one without). */
  const sampleReply = `Here are the contracts for the Frontend division:

\`\`\`json
[
  {
    "id": "fe-1",
    "title": "App shell layout",
    "ownerNodeId": "fe-eng-1",
    "input": "design tokens + route list",
    "output": "AppShell component (typed props)",
    "slot": "src/AppShell.tsx",
    "available": { "tools": ["read", "write"], "imports": ["@pi-desktop/ui"] },
    "reviewRubric": "renders all routes; keyboard navigable",
    "dependsOn": [],
    "notes": "the earlier flexbox approach broke on overflow — use grid",
    "status": "queued"
  },
  {
    "id": "fe-2",
    "title": "Sidebar",
    "ownerNodeId": "fe-eng-2",
    "input": "AppShell slot",
    "output": "Sidebar component",
    "slot": "src/Sidebar.tsx",
    "available": { "tools": ["read", "write"], "imports": ["@pi-desktop/ui"] },
    "reviewRubric": "collapses under 640px",
    "dependsOn": ["fe-1"],
    "status": "queued"
  }
]
\`\`\`

Let me know if you want more.`;

  it('extracts + validates contracts from a fenced, prose-wrapped reply', () => {
    const contracts = parseManagerContracts(sampleReply);
    expect(contracts).toHaveLength(2);
    expect(contracts[0]?.id).toBe('fe-1');
    expect(contracts[0]?.notes).toBe('the earlier flexbox approach broke on overflow — use grid');
    expect(contracts[1]?.dependsOn).toEqual(['fe-1']);
    expect(contracts[1]?.notes).toBeUndefined(); // notes is optional
  });

  it('parses a bare array with no fence or prose', () => {
    const bare = JSON.stringify([
      {
        id: 'c1',
        title: 't',
        ownerNodeId: 'o',
        input: 'i',
        output: 'o',
        slot: 's',
        available: { tools: [], imports: [] },
        reviewRubric: 'r',
        dependsOn: [],
        status: 'queued',
      },
    ]);
    expect(parseManagerContracts(bare)).toHaveLength(1);
  });

  it('normalizes the two most-omitted fields (dependsOn, status)', () => {
    const reply = `[
      {
        "id": "c1",
        "title": "t",
        "ownerNodeId": "o",
        "input": "i",
        "output": "out",
        "slot": "s",
        "available": { "tools": [], "imports": [] },
        "reviewRubric": "r"
      }
    ]`;
    const [c] = parseManagerContracts(reply);
    expect(c?.status).toBe('queued');
    expect(c?.dependsOn).toEqual([]);
  });

  it('drops elements that are not valid contracts, keeping the good ones', () => {
    const reply = `[
      { "nope": true },
      {
        "id": "ok",
        "title": "t",
        "ownerNodeId": "o",
        "input": "i",
        "output": "out",
        "slot": "s",
        "available": { "tools": [], "imports": [] },
        "reviewRubric": "r",
        "dependsOn": [],
        "status": "queued"
      }
    ]`;
    const contracts = parseManagerContracts(reply);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.id).toBe('ok');
  });

  it('returns [] (never throws) when there is no usable array', () => {
    expect(parseManagerContracts('I could not produce contracts.')).toEqual([]);
    expect(parseManagerContracts('[ not json ]')).toEqual([]);
    expect(parseManagerContracts('')).toEqual([]);
  });

  it('salvages the complete contracts from a reply truncated mid-array (unclosed)', () => {
    // A fenced array whose 3rd element is cut off mid-string — no closing } or ].
    const truncated = `Here are the contracts:

\`\`\`json
[
  {
    "id": "fe-1",
    "title": "App shell",
    "ownerNodeId": "fe-eng-1",
    "input": "design tokens + route list",
    "output": "AppShell component",
    "slot": "src/AppShell.tsx",
    "available": { "tools": ["read", "write"], "imports": ["@pi-desktop/ui"] },
    "reviewRubric": "renders all routes",
    "dependsOn": [],
    "status": "queued"
  },
  {
    "id": "fe-2",
    "title": "Sidebar",
    "ownerNodeId": "fe-eng-2",
    "input": "AppShell slot",
    "output": "Sidebar component",
    "slot": "src/Sidebar.tsx",
    "available": { "tools": ["read", "write"], "imports": ["@pi-desktop/ui"] },
    "reviewRubric": "collapses under 640px",
    "dependsOn": ["fe-1"],
    "status": "queued"
  },
  {
    "id": "fe-3",
    "title": "Header with a long unfinished descrip`;
    const contracts = parseManagerContracts(truncated);
    expect(contracts).toHaveLength(2);
    expect(contracts.map((c) => c.id)).toEqual(['fe-1', 'fe-2']);
    expect(contracts[1]?.dependsOn).toEqual(['fe-1']);
  });

  it('salvage drops a truncated element that is not a valid contract, keeping earlier good ones', () => {
    // Unclosed array: one complete valid contract, then a complete-but-invalid
    // object, then a truncated fragment. Only the valid one survives.
    const truncated = `[
      {
        "id": "ok",
        "title": "t",
        "ownerNodeId": "o",
        "input": "i",
        "output": "out",
        "slot": "s",
        "available": { "tools": [], "imports": [] },
        "reviewRubric": "r",
        "dependsOn": [],
        "status": "queued"
      },
      { "nope": true },
      { "id": "cut", "title": "unclosed`;
    const contracts = parseManagerContracts(truncated);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.id).toBe('ok');
  });
});
