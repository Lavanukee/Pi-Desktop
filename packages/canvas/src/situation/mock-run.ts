/**
 * A scripted, deterministic mock of a full corporation run (the 3D-game
 * scenario) for developing and demoing the situation room without a model.
 *
 * The SHAPE mirrors the real slice-3 runs (docs/harness-architecture.md,
 * "Integration layer"): promotion → CEO → architect lays out a 5-region module
 * map + 4 typed interfaces → 5 division managers write 48 contracts (7 of them
 * with real cross-division dependencies) → dispatch: engineers land 48 files
 * one by one WITH live per-file phases + line deltas, the checklist fills from
 * contract state, the ETA range narrows, and three exercise sessions slide the
 * activity panel in (a browse pass while planning, a mid-build test pass, and
 * a final playtest at review) → review → sign-off → done. All USER-FACING copy
 * stays in plain project language (the org vocabulary above is internal).
 * Wall-clock is compressed to ~53s.
 *
 * Everything here is plain data + `setTimeout` — renderer-safe, no Node
 * imports, and only type-imports of the coordination DTOs.
 */

import type {
  Activity,
  ChecklistItem,
  ChecklistItemState,
  CoordinationEvent,
  InterfaceSeamView,
  ModuleRegionView,
  OrgChartView,
  OrgNodeView,
} from '@pi-desktop/coordination';

/** One scheduled event on the compressed demo clock (`at` = ms from start). */
export interface TimedCoordinationEvent {
  readonly at: number;
  readonly event: CoordinationEvent;
}

export const MOCK_TASK_ID = 'demo-corp-run';

// ---------------------------------------------------------------------------
// The corporation (static shape of the scripted run)
// ---------------------------------------------------------------------------

interface MockDivision {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly purpose: string;
}

const DIVISIONS: readonly MockDivision[] = [
  {
    id: 'div-engine',
    name: 'Core Engine',
    region: 'src/engine/',
    purpose: 'renderer, loop, physics, input',
  },
  {
    id: 'div-game',
    name: 'Game Logic',
    region: 'src/game/',
    purpose: 'state, entities, combat, levels',
  },
  { id: 'div-ui', name: 'UI/UX', region: 'src/ui/', purpose: 'HUD, menus, screens' },
  { id: 'div-audio', name: 'Audio', region: 'src/audio/', purpose: 'bus, music, sfx, spatial mix' },
  { id: 'div-assets', name: 'Assets', region: 'assets/', purpose: 'models, textures, materials' },
];

const INTERFACES: readonly InterfaceSeamView[] = [
  {
    name: 'GameState',
    exposedBy: 'Game Logic',
    path: 'src/game/state.ts',
    consumedBy: ['UI/UX', 'Audio'],
  },
  {
    name: 'RendererAPI',
    exposedBy: 'Core Engine',
    path: 'src/engine/renderer.ts',
    consumedBy: ['Game Logic', 'UI/UX'],
  },
  {
    name: 'AudioBus',
    exposedBy: 'Audio',
    path: 'src/audio/bus.ts',
    consumedBy: ['Game Logic', 'UI/UX'],
  },
  {
    name: 'AssetManifest',
    exposedBy: 'Assets',
    path: 'assets/manifest.ts',
    consumedBy: ['Core Engine', 'Game Logic'],
  },
];

interface MockContract {
  readonly id: string;
  readonly title: string;
  readonly division: string; // division id
  readonly file: string;
  readonly dependsOn: readonly string[];
}

