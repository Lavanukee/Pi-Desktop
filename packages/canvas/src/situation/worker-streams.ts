/**
 * Per-worker live streams for the situation room's click-through (spec §11):
 * clicking a node in the tree routes THAT worker's stream into the left chat
 * area, rendered like a normal thread — except the leading "user message" is
 * the worker's TASK BRIEFING, a distinctly stylized bubble.
 *
 * This module is the mock provider: deterministic, per-node scripted streams
 * shaped exactly like what a real engine bridge will surface (messages +
 * tool/thinking steps with timings). Pure data + pure builders — no React, no
 * timers — so the pane can replay them at any speed and tests can fold them.
 */

import type { OrgNodeView } from '@pi-desktop/coordination';
import type { ActivityStepData } from '@pi-desktop/ui';

/**
 * The stylized leading bubble: what this worker was ASKED to do. Rendered as a
 * task briefing (eyebrow + title + goal + deliverables), visibly distinct from
 * a normal user input.
 */
export interface WorkerBriefing {
  readonly workerName: string;
  /** Plain-language role line ("Builder · Game Logic"). */
  readonly roleLine: string;
  /** The task headline ("Build the combat resolver"). */
  readonly title: string;
  /** Owned path/area, when the worker has one ("src/game/"). */
  readonly area?: string;
  readonly goal: string;
  readonly deliverables: readonly string[];
}

/** One item of a worker's stream, revealed at `at` ms into the replay. */
export type WorkerStreamEntry =
  | { readonly at: number; readonly kind: 'message'; readonly text: string }
  | { readonly at: number; readonly kind: 'step'; readonly step: ActivityStepData };

export interface WorkerStream {
  readonly nodeId: string;
  readonly briefing: WorkerBriefing;
  /** Ordered entries; `at` offsets are ms from the moment the pane opens. */
  readonly entries: readonly WorkerStreamEntry[];
}

/** Small deterministic hash — variety between workers, stable across runs. */
function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 9973;
  return h;
}

interface AreaScript {
  readonly area: string;
  readonly sharedRead: { file: string; label: string };
  readonly tasks: readonly { file: string; title: string; note: string }[];
  readonly check: string;
}

/** Per-area material the builder streams draw from (mirrors the mock run). */
const AREA_SCRIPTS: Record<string, AreaScript> = {
  'Core Engine': {
    area: 'src/engine/',
    sharedRead: { file: 'assets/manifest.ts', label: 'the asset manifest' },
    tasks: [
      {
        file: 'src/engine/renderer.ts',
        title: 'the renderer core',
        note: 'forward pass first, bloom later',
      },
      {
        file: 'src/engine/lighting.ts',
        title: 'the lighting pipeline',
        note: 'torchlight needs a warm falloff',
      },
      {
        file: 'src/engine/collision.ts',
        title: 'the collision system',
        note: 'swept AABB is enough for the dungeon',
      },
    ],
    check: 'pnpm test engine',
  },
  'Game Logic': {
    area: 'src/game/',
    sharedRead: { file: 'src/engine/renderer.ts', label: 'the RendererAPI touch point' },
    tasks: [
      {
        file: 'src/game/combat.ts',
        title: 'the combat resolver',
        note: 'damage windows keyed to animation frames',
      },
      {
        file: 'src/game/ai.ts',
        title: 'the enemy AI',
        note: 'simple state machine — patrol, chase, strike',
      },
      {
        file: 'src/game/levels.ts',
        title: 'the level generator',
        note: 'rooms-and-corridors with a seeded RNG',
      },
    ],
    check: 'pnpm test game',
  },
  'UI/UX': {
    area: 'src/ui/',
    sharedRead: { file: 'src/game/state.ts', label: 'the GameState touch point' },
    tasks: [
      {
        file: 'src/ui/hud.tsx',
        title: 'the HUD frame',
        note: 'health left, stamina right, minimal chrome',
      },
      {
        file: 'src/ui/minimap.tsx',
        title: 'the minimap',
        note: 'explored-room fog with a soft reveal',
      },
      { file: 'src/ui/menu.tsx', title: 'the start menu', note: 'moody, torch-lit backdrop' },
    ],
    check: 'pnpm test ui',
  },
  Audio: {
    area: 'src/audio/',
    sharedRead: { file: 'src/game/state.ts', label: 'the GameState touch point' },
    tasks: [
      {
        file: 'src/audio/spatial.ts',
        title: 'the spatial mixer',
        note: 'distance rolloff tuned to corridor scale',
      },
      {
        file: 'src/audio/music.ts',
        title: 'the music director',
        note: 'combat layer ducks the ambience bed',
      },
      {
        file: 'src/audio/foley.ts',
        title: 'footsteps & foley',
        note: 'surface-aware steps — stone vs. grate',
      },
    ],
    check: 'pnpm test audio',
  },
  Assets: {
    area: 'assets/',
    sharedRead: { file: 'assets/manifest.ts', label: 'the asset manifest' },
    tasks: [
      {
        file: 'assets/tileset.ts',
        title: 'the dungeon tileset',
        note: 'modular walls with corner variants',
      },
      {
        file: 'assets/models-enemies.ts',
        title: 'the enemy model set',
        note: 'three silhouettes, one rig',
      },
      {
        file: 'assets/materials.ts',
        title: 'the material library',
        note: 'wet-stone roughness as the signature look',
      },
    ],
    check: 'pnpm test assets',
  },
};

