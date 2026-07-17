import { describe, expect, it } from 'vitest';
import { buildManagerContractPrompt, parseManagerContracts } from './contracts.js';
import type { Architecture } from './org-chart.js';

/** An architecture where Frontend owns a region and Backend exposes an interface. */
function architecture(): Architecture {
  return {
    moduleMap: [
      { path: 'src/ui/app.tsx', owner: 'Frontend', purpose: 'the app shell' },
      { path: 'src/api/client.ts', owner: 'Backend', purpose: 'the API client' },
    ],
    interfaces: [
      {
        name: 'ApiClient',
        exposedBy: 'Backend',
        path: 'src/api/client.ts',
        summary: 'the typed API client',
        consumedBy: ['Frontend'],
      },
    ],
  };
}

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

  it('is byte-identical to the pre-integration prompt when no architecture is given', () => {
    // A 2-arg call must not carry any architecture-seeding text.
    expect(prompt).not.toContain('SHARED ARCHITECTURE');
    expect(prompt).not.toContain('iface:');
  });
});

describe('buildManagerContractPrompt — seeded with the shared architecture', () => {
  it('gives THIS division its owned directory region and tells it to make distinct files', () => {
    const seeded = buildManagerContractPrompt(
      { name: 'Frontend', purpose: 'the UI' },
      'Build an app.',
      architecture(),
    );
    expect(seeded).toContain('SHARED ARCHITECTURE');
    expect(seeded).toContain('src/ui/app.tsx'); // the region Frontend owns
    expect(seeded).toContain('the app shell');
    expect(seeded).not.toContain('src/api/client.ts — the API client'); // not Frontend's region
    // The granularity fix: spread contracts across DISTINCT FILES in the region,
    // never pile them onto one file, never leave the region.
    expect(seeded).toContain('DISTINCT FILES');
    expect(seeded.toLowerCase()).toContain('never pile multiple contracts onto one file');
    expect(seeded.toLowerCase()).toContain('do not create files outside your region');
  });

  it('lists the interface handles, the iface:<Name> rule, and the symmetric-consumption nudge', () => {
    const seeded = buildManagerContractPrompt(
      { name: 'Frontend', purpose: 'the UI' },
      'Build an app.',
      architecture(),
    );
    expect(seeded).toContain('iface:ApiClient');
    expect(seeded).toContain('exposed by Backend');
    expect(seeded).toContain('"dependsOn": ["iface:GameState"]'); // the worked example
    expect(seeded).toContain('consumed by Frontend');
    // The symmetry fix: reference EVERY handle the work depends on, not one-way.
    expect(seeded).toContain('EVERY handle');
    expect(seeded.toLowerCase()).toContain('symmetric');
    // The self-referential tidy: only depend on interfaces OTHER divisions expose.
    expect(seeded).toContain('OTHER divisions expose');
    expect(seeded.toLowerCase()).toContain('your own division');
  });

  it('tells the EXPOSING division to slot a contract at the interface path', () => {
    const seeded = buildManagerContractPrompt(
      { name: 'Backend', purpose: 'the API' },
      'Build an app.',
      architecture(),
    );
    expect(seeded).toContain('Your division EXPOSES iface:ApiClient');
    expect(seeded).toContain('src/api/client.ts'); // the path a Backend contract must slot to
  });

  it('still bounds granularity (6–12) and keeps the terminator when seeded', () => {
    const seeded = buildManagerContractPrompt(
      { name: 'Frontend', purpose: 'the UI' },
      'Build an app.',
      architecture(),
    );
    expect(seeded).toMatch(/6[–-]12/);
    expect(seeded).toContain(
      'Output between 6 and 12 contracts as a JSON array, then STOP and close the array.',
    );
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

  it('re-syncs past a mid-array element whose notes string is unterminated by a raw newline', () => {
    // EXACT real-qwen failure fixture: a division emitted a 12-element JSON array,
    // but element #4's `notes` value was left unterminated — the model dropped the
    // closing quote, so a RAW NEWLINE lands inside the string and the value runs
    // straight into the object's closing `}` (…"notes": "single-track.\n }, { …).
    // Before the fix this (a) failed the whole-array JSON.parse (illegal control
    // char) AND (b) desynced the salvage scanner on the unterminated `"`, so ONLY
    // the 3 well-formed contracts BEFORE the defect were recovered and the 8 valid
    // ones AFTER it were silently discarded (12 authored → 3 recovered).
    const contract = (i: number): string =>
      `  {
    "id": "div-${i}",
    "title": "Contract ${i}",
    "ownerNodeId": "div-eng-${i}",
    "input": "input ${i}",
    "output": "output ${i}",
    "slot": "src/div/${i}.ts",
    "available": { "tools": ["read", "write"], "imports": ["@pi-desktop/ui"] },
    "reviewRubric": "rubric ${i}",
    "dependsOn": [],
    "status": "queued",
    "notes": "note ${i}"
  }`;
    // Element #4: same shape, but the final field `notes` is left unterminated —
    // no closing quote before the raw newline that precedes the object's `}`.
    const brokenFourth = `  {
    "id": "div-4",
    "title": "Contract 4",
    "ownerNodeId": "div-eng-4",
    "input": "input 4",
    "output": "output 4",
    "slot": "src/div/4.ts",
    "available": { "tools": ["read", "write"], "imports": ["@pi-desktop/ui"] },
    "reviewRubric": "rubric 4",
    "dependsOn": [],
    "status": "queued",
    "notes": "single-track.
  }`;
    const elements = [1, 2, 3].map(contract);
    elements.push(brokenFourth);
    for (let i = 5; i <= 12; i++) elements.push(contract(i));
    const reply = `Here are the contracts for the division:\n\n[\n${elements.join(',\n')}\n]\n`;

    const contracts = parseManagerContracts(reply);
    const ids = contracts.map((c) => c.id);

    // The regression guard: the 8 well-formed contracts AFTER the defect MUST all
    // survive (previously only the 3 before it did).
    for (let i = 5; i <= 12; i++) expect(ids).toContain(`div-${i}`);
    expect(ids).toEqual(expect.arrayContaining(['div-1', 'div-2', 'div-3']));
    // At minimum 11 of 12 (the 3 before + the 8 after); ideally 12 because the
    // poisoned 4th is repaired (unterminated notes closed at the newline).
    expect(contracts.length).toBeGreaterThanOrEqual(11);
    // This fixture's 4th element is fully repairable → all 12 come back in order.
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => `div-${i}`));
    expect(contracts.find((c) => c.id === 'div-4')?.notes).toBe('single-track.');
  });

  it('returns the 1 complete first object when the SECOND object is truncated (regression)', () => {
    // Salvage already handles this: the first object closes, the second is cut
    // off mid-string. The backstop must NOT change this — only the truncated
    // element is lost, the finished one survives.
    const truncated = `[
      {
        "id": "fe-1",
        "title": "App shell",
        "ownerNodeId": "fe-eng-1",
        "input": "design tokens",
        "output": "AppShell component",
        "slot": "src/AppShell.tsx",
        "available": { "tools": ["read", "write"], "imports": ["@pi-desktop/ui"] },
        "reviewRubric": "renders all routes",
        "dependsOn": [],
        "status": "queued"
      },
      {
        "id": "fe-2",
        "title": "Sidebar with a long unfinished descrip`;
    const contracts = parseManagerContracts(truncated);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.id).toBe('fe-1');
  });

  it('closes a truncated FIRST object (all required fields + a dangling string) and returns 1', () => {
    // The real-qwen defect: max_tokens cut the reply off BEFORE the first object
    // ever closed — every required field is already present, but the final
    // `notes` value is a dangling string with no closing quote, no `}`, no `]`.
    // Salvage recovers 0 complete objects; the backstop must close it and return
    // the one contract instead of nothing (the whole division vanishing).
    const truncated = `Here are the contracts for the Frontend division:

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
    "status": "queued",
    "notes": "the earlier flexbox approach broke on overflow and needs a rethin`;
    const contracts = parseManagerContracts(truncated);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.id).toBe('fe-1');
    expect(contracts[0]?.slot).toBe('src/AppShell.tsx');
    // The dangling notes string was closed at the truncation point.
    expect(contracts[0]?.notes).toBe(
      'the earlier flexbox approach broke on overflow and needs a rethin',
    );
  });
});