/** 48 contracts across 5 divisions — the real-run granularity. */
const CONTRACTS: readonly MockContract[] = [
  // Core Engine — 11
  {
    id: 'eng-01',
    title: 'Renderer core',
    division: 'div-engine',
    file: 'src/engine/renderer.ts',
    dependsOn: [],
  },
  {
    id: 'eng-02',
    title: 'Game loop & clock',
    division: 'div-engine',
    file: 'src/engine/loop.ts',
    dependsOn: [],
  },
  {
    id: 'eng-03',
    title: 'Scene graph',
    division: 'div-engine',
    file: 'src/engine/scene.ts',
    dependsOn: ['eng-01'],
  },
  {
    id: 'eng-04',
    title: 'Camera rig',
    division: 'div-engine',
    file: 'src/engine/camera.ts',
    dependsOn: ['eng-03'],
  },
  {
    id: 'eng-05',
    title: 'Input mapper',
    division: 'div-engine',
    file: 'src/engine/input.ts',
    dependsOn: [],
  },
  {
    id: 'eng-06',
    title: 'Physics world',
    division: 'div-engine',
    file: 'src/engine/physics.ts',
    dependsOn: [],
  },
  {
    id: 'eng-07',
    title: 'Collision system',
    division: 'div-engine',
    file: 'src/engine/collision.ts',
    dependsOn: ['eng-06'],
  },
  {
    id: 'eng-08',
    title: 'Lighting pipeline',
    division: 'div-engine',
    file: 'src/engine/lighting.ts',
    dependsOn: ['eng-01'],
  },
  {
    id: 'eng-09',
    title: 'Particle system',
    division: 'div-engine',
    file: 'src/engine/particles.ts',
    dependsOn: ['eng-01'],
  },
  {
    id: 'eng-10',
    title: 'Asset loader bridge',
    division: 'div-engine',
    file: 'src/engine/loader.ts',
    dependsOn: ['as-01'],
  },
  {
    id: 'eng-11',
    title: 'Debug overlay',
    division: 'div-engine',
    file: 'src/engine/debug.ts',
    dependsOn: ['eng-02'],
  },
  // Game Logic — 11
  {
    id: 'gl-01',
    title: 'Game state store',
    division: 'div-game',
    file: 'src/game/state.ts',
    dependsOn: [],
  },
  {
    id: 'gl-02',
    title: 'Entity system',
    division: 'div-game',
    file: 'src/game/entities.ts',
    dependsOn: ['gl-01'],
  },
  {
    id: 'gl-03',
    title: 'Player controller',
    division: 'div-game',
    file: 'src/game/player.ts',
    dependsOn: ['gl-02', 'eng-01'],
  },
  {
    id: 'gl-04',
    title: 'Enemy AI',
    division: 'div-game',
    file: 'src/game/ai.ts',
    dependsOn: ['gl-02'],
  },
  {
    id: 'gl-05',
    title: 'Combat resolver',
    division: 'div-game',
    file: 'src/game/combat.ts',
    dependsOn: ['gl-02'],
  },
  {
    id: 'gl-06',
    title: 'Level generator',
    division: 'div-game',
    file: 'src/game/levels.ts',
    dependsOn: ['gl-01', 'as-01'],
  },
  {
    id: 'gl-07',
    title: 'Loot & inventory',
    division: 'div-game',
    file: 'src/game/inventory.ts',
    dependsOn: ['gl-01'],
  },
  {
    id: 'gl-08',
    title: 'Quest system',
    division: 'div-game',
    file: 'src/game/quests.ts',
    dependsOn: ['gl-01'],
  },
  {
    id: 'gl-09',
    title: 'Save / load',
    division: 'div-game',
    file: 'src/game/save.ts',
    dependsOn: ['gl-01'],
  },
  {
    id: 'gl-10',
    title: 'Difficulty tuning',
    division: 'div-game',
    file: 'src/game/difficulty.ts',
    dependsOn: ['gl-05'],
  },
  {
    id: 'gl-11',
    title: 'Combat audio cues',
    division: 'div-game',
    file: 'src/game/cues.ts',
    dependsOn: ['gl-05', 'au-01'],
  },
  // UI/UX — 10
  {
    id: 'ui-01',
    title: 'HUD frame',
    division: 'div-ui',
    file: 'src/ui/hud.tsx',
    dependsOn: ['gl-01'],
  },
  {
    id: 'ui-02',
    title: 'Health & stamina bars',
    division: 'div-ui',
    file: 'src/ui/bars.tsx',
    dependsOn: ['ui-01'],
  },
  {
    id: 'ui-03',
    title: 'Minimap',
    division: 'div-ui',
    file: 'src/ui/minimap.tsx',
    dependsOn: ['ui-01', 'eng-01'],
  },
  { id: 'ui-04', title: 'Start menu', division: 'div-ui', file: 'src/ui/menu.tsx', dependsOn: [] },
  {
    id: 'ui-05',
    title: 'Settings panel',
    division: 'div-ui',
    file: 'src/ui/settings.tsx',
    dependsOn: ['ui-04'],
  },
  {
    id: 'ui-06',
    title: 'Inventory screen',
    division: 'div-ui',
    file: 'src/ui/inventory.tsx',
    dependsOn: ['gl-01'],
  },
  {
    id: 'ui-07',
    title: 'Dialogue boxes',
    division: 'div-ui',
    file: 'src/ui/dialogue.tsx',
    dependsOn: [],
  },
  {
    id: 'ui-08',
    title: 'Damage numbers',
    division: 'div-ui',
    file: 'src/ui/damage.tsx',
    dependsOn: ['ui-01'],
  },
  {
    id: 'ui-09',
    title: 'Pause overlay',
    division: 'div-ui',
    file: 'src/ui/pause.tsx',
    dependsOn: ['ui-04'],
  },
  {
    id: 'ui-10',
    title: 'Loading screens',
    division: 'div-ui',
    file: 'src/ui/loading.tsx',
    dependsOn: [],
  },
  // Audio — 8
  {
    id: 'au-01',
    title: 'Audio bus',
    division: 'div-audio',
    file: 'src/audio/bus.ts',
    dependsOn: [],
  },
  {
    id: 'au-02',
    title: 'Music director',
    division: 'div-audio',
    file: 'src/audio/music.ts',
    dependsOn: ['au-01'],
  },
  {
    id: 'au-03',
    title: 'Combat SFX',
    division: 'div-audio',
    file: 'src/audio/sfx-combat.ts',
    dependsOn: ['au-01'],
  },
  {
    id: 'au-04',
    title: 'Ambience beds',
    division: 'div-audio',
    file: 'src/audio/ambience.ts',
    dependsOn: ['au-01'],
  },
  {
    id: 'au-05',
    title: 'Spatial mixer',
    division: 'div-audio',
    file: 'src/audio/spatial.ts',
    dependsOn: ['au-01'],
  },
  {
    id: 'au-06',
    title: 'UI sounds',
    division: 'div-audio',
    file: 'src/audio/sfx-ui.ts',
    dependsOn: ['au-01'],
  },
  {
    id: 'au-07',
    title: 'Footsteps & foley',
    division: 'div-audio',
    file: 'src/audio/foley.ts',
    dependsOn: ['au-05'],
  },
  {
    id: 'au-08',
    title: 'Ducking & mix rules',
    division: 'div-audio',
    file: 'src/audio/mix.ts',
    dependsOn: ['au-02'],
  },
  // Assets — 8
  {
    id: 'as-01',
    title: 'Asset manifest',
    division: 'div-assets',
    file: 'assets/manifest.ts',
    dependsOn: [],
  },
  {
    id: 'as-02',
    title: 'Hero model set',
    division: 'div-assets',
    file: 'assets/models-hero.ts',
    dependsOn: ['as-01'],
  },
  {
    id: 'as-03',
    title: 'Enemy model set',
    division: 'div-assets',
    file: 'assets/models-enemies.ts',
    dependsOn: ['as-01'],
  },
  {
    id: 'as-04',
    title: 'Dungeon tileset',
    division: 'div-assets',
    file: 'assets/tileset.ts',
    dependsOn: ['as-01'],
  },
  {
    id: 'as-05',
    title: 'Texture atlas',
    division: 'div-assets',
    file: 'assets/textures.ts',
    dependsOn: ['as-01'],
  },
  {
    id: 'as-06',
    title: 'Material library',
    division: 'div-assets',
    file: 'assets/materials.ts',
    dependsOn: ['as-05'],
  },
  {
    id: 'as-07',
    title: 'Props & pickups',
    division: 'div-assets',
    file: 'assets/props.ts',
    dependsOn: ['as-04'],
  },
  {
    id: 'as-08',
    title: 'VFX sprites',
    division: 'div-assets',
    file: 'assets/vfx.ts',
    dependsOn: ['as-05'],
  },
];

