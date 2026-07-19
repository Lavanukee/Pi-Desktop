/**
 * Promotion — the solo→corporation seam (spec §2 "Scope" dial, §4 roles, §12
 * open question 1).
 *
 * A single worker runs solo until a task is too large for one focused pass. The
 * ONLY way it grows a corporation is by calling {@link CREATE_PRODUCTION_HIERARCHY}
 * — the model itself decides scope, the harness never guesses. This module ships
 * the three pure pieces that seam needs:
 *
 *  - {@link PROMOTION_SYSTEM_PROMPT} — the minimal system prompt that tells the
 *    solo worker when to just do the work vs. when to promote.
 *  - {@link CREATE_PRODUCTION_HIERARCHY_TOOL} — the OpenAI-compatible function
 *    schema the worker calls to promote, naming the divisions it would set up.
 *  - {@link applyCreateHierarchy} — the pure handler that turns that tool call
 *    into a fresh {@link OrgChart} (CEO + manager block + the proposed divisions).
 *
 * Slice-1 scope: promotion + the org-chart it produces only. Dispatch,
 * scheduling, execution, review, and merge are later slices — nothing here runs
 * a worker or mutates a live chart beyond building the initial structure.
 */

import { emptyOrgChart, type OrgChart, type OrgNode } from './org-chart.js';

/**
 * The minimal solo-worker system prompt (spec §2, §12.1). Deliberately tiny: it
 * establishes exactly one judgment — do it, or promote — and nothing about how
 * the corporation works (the worker doesn't need to know). NOT wired into the
 * live chat path in slice 1; used by the test driver and future dispatch.
 */
export const PROMOTION_SYSTEM_PROMPT = `You are a capable solo developer. If a task fits in a single focused pass, just do it. If it is too large or multi-part to do well in one pass, call create_production_hierarchy EXACTLY ONCE with the divisions you would set up (name + purpose) instead of attempting it all yourself. That single call creates the ENTIRE hierarchy and hands the work to the managers — so call it one time only. The moment you call create_production_hierarchy, you are finished — output nothing after the tool call, and never call it a second time (a repeat call creates nothing and only wastes the turn).`;

/** The tool name the worker calls to promote itself into a corporation. */
export const CREATE_PRODUCTION_HIERARCHY = 'create_production_hierarchy';

/** A minimal OpenAI-compatible function-tool schema shape (no `any`). */
export interface OpenAiFunctionTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the arguments object. */
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * The `create_production_hierarchy` tool (spec §2 Scope, §4). Passed to the solo
 * worker's turn with `tool_choice: 'auto'`; calling it IS the promotion signal.
 * The description makes the trigger explicit so the model calls it when — and
 * only when — scope demands (spec §12.1).
 */
export const CREATE_PRODUCTION_HIERARCHY_TOOL: OpenAiFunctionTool = {
  type: 'function',
  function: {
    name: CREATE_PRODUCTION_HIERARCHY,
    description:
      'Set up a production hierarchy (a small team of divisions) when the task is too large, too multi-part, or otherwise beyond what you can do well in a single focused pass. Call this ONCE, INSTEAD of attempting a large task yourself: name the divisions you would create and what each is for, and a manager block will turn each into concrete work. This call is ONE-SHOT and TERMINAL — the moment you call it the hierarchy is created and you are DONE: output nothing and call no tool after it. Calling it again does NOTHING (the hierarchy already exists) and just wastes the turn. Do NOT call it for a task you can finish well in one pass — just do that directly.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'Why this task needs a hierarchy rather than a single pass (what makes it too large or multi-part).',
        },
        divisions: {
          type: 'array',
          description:
            'The divisions to create — one per distinct area of the work. Prefer a few focused divisions over one catch-all.',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Short division name, e.g. "Frontend", "Storyline", "3D Assets".',
              },
              purpose: {
                type: 'string',
                description: 'What this division is responsible for producing.',
              },
            },
            required: ['name', 'purpose'],
          },
        },
      },
      required: ['reason', 'divisions'],
    },
  },
};

