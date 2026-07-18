import { describe, expect, it } from 'vitest';
import type { DeliveryShape } from './delivery.js';
import {
  buildIntegrationContract,
  ensureIntegrationContract,
  INTEGRATION_CONTRACT_ID,
  INTEGRATION_OWNER_NODE_ID,
  integrationEntrySlot,
  needsIntegrationEntry,
} from './integration-contract.js';
import { type Architecture, type Contract, isContract } from './org-chart.js';

/** A full, valid contract at a given slot. */
function contract(id: string, slot: string, dependsOn: string[] = []): Contract {
  return {
    id,
    title: id,
    ownerNodeId: `eng-${id}`,
    input: 'in',
    output: 'out',
    slot,
    available: { tools: ['write'], imports: [] },
    reviewRubric: 'rubric',
    dependsOn,
    status: 'queued',
  };
}

const EMPTY_ARCH: Architecture = { moduleMap: [], interfaces: [] };
const OPENABLE: DeliveryShape = { openableSingleFile: true, web: true };
const PLAIN_WEB: DeliveryShape = { openableSingleFile: false, web: true };
const NEUTRAL: DeliveryShape = { openableSingleFile: false, web: false };

describe('needsIntegrationEntry (spec §5/§8, Part A)', () => {
  it('is true for a web product (by delivery shape) with no runnable entry', () => {
    const contracts = [contract('c1', 'src/game.ts'), contract('c2', 'src/render.ts')];
    expect(needsIntegrationEntry(contracts, EMPTY_ARCH, OPENABLE)).toBe(true);
  });

  it('is true for a renderable product (by slot) even with a neutral vision', () => {
    const contracts = [contract('c1', 'src/app.tsx'), contract('c2', 'styles.css')];
    expect(needsIntegrationEntry(contracts, EMPTY_ARCH, NEUTRAL)).toBe(true);
  });

  it('is FALSE when a contract already owns a runnable entry (no double-up)', () => {
    const contracts = [contract('c1', 'index.html'), contract('c2', 'src/app.tsx')];
    expect(needsIntegrationEntry(contracts, EMPTY_ARCH, OPENABLE)).toBe(false);
    const withPkg = [contract('c1', 'package.json'), contract('c2', 'src/app.tsx')];
    expect(needsIntegrationEntry(withPkg, EMPTY_ARCH, PLAIN_WEB)).toBe(false);
  });

  it('is FALSE for a pure-logic product (no browser entry to own)', () => {
    const contracts = [contract('c1', 'src/sort.ts'), contract('c2', 'src/cli.ts')];
    expect(needsIntegrationEntry(contracts, EMPTY_ARCH, NEUTRAL)).toBe(false);
  });

  it('detects web-ness from the architecture module map / interfaces too', () => {
    const arch: Architecture = {
      moduleMap: [{ path: 'src/ui/', owner: 'UI', purpose: 'the HUD' }],
      interfaces: [
        { name: 'View', exposedBy: 'UI', path: 'src/ui/view.tsx', summary: 's', consumedBy: [] },
      ],
    };
    expect(needsIntegrationEntry([contract('c1', 'src/logic.ts')], arch, NEUTRAL)).toBe(true);
  });
});

describe('integrationEntrySlot', () => {
  it('is a root index.html for a web/openable product', () => {
    expect(integrationEntrySlot([contract('c1', 'src/app.tsx')], EMPTY_ARCH, OPENABLE)).toBe(
      'index.html',
    );
  });

  it('is a src/main entry for a pure-logic product', () => {
    expect(integrationEntrySlot([contract('c1', 'src/lib.ts')], EMPTY_ARCH, NEUTRAL)).toBe(
      'src/main.ts',
    );
  });
});