/**
 * Dispatch order — a hand-topo-sorted interleave across divisions so several
 * divisions are visibly in flight at once (what a real DAG scheduler yields).
 */
const DISPATCH_ORDER: readonly string[] = [
  'as-01',
  'eng-02',
  'gl-01',
  'au-01',
  'ui-04',
  'eng-01',
  'as-05',
  'gl-02',
  'au-02',
  'ui-10',
  'eng-06',
  'as-04',
  'ui-01',
  'au-03',
  'eng-05',
  'gl-07',
  'as-02',
  'ui-05',
  'au-05',
  'eng-03',
  'gl-05',
  'as-03',
  'ui-02',
  'au-06',
  'eng-10',
  'gl-03',
  'as-06',
  'ui-06',
  'au-04',
  'eng-08',
  'gl-04',
  'as-07',
  'ui-03',
  'au-07',
  'eng-07',
  'gl-06',
  'as-08',
  'ui-07',
  'au-08',
  'eng-09',
  'gl-08',
  'ui-08',
  'eng-11',
  'gl-09',
  'ui-09',
  'gl-10',
  'gl-11',
  'eng-04',
];

/** Cross-division dependency count (the integration-layer health metric). */
const CROSS_DIVISION_EDGES = 7;

// ---------------------------------------------------------------------------
// Script builder
// ---------------------------------------------------------------------------