/** One proposed division from a {@link CREATE_PRODUCTION_HIERARCHY} call. */
export interface HierarchyDivisionSpec {
  readonly name: string;
  readonly purpose: string;
}

/** The validated arguments of a {@link CREATE_PRODUCTION_HIERARCHY} call. */
export interface CreateHierarchyArgs {
  readonly reason: string;
  readonly divisions: readonly HierarchyDivisionSpec[];
}

/**
 * Validate raw (JSON-decoded) tool-call arguments into {@link CreateHierarchyArgs},
 * or `undefined` if unusable. Tolerant of the small-model quirks that matter:
 * trims strings, drops division entries missing a name/purpose, and requires at
 * least one usable division (a promotion with no divisions is meaningless).
 */
export function parseCreateHierarchyArgs(raw: unknown): CreateHierarchyArgs | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  if (!Array.isArray(obj.divisions)) return undefined;
  const divisions: HierarchyDivisionSpec[] = [];
  for (const d of obj.divisions) {
    if (d === null || typeof d !== 'object') continue;
    const entry = d as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const purpose = typeof entry.purpose === 'string' ? entry.purpose.trim() : '';
    if (name === '' || purpose === '') continue;
    divisions.push({ name, purpose });
  }
  if (divisions.length === 0) return undefined;
  return { reason, divisions };
}

// --- Idempotent-terminal promotion guard (J5) --------------------------------
//
// LIVE DEFECT this fixes: the CEO/worker called `create_production_hierarchy`
// TWICE ("created multiple production hierarchies"), then thrashed ("I already
// called it twice, this seems wrong"). The cure mirrors the F1 `submit_contract`
// fix: the FIRST valid call RECORDS the hierarchy and is TERMINAL (the ack tells
// the model it is DONE — output nothing, call no tool after); every later call is
// an IDEMPOTENT DEAD-END that creates no second hierarchy/divisions and never
// passes control back. Two layers enforce this:
//   1. Prompt/description (above) + the `terminal` flag on the promotion custom
//      tool (run.ts) — the seam ends the turn after the first call.
//   2. This guard — the harness only ever acts on the FIRST valid call, so even a
//      model that emits the tool twice in one reply yields exactly ONE hierarchy.

/** The TERMINAL ack for the FIRST `create_production_hierarchy` call — the model
 * is done the instant the hierarchy exists (mirrors the F1 submit_contract ack). */
export const HIERARCHY_CREATED_ACK =
  'Hierarchy created — you are DONE. The manager block now authors the contracts; your job is over. Output nothing and call no tool after this.';

/** The IDEMPOTENT DEAD-END ack for a SECOND+ `create_production_hierarchy` call:
 * it created nothing (the hierarchy already exists) and does not pass control back. */
export const HIERARCHY_ALREADY_CREATED_ACK =
  'The production hierarchy already exists — this repeat call did nothing (no second hierarchy is created). You are DONE: output nothing and call no further tool.';

/** The outcome of feeding ONE `create_production_hierarchy` call to a guard. */
export interface PromotionCallResult {
  /** True ONLY for the first valid call — it recorded the hierarchy. */
  readonly created: boolean;
  /** The validated args of the recorded (first valid) call; undefined otherwise. */
  readonly args?: CreateHierarchyArgs;
  /** The terminal/dead-end ack to return to the model for THIS call. */
  readonly ack: string;
  /** True once a hierarchy has been recorded — any call from here on is a dead-end. */
  readonly done: boolean;
}

/** A stateful, idempotent-terminal guard around {@link CREATE_PRODUCTION_HIERARCHY}. */
export interface PromotionGuard {
  /**
   * Handle one call's raw (JSON-decoded) arguments. The FIRST call whose args
   * validate records the hierarchy and returns {@link HIERARCHY_CREATED_ACK}
   * (`created: true`). Every call after that — valid or not — is an idempotent
   * dead-end returning {@link HIERARCHY_ALREADY_CREATED_ACK} (`created: false`,
   * `done: true`), creating NO second hierarchy. A call BEFORE any hierarchy is
   * recorded whose args do not validate is a no-op (`created: false, done: false`).
   */
  handle(raw: unknown): PromotionCallResult;
  /** The recorded hierarchy args (from the first valid call), or undefined. */
  readonly recorded: CreateHierarchyArgs | undefined;
}

