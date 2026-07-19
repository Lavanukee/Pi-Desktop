/**
 * The guaranteed INTEGRATION contract — the runnable product ENTRY that wires every
 * division's module into the actual running product (spec §5 the integration layer,
 * §8 the tester gate / "food with no home").
 *
 * WHY this exists (the real-run defect it fixes): the corp decomposed a "playable
 * Snake game — ONE openable index.html" into 27 cross-importing TS modules with NO
 * root entry that mounts and runs them. The tester gate correctly flagged
 * `runnableEntryMissing`, but the review bounce could only re-dispatch EXISTING
 * contracts — and the missing entry maps to NONE — so it flagged forever and never
 * built the entry. The root cause: NO contract/region OWNED "the runnable product
 * entry that wires the modules and runs".
 *
 * The fix is one contract that OWNS the entry. It DEPENDS on every division output
 * (so it runs LAST, seeing real produced code), is dispatched to an engineer, and is
 * verified by the tester + bounced like any other contract. The architect/managers
 * may not author one (a small model forgets), so the corp AUTO-INJECTS it —
 * {@link ensureIntegrationContract} at planning time (run.ts), and the SAME
 * {@link buildIntegrationContract} is re-used by the review-recovery seam
 * (review.ts) when the entry is still missing at merge.
 *
 * The delivery shape (delivery.ts) steers the entry: a web/openable product gets a
 * SELF-CONTAINED root `index.html`; a pure-logic product a wiring `src/main.ts`. A
 * product with no renderable/web surface has no browser entry to own, so none is
 * injected (that class has no tester gate — see {@link needsIntegrationEntry}).
 *
 * Pure + deterministic; never throws.
 */

import { type DeliveryShape, deliveryConstraintLines } from './delivery.js';
import type { Architecture, Contract, OrgNode } from './org-chart.js';
import { isRenderableSlot, isRunnableEntrySlot } from './review.js';

/** The concrete rules a BROWSER entry (an `index.html`) must satisfy to actually
 * LOAD — the exact discipline the static preflight (preflight.ts) enforces at the
 * gate. Spliced into the integration brief so PREVENTION matches DETECTION: the
 * engineer is told up front what the gate will bounce it for. The real-run defect
 * these fix: an `index.html` that imported `.ts` modules, non-existent files, a bare
 * `three`, and `node:media` — none of which a browser can load. Pure. */
export function browserEntryRuleLines(): string[] {
  return [
    'BROWSER-LOADABLE ENTRY (the entry must OPEN and RUN, not just exist — this is checked):',
    '- Import ONLY files that actually exist. Before you import a path, confirm the file is really there with that exact name (read the tree first).',
    '- NEVER import a .ts/.tsx module from the HTML — a browser cannot execute TypeScript. Inline the logic into the entry, or import compiled .js. A <script type="module"> may only load .js/.mjs.',
    '- Resolve every dependency one of three ways: a RELATIVE path to a real .js file, an <script type="importmap"> mapping, or a full https:// CDN URL. NO bare specifiers (e.g. `import "three"`) with no import map — a browser cannot resolve them.',
    '- NO `node:` builtins (node:fs, node:media, …) and NO `@types/*` imports — neither exists at runtime in a browser.',
    '- The bar: double-clicking the entry (or serving the folder) LOADS and RUNS the product with no build step and no console errors.',
  ];
}

/** The stable id of the synthesized integration contract (uniquified against
 * existing ids by {@link ensureIntegrationContract} in the rare collision case). */
export const INTEGRATION_CONTRACT_ID = 'integration-entry';

/** The stable owner-node id of the integration engineer. */
export const INTEGRATION_OWNER_NODE_ID = 'integration-eng';

/** The human-readable name of the integration engineer node (situation room). */
export const INTEGRATION_NODE_NAME = 'Integration';

/** True when a product is a WEB/renderable artifact — from its delivery shape OR any
 * renderable slot in its contracts / module map / interfaces. The class that needs a
 * browser entry (and the class the tester gate governs). Pure. */