const FALLBACK_SCRIPT: AreaScript = {
  area: 'src/',
  sharedRead: { file: 'src/game/state.ts', label: 'the shared state' },
  tasks: [
    { file: 'src/game/state.ts', title: 'its piece of the build', note: 'keeping the seams typed' },
  ],
  check: 'pnpm test',
};

/** The area an engineer/division node belongs to, from its display name. */
function areaOf(node: Pick<OrgNodeView, 'name'>): { name: string; script: AreaScript } {
  for (const [name, script] of Object.entries(AREA_SCRIPTS)) {
    if (node.name.startsWith(name)) return { name, script };
  }
  return { name: node.name, script: FALLBACK_SCRIPT };
}

function builderStream(node: Pick<OrgNodeView, 'id' | 'name'>): WorkerStream {
  const { name: areaName, script } = areaOf(node);
  const seed = seedOf(node.id);
  const task = script.tasks[seed % script.tasks.length] as AreaScript['tasks'][number];
  const added = 84 + (seed % 140);
  const removed = seed % 4 === 0 ? seed % 18 : 0;
  return {
    nodeId: node.id,
    briefing: {
      workerName: node.name,
      roleLine: `Builder · ${areaName}`,
      title: `Build ${task.title}`,
      area: script.area,
      goal: `Write ${task.file} so the ${areaName} area's piece of the game works end to end. Keep to the shared touch points — nothing outside ${script.area} gets edited.`,
      deliverables: [task.file, `passes ${script.check}`, 'shared touch points unchanged'],
    },
    entries: [
      {
        at: 400,
        kind: 'message',
        text: 'Picking it up. Reading the shared touch points first so my piece plugs in cleanly.',
      },
      {
        at: 1400,
        kind: 'step',
        step: {
          kind: 'read',
          label: 'Read a file',
          detail: script.sharedRead.file,
          filename: script.sharedRead.file,
        },
      },
      {
        at: 2900,
        kind: 'step',
        step: {
          kind: 'thinking',
          label: 'Thinking it through',
          thought: `${task.note}. The seam via ${script.sharedRead.label} stays as-is — I only consume it.`,
          durationMs: 4000 + (seed % 5) * 700,
        },
      },
      {
        at: 5200,
        kind: 'step',
        step: {
          kind: 'edit',
          label: 'Editing',
          detail: task.file,
          filename: task.file,
          added,
          deleted: removed,
        },
      },
      {
        at: 8200,
        kind: 'step',
        step: {
          kind: 'bash',
          label: 'Ran',
          detail: script.check,
          command: script.check,
          output: `✓ ${task.title} — ${12 + (seed % 9)} checks passed`,
        },
      },
      {
        at: 10_400,
        kind: 'message',
        text: `Done — ${task.file} is written and in review. ${task.note[0]?.toUpperCase()}${task.note.slice(1)}, and the touch points held.`,
      },
    ],
  };
}

function areaLeadStream(node: Pick<OrgNodeView, 'id' | 'name'>): WorkerStream {
  const { name: areaName, script } = areaOf(node);
  const seed = seedOf(node.id);
  const t = script.tasks;
  return {
    nodeId: node.id,
    briefing: {
      workerName: node.name,
      roleLine: 'Area lead',
      title: `Deliver the ${areaName} area`,
      area: script.area,
      goal: `Break ${script.area} into buildable tasks, keep the builders unblocked, and hold the area's shared touch points stable while the rest of the build leans on them.`,
      deliverables: [
        `${script.area} complete`,
        'tasks sequenced by dependency',
        'hand-offs honored',
      ],
    },
    entries: [
      {
        at: 400,
        kind: 'message',
        text: `Sequencing the ${areaName} tasks — dependencies first, polish last.`,
      },
      {
        at: 1600,
        kind: 'step',
        step: {
          kind: 'read',
          label: 'Read a file',
          detail: script.sharedRead.file,
          filename: script.sharedRead.file,
        },
      },
      {
        at: 3000,
        kind: 'step',
        step: {
          kind: 'thinking',
          label: 'Sequencing',
          thought: `${t[0]?.title} unblocks the rest; ${t[1] ? t[1].title : 'the follow-ups'} can run in parallel once it lands.`,
          durationMs: 3200 + (seed % 4) * 600,
        },
      },
      {
        at: 5400,
        kind: 'message',
        text: `Builders are on it — ${t.length} tracks running in parallel. I'm watching the hand-offs.`,
      },
      {
        at: 7200,
        kind: 'step',
        step: {
          kind: 'bash',
          label: 'Ran',
          detail: script.check,
          command: script.check,
          output: `✓ area checks green so far`,
        },
      },
      {
        at: 9400,
        kind: 'message',
        text: 'On track. Everything landing goes through review before it counts as done.',
      },
    ],
  };
}