interface NodeDraft {
  id: string;
  role: OrgNodeView['role'];
  name: string;
  parentId?: string;
  state: OrgNodeView['state'];
}

/** Mutable working model the builder snapshots from. */
class ScriptBuilder {
  readonly events: TimedCoordinationEvent[] = [];
  private readonly nodes: NodeDraft[] = [];
  private modules: ModuleRegionView[] | undefined;
  private interfaces: InterfaceSeamView[] | undefined;
  private readonly itemOrder: string[] = [];
  private readonly itemState = new Map<string, ChecklistItemState>();

  push(at: number, event: CoordinationEvent): void {
    this.events.push({ at, event });
  }

  node(draft: NodeDraft): void {
    const existing = this.nodes.find((n) => n.id === draft.id);
    if (existing) Object.assign(existing, draft);
    else this.nodes.push(draft);
  }

  setNodeState(id: string, state: OrgNodeView['state']): void {
    const n = this.nodes.find((x) => x.id === id);
    if (n) n.state = state;
  }

  hasNode(id: string): boolean {
    return this.nodes.some((n) => n.id === id);
  }

  setModules(modules: ModuleRegionView[], interfaces?: InterfaceSeamView[]): void {
    this.modules = modules;
    if (interfaces) this.interfaces = interfaces;
  }

  chart(at: number): void {
    const view: OrgChartView = {
      taskId: MOCK_TASK_ID,
      nodes: this.nodes.map((n) => ({
        id: n.id,
        role: n.role,
        name: n.name,
        parentId: n.parentId,
        state: n.state,
      })),
      edges: this.nodes
        .filter((n) => n.parentId !== undefined)
        .map((n) => ({ from: n.parentId as string, to: n.id })),
      modules: this.modules,
      interfaces: this.interfaces,
    };
    this.push(at, { type: 'org-chart', chart: view });
  }

  addChecklistItems(ids: readonly string[]): void {
    for (const id of ids) {
      if (!this.itemState.has(id)) {
        this.itemOrder.push(id);
        this.itemState.set(id, 'queued');
      }
    }
  }

  setItem(id: string, state: ChecklistItemState): void {
    if (this.itemState.has(id)) this.itemState.set(id, state);
  }

  doneCount(): number {
    let done = 0;
    for (const state of this.itemState.values()) if (state === 'done') done += 1;
    return done;
  }

  checklist(at: number): void {
    const byId = new Map(CONTRACTS.map((c) => [c.id, c]));
    const items: ChecklistItem[] = this.itemOrder.map((id) => {
      const c = byId.get(id) as MockContract;
      const division = DIVISIONS.find((d) => d.id === c.division);
      return {
        id: c.id,
        label: c.title,
        group: division?.name,
        state: this.itemState.get(id) ?? 'queued',
        dependsOn: c.dependsOn.length > 0 ? c.dependsOn : undefined,
      };
    });
    this.push(at, { type: 'checklist', items });
  }

  activity(at: number, activity: Omit<Activity, 'timestamp'>): void {
    // Timestamps are stamped by the player at emit time (0 = "stamp me").
    this.push(at, { type: 'activity', activity: { ...activity, timestamp: 0 } });
  }

  eta(
    at: number,
    lowMinutes: number,
    highMinutes: number,
    confidence: 'low' | 'medium' | 'high',
  ): void {
    this.push(at, { type: 'eta', eta: { lowMinutes, highMinutes, confidence } });
  }

  status(
    at: number,
    status: 'starting' | 'planning' | 'working' | 'reviewing',
    detail?: string,
  ): void {
    this.push(at, { type: 'status', status, detail });
  }
}

function divisionOf(contractId: string): MockDivision {
  const c = CONTRACTS.find((x) => x.id === contractId) as MockContract;
  return DIVISIONS.find((d) => d.id === c.division) as MockDivision;
}

/**
 * Build the full scripted run. Deterministic and pure — the same array every
 * call — so tests can fold it without timers and the player just schedules it.
 */