function isWebProduct(
  contracts: readonly Contract[],
  architecture: Architecture,
  shape: DeliveryShape,
): boolean {
  if (shape.web) return true;
  if (contracts.some((c) => isRenderableSlot(c.slot))) return true;
  if (architecture.moduleMap.some((m) => isRenderableSlot(m.path))) return true;
  return architecture.interfaces.some((h) => isRenderableSlot(h.path));
}

/**
 * The runnable-entry slot for the product: the single openable file for a
 * web/openable delivery (root `index.html`), else a top-level wiring entry
 * (`src/main.ts`). Pure.
 */
export function integrationEntrySlot(
  contracts: readonly Contract[],
  architecture: Architecture,
  shape: DeliveryShape,
): string {
  return isWebProduct(contracts, architecture, shape) ? 'index.html' : 'src/main.ts';
}

/**
 * True when the product NEEDS a runnable entry that no existing contract owns: it is
 * a web/renderable/openable product AND no contract already produces a runnable
 * entry / build shell (an index.html, a package.json, a main entry, or a bundler
 * config). A pure-logic product has no browser entry to own — and no tester gate —
 * so this is `false` for it (we never fabricate a spurious entry). Pure.
 */
export function needsIntegrationEntry(
  contracts: readonly Contract[],
  architecture: Architecture,
  shape: DeliveryShape,
): boolean {
  if (!isWebProduct(contracts, architecture, shape)) return false;
  return !contracts.some((c) => isRunnableEntrySlot(c.slot));
}

/** Inputs to {@link buildIntegrationContract}. */
export interface BuildIntegrationContractInput {
  /** The division contracts the entry wires together (its default `dependsOn`). */
  readonly divisionContracts: readonly Contract[];
  /** The shared architecture (its interfaces name the seams the entry consumes). */
  readonly architecture: Architecture;
  /** The delivery shape (openable/web) that steers the entry + its brief. */
  readonly deliveryShape: DeliveryShape;
  /** The vision the entry is built against (unused in the typed fields; kept for
   * parity with the other contract-authoring seams and future briefs). */
  readonly vision: string;
  /** Owner engineer node id (default {@link INTEGRATION_OWNER_NODE_ID}). */
  readonly ownerNodeId?: string;
  /** Contract id (default {@link INTEGRATION_CONTRACT_ID}). */
  readonly id?: string;
  /** `dependsOn` override — default: every division contract id (so it runs LAST).
   * The review-recovery path passes `[]` (a pruned, standalone re-dispatch). */
  readonly dependsOn?: readonly string[];
  /** Extra notes appended to the brief (e.g. the review bounce's findings). */
  readonly extraNotes?: string;
}

/**
 * Build the synthesized INTEGRATION {@link Contract} — the runnable product entry
 * that wires every division's module + exposed interface into the actual running
 * product, and confirms it runs. Its `slot` is the delivery-appropriate entry
 * ({@link integrationEntrySlot}); its `dependsOn` defaults to every division output
 * (so it runs after them); its `notes` carry the delivery constraint (a web/openable
 * product must OPEN with no build). Mirrors the {@link Contract} shape exactly (the
 * same fields a manager authors). Pure; never throws.
 */
export function buildIntegrationContract(input: BuildIntegrationContractInput): Contract {
  const { divisionContracts, architecture, deliveryShape, extraNotes } = input;
  const slot = integrationEntrySlot(divisionContracts, architecture, deliveryShape);
  const id = input.id ?? INTEGRATION_CONTRACT_ID;
  const ownerNodeId = input.ownerNodeId ?? INTEGRATION_OWNER_NODE_ID;
  const openable = deliveryShape.openableSingleFile;

  const interfaces = architecture.interfaces;
  const seamList =
    interfaces.length > 0
      ? interfaces.map((h) => `${h.name} (${h.exposedBy} @ ${h.path})`).join('; ')
      : divisionContracts.map((c) => c.slot).join(', ');

  const noteLines = [
    "This is the final INTEGRATION/assembly step: wire EVERY division's produced module + its exposed interface into ONE runnable product and confirm it actually runs. It depends on the division outputs, so their real files exist when you build this.",
    ...deliveryConstraintLines(deliveryShape),
    // A browser entry (index.html) must genuinely LOAD — the exact rules the preflight
    // gate enforces, so the engineer is told them up front (prevention == detection).
    ...(slot.endsWith('.html') ? browserEntryRuleLines() : []),
  ];
  const trimmedExtra = extraNotes?.trim();
  if (trimmedExtra !== undefined && trimmedExtra !== '') noteLines.push('', trimmedExtra);

  return {
    id,
    title: 'Runnable product entry',
    ownerNodeId,
    input: `Every division's produced modules and the interfaces they expose (${seamList}). Assemble them into the runnable product.`,
    output: openable
      ? `${slot} — a SELF-CONTAINED entry a browser opens DIRECTLY (no build/bundler/server): it loads or mounts every division's module and runs the working product.`
      : `${slot} — the runnable entry that imports and mounts every division's module and runs the working product.`,
    slot,
    available: {
      tools: ['read', 'write', 'bash'],
      imports: interfaces.map((h) => h.path),
    },
    reviewRubric: openable
      ? "Opening the entry file directly in a browser (no build/bundler/server) launches the working product with every division's feature wired in and running."
      : "Running the entry launches the working product with every division's feature wired in; it builds and runs.",
    dependsOn: input.dependsOn ?? divisionContracts.map((c) => c.id),
    notes: noteLines.join('\n'),
    status: 'queued',
  };
}