/** Create a fresh {@link PromotionGuard}. One guard per worker/CEO promotion turn. */
export function createPromotionGuard(): PromotionGuard {
  let recorded: CreateHierarchyArgs | undefined;
  return {
    get recorded(): CreateHierarchyArgs | undefined {
      return recorded;
    },
    handle(raw: unknown): PromotionCallResult {
      // Already recorded → an idempotent terminal dead-end (no second hierarchy,
      // control never passes back).
      if (recorded !== undefined) {
        return { created: false, ack: HIERARCHY_ALREADY_CREATED_ACK, done: true };
      }
      const args = parseCreateHierarchyArgs(raw);
      if (args === undefined) {
        // Not a usable promotion yet — nothing recorded, not terminal.
        return { created: false, ack: HIERARCHY_ALREADY_CREATED_ACK, done: false };
      }
      recorded = args;
      return { created: true, args, ack: HIERARCHY_CREATED_ACK, done: true };
    },
  };
}

/** Fallback project id when {@link applyCreateHierarchy} is given no base chart
 * and no explicit id (e.g. the standalone test driver). */
export const DEFAULT_PROMOTION_PROJECT_ID = 'project';

/** Fixed node ids for the two permanent roles (spec §4). */
const CEO_NODE_ID = 'ceo';
const MANAGER_NODE_ID = 'manager';

/** Slugify a division name into an id fragment (`"3D Assets"` → `"3d-assets"`). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build a fresh {@link OrgChart} from a {@link CREATE_PRODUCTION_HIERARCHY} call:
 * a CEO node, the permanent manager block below it, and one `division` node per
 * proposed division (parented to the manager, its `purpose` carried as a light
 * prompt extension — the contract, not the prompt, will govern the work). All
 * nodes start `idle`; the chart's run status becomes `running` because a
 * corporation now exists (there is no distinct "promoted-but-idle" state, and
 * dispatch is a later slice).
 *
 * Pure: reuses the corp types + {@link emptyOrgChart}, builds a brand-new chart,
 * and never mutates `base`. When `base` is provided its `projectId` is kept
 * (re-promotion of an existing project); otherwise `projectId` (or
 * {@link DEFAULT_PROMOTION_PROJECT_ID}) is used.
 */
export function applyCreateHierarchy(
  base: OrgChart | null,
  args: CreateHierarchyArgs,
  projectId: string = base?.projectId ?? DEFAULT_PROMOTION_PROJECT_ID,
): OrgChart {
  const chart = emptyOrgChart(projectId);

  const nodes: OrgNode[] = [
    { id: CEO_NODE_ID, role: 'ceo', name: 'CEO', promptId: 'ceo' },
    {
      id: MANAGER_NODE_ID,
      role: 'manager',
      name: 'Manager block',
      parentId: CEO_NODE_ID,
      promptId: 'manager',
    },
  ];

  const usedIds = new Set<string>([CEO_NODE_ID, MANAGER_NODE_ID]);
  args.divisions.forEach((division, index) => {
    const slug = slugify(division.name);
    // Deterministic, collision-free ids even for blank/duplicate names.
    let id = `division-${slug === '' ? index + 1 : slug}`;
    let bump = 2;
    while (usedIds.has(id)) {
      id = `division-${slug === '' ? index + 1 : slug}-${bump}`;
      bump += 1;
    }
    usedIds.add(id);
    nodes.push({
      id,
      role: 'division',
      name: division.name,
      parentId: MANAGER_NODE_ID,
      // No archetype resolution in slice 1: carry the model's purpose as a light
      // extension over the generic base. The manager's contracts govern regardless.
      promptExtension: division.purpose,
    });
  });

  const nodeStatus: Record<string, 'idle'> = {};
  for (const node of nodes) nodeStatus[node.id] = 'idle';

  return {
    ...chart,
    nodes,
    status: 'running',
    nodeStatus,
  };
}