export function buildMockCorpRunScript(): readonly TimedCoordinationEvent[] {
  const b = new ScriptBuilder();

  // -- Phase A: solo agent, then promotion -------------------------------- --
  b.status(0, 'starting', 'Reading the request');
  b.node({ id: 'root', role: 'solo', name: 'Pi', state: 'working' });
  b.chart(250);
  b.activity(950, {
    nodeId: 'root',
    kind: 'note',
    summary: 'Scoping: a full 3D dungeon crawler — too big for one pair of hands',
  });
  b.activity(2000, {
    nodeId: 'root',
    kind: 'note',
    summary: 'Bringing in a team and splitting the build',
  });
  // Promotion: the SAME agent gets a new hat — the id and name stay, the role
  // flips, and the surface crossfades the caption (Working solo → Lead).
  b.node({ id: 'root', role: 'ceo', name: 'Pi', state: 'working' });
  b.chart(2500);
  b.status(2550, 'planning', 'Forming a plan');
  b.node({ id: 'mgr', role: 'manager', name: 'Build plan', parentId: 'root', state: 'working' });
  b.chart(2950);
  b.activity(3350, {
    nodeId: 'root',
    kind: 'message',
    summary: 'Vision: a moody 3D dungeon crawler with tight real-time combat',
  });

  // -- Phase B: the shared project layout ----------------------------------- --
  // HONEST lighting: the vision is formed, so the lead's turn is OVER — the
  // room lights the layout specialist (the one actually running) and only it.
  b.setNodeState('root', 'idle');
  b.setNodeState('mgr', 'idle');
  b.node({
    id: 'arch',
    role: 'specialist',
    name: 'Project layout',
    parentId: 'mgr',
    state: 'working',
  });
  b.chart(3900);
  b.activity(4100, { nodeId: 'arch', kind: 'note', summary: 'Sketching the project structure' });
  // A short research pass — the activity panel's first slide-in (browse).
  b.push(4700, {
    type: 'exercise',
    session: {
      id: 'ex-browse',
      kind: 'browse',
      status: 'running',
      title: 'Researching the approach',
      detail: 'three.js scene graphs · dungeon lighting references',
      nodeId: 'arch',
    },
  });
  b.eta(5000, 25, 55, 'low');
  const regions: ModuleRegionView[] = DIVISIONS.map((d) => ({
    path: d.region,
    owner: d.name,
    purpose: d.purpose,
  }));
  b.setModules(regions.slice(0, 2));
  b.chart(5100);
  b.setModules(regions.slice(0, 4));
  b.chart(5700);
  b.setModules(regions.slice(), INTERFACES.slice());
  b.chart(6300);
  b.activity(6400, {
    nodeId: 'arch',
    kind: 'note',
    summary: '5 areas, 4 shared touch points — GameState, RendererAPI, AudioBus, AssetManifest',
  });
  b.setNodeState('arch', 'done');
  b.status(6800, 'planning', 'Dividing up the work');
  for (const [i, d] of DIVISIONS.entries()) {
    b.node({ id: d.id, role: 'division', name: d.name, parentId: 'mgr', state: 'idle' });
    if (i === 1 || i === 3 || i === 4) b.chart(6900 + i * 250);
  }
  b.push(7950, {
    type: 'exercise',
    session: {
      id: 'ex-browse',
      kind: 'browse',
      status: 'ended',
      title: 'Researching the approach',
      detail: 'Notes folded into the project layout',
      nodeId: 'arch',
    },
  });

  // -- Phase C: each area breaks its work into tasks ------------------------ --
  const crossCounts: Record<string, number> = {
    'div-engine': 1,
    'div-game': 3,
    'div-ui': 3,
    'div-audio': 0,
    'div-assets': 0,
  };
  for (const [i, d] of DIVISIONS.entries()) {
    const t0 = 8000 + i * 1350;
    b.setNodeState(d.id, 'working');
    b.chart(t0);
    b.activity(t0 + 100, {
      nodeId: d.id,
      kind: 'message',
      summary: 'Breaking the area into tasks',
    });
    const ids = CONTRACTS.filter((c) => c.division === d.id).map((c) => c.id);
    b.addChecklistItems(ids);
    b.checklist(t0 + 950);
    const cross = crossCounts[d.id];
    b.activity(t0 + 1000, {
      nodeId: d.id,
      kind: 'note',
      summary: `${ids.length} tasks queued${cross ? ` — ${cross} wait on other areas` : ''}`,
    });
    b.setNodeState(d.id, 'idle');
  }
  // The planner's own turn: sequencing the queue before dispatch rolls.
  b.setNodeState('mgr', 'working');
  b.chart(14900);
  b.activity(15300, {
    nodeId: 'mgr',
    kind: 'note',
    summary: `Plan ready — 48 tasks across 5 areas (${CROSS_DIVISION_EDGES} hand-offs between areas)`,
  });
  b.eta(15400, 22, 40, 'medium');
  b.status(15650, 'working', 'Building it');
  // Dispatch takes over — the planner's turn ends (next chart broadcasts it).
  b.setNodeState('mgr', 'idle');

  // -- Phase D: dispatch — files land, checklist fills, ETA narrows -------- --
  // Contracts OVERLAP in time (3–5 in flight at once, like a real DAG
  // scheduler), so the per-contract transitions are collected as timed actions
  // first, sorted chronologically, and only then applied to the builder — the
  // event array must evolve in true time order for the player to replay it.
  const dispatchStart = 16000;
  const stagger = 540;
  const engineerCursor = new Map<string, number>(); // division id → next slot

  const etaByCompletion = new Map<number, [number, number, 'medium' | 'high']>([
    [6, [18, 30, 'medium']],
    [12, [15, 24, 'medium']],
    [18, [12, 19, 'medium']],
    [24, [9, 14, 'high']],
    [30, [7, 11, 'high']],
    [36, [4, 7, 'high']],
    [42, [2, 4, 'high']],
    [46, [1, 2, 'high']],
  ]);
  const buildsByCompletion = new Map<number, [string, string]>([
    [14, ['build-v01', 'Playable build v0.1 — engine boots into an empty dungeon']],
    [28, ['build-v02', 'Playable build v0.2 — combat loop online']],
    [40, ['build-v03', 'Playable build v0.3 — full loop with audio']],
  ]);
  const consults: Record<string, string> = {
    'ui-01': 'Asked for a second pair of eyes on HUD contrast',
    'gl-05': 'Compared notes on the damage formulas with a peer',
    'au-05': 'Had the spatial mixer profiled for performance',
  };

  interface TimedAction {
    at: number;
    seq: number;
    run: (at: number) => void;
  }
  const actions: TimedAction[] = [];
  let seq = 0;
  const schedule = (at: number, run: (at: number) => void): void => {
    actions.push({ at, seq: seq++, run });
  };

  // Deterministic per-contract line deltas (the live +N/−N readout material).
  const deltasFor = (i: number): { added: number; removed: number } => ({
    added: 64 + ((i * 53) % 220),
    removed: i % 3 === 0 ? (i * 17) % 26 : 0,
  });

  for (const [i, contractId] of DISPATCH_ORDER.entries()) {
    const start = dispatchStart + i * stagger;
    const duration = 1300 + ((i * 7) % 5) * 260;
    const division = divisionOf(contractId);
    const contract = CONTRACTS.find((c) => c.id === contractId) as MockContract;
    const { added, removed } = deltasFor(i);
    const addedMid = Math.floor(added * 0.62);
    const removedMid = Math.floor(removed * 0.5);

    // Assign a builder slot (round-robin over 3 per area); the node pops into
    // the chart the first time its slot is used — the tree keeps growing
    // through the build, exactly when a worker is actually spun up.
    const slot = (engineerCursor.get(division.id) ?? 0) % 3;
    engineerCursor.set(division.id, slot + 1);
    const engineerId = `${division.id}-e${slot + 1}`;

    schedule(start, (at) => {
      if (!b.hasNode(engineerId)) {
        b.node({
          id: engineerId,
          role: 'engineer',
          name: `${division.name} builder ${slot + 1}`,
          parentId: division.id,
          state: 'idle',
        });
      }
      b.setItem(contractId, 'in-progress');
      // HONEST: only the BUILDER actually running lights up — the area card
      // derives its collective glow from its working crew in the renderer,
      // exactly as it does for a real engine's running-only statuses.
      b.setNodeState(engineerId, 'working');
      b.checklist(at);
      b.chart(at + 20);
      // The file lights up the moment work on it begins (phase start).
      b.activity(at + 40, {
        nodeId: engineerId,
        kind: 'file-touch',
        summary: `started ${contract.file}`,
        path: contract.file,
        phase: 'start',
      });
    });

    const consult = consults[contractId];
    if (consult) {
      schedule(start + Math.round(duration * 0.45), (at) => {
        b.activity(at, { nodeId: division.id, kind: 'consult', summary: consult });
      });
    }

    // Mid-write chunk: live +N/−N deltas while the file is still hot.
    schedule(start + Math.round(duration * 0.55), (at) => {
      b.activity(at, {
        nodeId: engineerId,
        kind: 'file-touch',
        summary: `writing ${contract.file}`,
        path: contract.file,
        phase: 'progress',
        linesAdded: addedMid,
        linesRemoved: removedMid,
      });
    });

    schedule(start + duration - 420, (at) => {
      b.activity(at, {
        nodeId: engineerId,
        kind: 'file-touch',
        summary: `finished ${contract.file}`,
        path: contract.file,
        phase: 'end',
        linesAdded: added - addedMid,
        linesRemoved: removed - removedMid,
      });
      b.setItem(contractId, 'in-review');
      b.checklist(at + 100);
    });

    schedule(start + duration, (at) => {
      b.setItem(contractId, 'done');
      b.setNodeState(engineerId, 'idle');
      b.checklist(at);
      b.chart(at + 20);

      const completions = b.doneCount();
      const eta = etaByCompletion.get(completions);
      if (eta) b.eta(at + 60, eta[0], eta[1], eta[2]);
      const build = buildsByCompletion.get(completions);
      if (build) {
        b.push(at + 160, {
          type: 'artifact',
          artifact: {
            id: build[0],
            title: build[1],
            kind: 'html',
            path: 'build/index.html',
            nodeId: 'mgr',
            timestamp: 0,
          },
        });
      }
    });
  }

  // Mid-build test pass — the activity panel slides in while the corp
  // exercises its own work (spec §11: a headline moment, not a log line).
  schedule(30_500, (at) => {
    b.push(at, {
      type: 'exercise',
      session: {
        id: 'ex-test',
        kind: 'test',
        status: 'running',
        title: 'Running the test suite',
        detail: 'engine · game logic · UI',
        nodeId: 'mgr',
      },
    });
    b.activity(at + 60, { nodeId: 'mgr', kind: 'note', summary: 'Kicking off a full test pass' });
  });
  schedule(36_800, (at) => {
    b.push(at, {
      type: 'exercise',
      session: {
        id: 'ex-test',
        kind: 'test',
        status: 'passed',
        title: 'Running the test suite',
        detail: '214 checks · all green',
        nodeId: 'mgr',
      },
    });
    b.activity(at + 80, {
      nodeId: 'mgr',
      kind: 'note',
      summary: 'Tests green — 214 checks passed',
    });
  });

  actions.sort((x, y) => x.at - y.at || x.seq - y.seq);
  for (const action of actions) action.run(action.at);

  const lastStart = dispatchStart + (DISPATCH_ORDER.length - 1) * stagger;
  const dispatchEnd = lastStart + 2400;

  // -- Phase E: the work gets checked, then shipped -------------------------- --
  b.status(dispatchEnd + 200, 'reviewing', 'Checking the work');
  // The lead steps back in for review — ITS turn, so it lights again.
  b.setNodeState('root', 'working');
  b.activity(dispatchEnd + 350, {
    nodeId: 'root',
    kind: 'note',
    summary: 'Reviewing the finished build against the vision',
  });
  // The headline moment: the corp PLAYS its own build while the user watches.
  b.push(dispatchEnd + 450, {
    type: 'exercise',
    session: {
      id: 'ex-play',
      kind: 'run',
      status: 'running',
      title: 'Playing the build',
      detail: 'checking the full game loop',
      nodeId: 'root',
    },
  });
  for (const [i, d] of DIVISIONS.entries()) {
    b.setNodeState(d.id, 'done');
    for (let s = 1; s <= 3; s += 1) {
      if (b.hasNode(`${d.id}-e${s}`)) b.setNodeState(`${d.id}-e${s}`, 'done');
    }
    b.chart(dispatchEnd + 500 + i * 220);
  }
  b.setNodeState('mgr', 'done');
  b.chart(dispatchEnd + 1700);
  b.activity(dispatchEnd + 2400, {
    nodeId: 'root',
    kind: 'note',
    summary: 'Combat, audio and saves hold up — the loop feels right',
  });
  b.push(dispatchEnd + 8300, {
    type: 'exercise',
    session: {
      id: 'ex-play',
      kind: 'run',
      status: 'passed',
      title: 'Playing the build',
      detail: 'Full loop verified — combat · audio · save/load',
      nodeId: 'root',
    },
  });
  b.activity(dispatchEnd + 8500, {
    nodeId: 'root',
    kind: 'message',
    summary: 'Final check passed — shipping it',
  });
  b.setNodeState('root', 'done');
  b.chart(dispatchEnd + 8700);
  b.push(dispatchEnd + 9000, {
    type: 'done',
    result: {
      outcome: 'completed',
      summary: '3D dungeon crawler ready — 48 tasks finished across 5 areas.',
      artifacts: [
        {
          id: 'build-final',
          title: 'Final build — the 3D dungeon crawler',
          kind: 'html',
          path: 'build/index.html',
          timestamp: 0,
        },
      ],
    },
  });

  return b.events;
}