/** The owner {@link OrgNode} for a synthesized integration contract — an engineer
 * node carrying the integration domain flavor (so the agent engineer's composed
 * prompt frames "wire the modules into the runnable product"). Pure. */
export function buildIntegrationOwnerNode(ownerNodeId: string, parentNodeId?: string): OrgNode {
  return {
    id: ownerNodeId,
    role: 'engineer',
    name: INTEGRATION_NODE_NAME,
    ...(parentNodeId !== undefined ? { parentId: parentNodeId } : {}),
    promptId: 'engineer',
    promptExtension:
      "Integration: wire every division's module + exposed interface into the single runnable product entry, and confirm the whole product actually runs.",
  };
}

/** What {@link ensureIntegrationContract} produced. */
export interface EnsureIntegrationResult {
  /** The contracts, with the integration contract appended when one was injected. */
  readonly contracts: Contract[];
  /** The injected integration contract, when one was added (else absent). */
  readonly injected?: Contract;
  /** The integration engineer's owner node, when one was added (else absent). */
  readonly ownerNode?: OrgNode;
}

/** Inputs to {@link ensureIntegrationContract}. */
export interface EnsureIntegrationInput {
  readonly contracts: readonly Contract[];
  readonly architecture: Architecture;
  readonly deliveryShape: DeliveryShape;
  readonly vision: string;
  /** The parent (manager block) node id for the integration engineer node. */
  readonly ownerParentNodeId?: string;
}

/**
 * GUARANTEE a runnable-entry integration contract on a web/renderable product's
 * plan. When {@link needsIntegrationEntry} is true, append a synthesized
 * {@link buildIntegrationContract} (depending on every division output) + its owner
 * node, so the corp ALWAYS has a final contract that owns the runnable entry — it no
 * longer relies on the small model to remember one. When the product is pure-logic,
 * or already owns a runnable entry, it is a no-op (the contracts are returned
 * unchanged). The contract id is uniquified against existing ids in the rare
 * collision case. Pure; never mutates its inputs; never throws.
 */
export function ensureIntegrationContract(input: EnsureIntegrationInput): EnsureIntegrationResult {
  const { contracts, architecture, deliveryShape, vision } = input;
  if (!needsIntegrationEntry(contracts, architecture, deliveryShape)) {
    return { contracts: [...contracts] };
  }
  const existingIds = new Set(contracts.map((c) => c.id));
  let id = INTEGRATION_CONTRACT_ID;
  let bump = 2;
  while (existingIds.has(id)) {
    id = `${INTEGRATION_CONTRACT_ID}-${bump}`;
    bump += 1;
  }
  const contract = buildIntegrationContract({
    divisionContracts: contracts,
    architecture,
    deliveryShape,
    vision,
    ownerNodeId: INTEGRATION_OWNER_NODE_ID,
    id,
  });
  const ownerNode = buildIntegrationOwnerNode(INTEGRATION_OWNER_NODE_ID, input.ownerParentNodeId);
  return { contracts: [...contracts, contract], injected: contract, ownerNode };
}