describe('buildIntegrationContract (spec §5/§8, Part A/C)', () => {
  const divisionContracts = [
    contract('game-1', 'src/game/state.ts'),
    contract('ui-1', 'src/ui/hud.ts'),
  ];
  const arch: Architecture = {
    moduleMap: [],
    interfaces: [
      {
        name: 'GameState',
        exposedBy: 'Game',
        path: 'src/game/state.ts',
        summary: 'the store',
        consumedBy: ['UI'],
      },
    ],
  };

  it('is a valid Contract that owns the runnable entry and depends on every division output', () => {
    const c = buildIntegrationContract({
      divisionContracts,
      architecture: arch,
      deliveryShape: OPENABLE,
      vision: 'a snake game',
    });
    expect(isContract(c)).toBe(true);
    expect(c.id).toBe(INTEGRATION_CONTRACT_ID);
    expect(c.ownerNodeId).toBe(INTEGRATION_OWNER_NODE_ID);
    expect(c.slot).toBe('index.html');
    // Runs LAST — depends on every division output.
    expect(c.dependsOn).toEqual(['game-1', 'ui-1']);
    // The delivery constraint reaches the brief; the output is self-contained + openable.
    expect(c.notes).toContain('DELIVERY CONSTRAINT');
    expect(c.output).toContain('SELF-CONTAINED');
    expect(c.reviewRubric.toLowerCase()).toContain('opening the entry');
    // It names the interfaces it wires.
    expect(c.input).toContain('GameState');
  });

  it('honors a dependsOn override + extra notes (the Part C recovery shape)', () => {
    const c = buildIntegrationContract({
      divisionContracts,
      architecture: arch,
      deliveryShape: OPENABLE,
      vision: 'v',
      dependsOn: [],
      extraNotes: 'The reviewers measured: no runnable entry.',
    });
    expect(c.dependsOn).toEqual([]);
    expect(c.notes).toContain('no runnable entry');
  });

  it('a non-openable web product gets a plain (non-self-contained) runnable entry', () => {
    const c = buildIntegrationContract({
      divisionContracts,
      architecture: EMPTY_ARCH,
      deliveryShape: PLAIN_WEB,
      vision: 'v',
    });
    expect(c.slot).toBe('index.html');
    expect(c.notes).not.toContain('DELIVERY CONSTRAINT');
    expect(c.output).not.toContain('SELF-CONTAINED');
  });
});

describe('ensureIntegrationContract (spec §5/§8, Part A)', () => {
  it('injects the integration contract + its owner node for a web product', () => {
    const contracts = [contract('c1', 'src/app.tsx'), contract('c2', 'src/logic.ts')];
    const result = ensureIntegrationContract({
      contracts,
      architecture: EMPTY_ARCH,
      deliveryShape: OPENABLE,
      vision: 'a game',
      ownerParentNodeId: 'manager',
    });
    expect(result.contracts).toHaveLength(3);
    expect(result.injected?.slot).toBe('index.html');
    expect(result.injected?.dependsOn).toEqual(['c1', 'c2']);
    expect(result.ownerNode?.id).toBe(INTEGRATION_OWNER_NODE_ID);
    expect(result.ownerNode?.role).toBe('engineer');
    expect(result.ownerNode?.parentId).toBe('manager');
  });

  it('is a no-op for a pure-logic product (returns the contracts unchanged)', () => {
    const contracts = [contract('c1', 'src/sort.ts')];
    const result = ensureIntegrationContract({
      contracts,
      architecture: EMPTY_ARCH,
      deliveryShape: NEUTRAL,
      vision: 'a CLI',
    });
    expect(result.contracts).toEqual(contracts);
    expect(result.injected).toBeUndefined();
    expect(result.ownerNode).toBeUndefined();
  });

  it('is a no-op when a contract already owns a runnable entry', () => {
    const contracts = [contract('c1', 'index.html'), contract('c2', 'src/app.tsx')];
    const result = ensureIntegrationContract({
      contracts,
      architecture: EMPTY_ARCH,
      deliveryShape: OPENABLE,
      vision: 'a game',
    });
    expect(result.injected).toBeUndefined();
    expect(result.contracts).toHaveLength(2);
  });

  it('uniquifies the injected id against an existing collision', () => {
    const contracts = [
      contract(INTEGRATION_CONTRACT_ID, 'src/app.tsx'),
      contract('c2', 'src/logic.ts'),
    ];
    const result = ensureIntegrationContract({
      contracts,
      architecture: EMPTY_ARCH,
      deliveryShape: OPENABLE,
      vision: 'a game',
    });
    expect(result.injected?.id).toBe(`${INTEGRATION_CONTRACT_ID}-2`);
  });

  it('does not mutate the input contracts array', () => {
    const contracts = [contract('c1', 'src/app.tsx')];
    const snapshot = structuredClone(contracts);
    ensureIntegrationContract({
      contracts,
      architecture: EMPTY_ARCH,
      deliveryShape: OPENABLE,
      vision: 'a game',
    });
    expect(contracts).toEqual(snapshot);
  });
});