/** Total scripted duration (ms) — the `at` of the terminal event. */
export function mockRunDurationMs(script: readonly TimedCoordinationEvent[]): number {
  return script.at(-1)?.at ?? 0;
}

// ---------------------------------------------------------------------------
// Player — a TaskHandle-shaped live replay
// ---------------------------------------------------------------------------

export interface MockRunOptions {
  /** Clock multiplier: 2 plays the ~47s script in ~23s. Default 1. */
  readonly speed?: number;
  /**
   * Fast-forward: events scheduled before this point (script ms) are emitted
   * synchronously on start, then the tail plays live. Lets a dev/demo jump to
   * "mid-dispatch" without waiting.
   */
  readonly startAt?: number;
}

export interface MockRunHandle {
  readonly taskId: string;
  /** Ordered event stream — the same contract as `TaskHandle.events`. */
  readonly events: AsyncIterable<CoordinationEvent>;
  /** Stop the replay (the stream ends without a further terminal event). */
  stop(): void;
}

/** Single-producer/single-consumer buffer (same shape the solo engine uses). */
class PushStream<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Stamp "now" into the timestamped payloads as they are emitted live. */
function stamped(event: CoordinationEvent, now: number): CoordinationEvent {
  if (event.type === 'activity') {
    return { ...event, activity: { ...event.activity, timestamp: now } };
  }
  if (event.type === 'artifact') {
    return { ...event, artifact: { ...event.artifact, timestamp: now } };
  }
  if (event.type === 'done' && event.result.artifacts) {
    return {
      ...event,
      result: {
        ...event.result,
        artifacts: event.result.artifacts.map((a) => ({ ...a, timestamp: now })),
      },
    };
  }
  return event;
}