function leadStream(node: Pick<OrgNodeView, 'id' | 'name'>): WorkerStream {
  return {
    nodeId: node.id,
    briefing: {
      workerName: node.name,
      roleLine: 'Lead',
      title: 'Deliver the 3D dungeon crawler',
      goal: 'Turn the request into a working game: form the plan, split the build into areas, keep the whole thing honest against the vision, and only ship when the loop actually plays well.',
      deliverables: [
        'a playable build',
        'every task reviewed before it counts',
        'the vision held end to end',
      ],
    },
    entries: [
      {
        at: 400,
        kind: 'message',
        text: 'Holding the vision: moody, tight, real-time. Every area maps back to that.',
      },
      {
        at: 1800,
        kind: 'step',
        step: {
          kind: 'thinking',
          label: 'Weighing the plan',
          thought:
            'Five areas, four shared touch points. The risk is the seams — combat feel depends on engine timing plus audio cues landing together.',
          durationMs: 5200,
        },
      },
      {
        at: 4200,
        kind: 'message',
        text: 'Plan approved. The build is running — I step back in at review, and I play the build myself before it ships.',
      },
      {
        at: 6600,
        kind: 'step',
        step: {
          kind: 'read',
          label: 'Read a file',
          detail: 'build/index.html',
          filename: 'build/index.html',
        },
      },
      {
        at: 8600,
        kind: 'message',
        text: 'Watching progress. Nothing ships on a green checklist alone — it ships when it plays right.',
      },
    ],
  };
}

function planStream(node: Pick<OrgNodeView, 'id' | 'name'>): WorkerStream {
  return {
    nodeId: node.id,
    briefing: {
      workerName: node.name,
      roleLine: 'Planning',
      title: 'Split the build and keep it moving',
      goal: 'Lay the project out into areas with clean hand-offs, queue every task in dependency order, and keep all five areas fed with work until the build is done.',
      deliverables: [
        '48 tasks queued across 5 areas',
        '7 hand-offs sequenced',
        'no area left starved',
      ],
    },
    entries: [
      {
        at: 400,
        kind: 'message',
        text: 'The layout gives each area one clean directory and typed touch points between them.',
      },
      {
        at: 1800,
        kind: 'step',
        step: {
          kind: 'thinking',
          label: 'Ordering the queue',
          thought:
            'Manifest and state land first — everything hangs off those. Cross-area waits go late in each track so nobody idles.',
          durationMs: 4600,
        },
      },
      {
        at: 4400,
        kind: 'message',
        text: '48 tasks queued. The 7 cross-area hand-offs are sequenced so no track stalls on another.',
      },
      {
        at: 6600,
        kind: 'step',
        step: {
          kind: 'bash',
          label: 'Ran',
          detail: 'task queue check',
          command: 'queue --verify',
          output: '✓ dependency order holds · 0 cycles',
        },
      },
      {
        at: 8800,
        kind: 'message',
        text: 'Dispatch is rolling. I rebalance the queue as tracks finish early.',
      },
    ],
  };
}

function layoutStream(node: Pick<OrgNodeView, 'id' | 'name'>): WorkerStream {
  return {
    nodeId: node.id,
    briefing: {
      workerName: node.name,
      roleLine: 'Structure',
      title: 'Lay out the project structure',
      goal: 'Decide the shape of the codebase before anyone writes into it: which areas own which directories, and the exact touch points where areas connect.',
      deliverables: [
        '5 areas, one directory each',
        '4 typed touch points',
        'no overlapping ownership',
      ],
    },
    entries: [
      {
        at: 400,
        kind: 'message',
        text: 'Structure first: five areas, each with one directory it fully owns.',
      },
      {
        at: 1800,
        kind: 'step',
        step: {
          kind: 'thinking',
          label: 'Drawing the seams',
          thought:
            'GameState, RendererAPI, AudioBus, AssetManifest — four touch points cover every cross-area need I can find in the vision.',
          durationMs: 5400,
        },
      },
      {
        at: 4600,
        kind: 'step',
        step: {
          kind: 'edit',
          label: 'Editing',
          detail: 'src/game/state.ts',
          filename: 'src/game/state.ts',
          added: 42,
          deleted: 0,
        },
      },
      {
        at: 7200,
        kind: 'message',
        text: 'Layout done — handing it to planning. Anything not in a touch point stays private to its area.',
      },
    ],
  };
}

/**
 * The mock per-worker stream for a node. Deterministic (same node → same
 * stream). Every role gets a plausible stream so any clicked node routes
 * something real into the left area.
 */
export function mockWorkerStreamFor(node: Pick<OrgNodeView, 'id' | 'name' | 'role'>): WorkerStream {
  switch (node.role) {
    case 'engineer':
      return builderStream(node);
    case 'division':
    case 'division-head':
      return areaLeadStream(node);
    case 'ceo':
    case 'solo':
      return leadStream(node);
    case 'manager':
      return planStream(node);
    case 'specialist':
      return layoutStream(node);
  }
}