/**
 * Start a live replay of the scripted corp run. Returns a TaskHandle-shaped
 * object so the surface subscribes to the mock EXACTLY as it would to a real
 * {@link CoordinationEngine} handle.
 */
export function startMockCorpRun(options: MockRunOptions = {}): MockRunHandle {
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const script = buildMockCorpRunScript();
  // Clamp so an over-long fast-forward still back-dates sensibly.
  const startAt = Math.min(options.startAt ?? 0, mockRunDurationMs(script) + 1);
  const stream = new PushStream<CoordinationEvent>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let index = 0;

  // Fast-forward the prefix synchronously, back-dating timestamps so recency
  // effects (file-land flashes) don't all fire at once on a jump-started demo.
  const wall = Date.now();
  for (;;) {
    const entry = script[index];
    if (!entry || entry.at > startAt) break;
    stream.push(stamped(entry.event, wall - Math.round((startAt - entry.at) / speed)));
    index += 1;
  }

  const scheduleNext = (): void => {
    const entry = script[index];
    if (!entry) {
      stream.end();
      return;
    }
    const delay = Math.max(0, Math.round((entry.at - startAt) / speed) - (Date.now() - wall));
    timer = setTimeout(() => {
      // Emit everything due at (or before) this tick in order.
      const elapsed = startAt + (Date.now() - wall) * speed;
      for (;;) {
        const due = script[index];
        if (!due || due.at > elapsed) break;
        stream.push(stamped(due.event, Date.now()));
        index += 1;
      }
      scheduleNext();
    }, delay);
  };
  scheduleNext();

  return {
    taskId: MOCK_TASK_ID,
    events: stream,
    stop: () => {
      if (timer !== undefined) clearTimeout(timer);
      stream.end();
    },
  };
}

/**
 * The stubbed "peek" target: a small self-contained HTML snapshot page for the
 * current best artifact. The real engine will hand back a real playable build;
 * the demo needs the button to open something that looks intentional.
 */
export function mockPeekHtml(title: string, note?: string): string {
  const sub = note ?? 'Snapshot of the current best build — assembled from the merged contracts.';
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Build snapshot</title>',
    '<style>',
    'body{margin:0;font:14px/1.5 ui-sans-serif,system-ui;background:#141210;color:#ece9e2;',
    'display:grid;place-items:center;min-height:100vh}',
    '.card{max-width:440px;padding:32px;text-align:center}',
    'h1{font-size:17px;margin:0 0 8px;font-weight:600}',
    'p{color:#9a978f;margin:0 0 20px}',
    '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#d97757;',
    'margin-right:8px;vertical-align:1px}',
    '</style></head><body><div class="card">',
    `<h1><span class="dot"></span>${title}</h1>`,
    `<p>${sub}</p>`,
    '</div></body></html>',
  ].join('\n');
}
