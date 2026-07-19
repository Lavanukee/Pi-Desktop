/**
 * `@pi-desktop/harness/corp` — the corporation data-model backbone (spec §4/§5/
 * §6/§7/§8/§9): the org-chart/contract/queue types + guards, the dependency-DAG
 * helpers, per-project persistence, the predefined system-prompt library, and the
 * completion path — product assembly, the evidence-grounded verify pass, the CEO
 * sign-off (the false-completion cure), and one-level escalation.
 *
 * Exposed as a DEDICATED SUBPATH, not the root `@pi-desktop/harness` barrel, on
 * purpose: {@link ./persistence.js} imports `node:fs`, and the renderer
 * (apps/desktop/src) value-imports the root barrel — so folding corp into it
 * would leak `node:fs` into the browser bundle and break `vite build`. Node /
 * main-process code (Phase 2 dispatch, scheduling, resume) imports this subpath;
 * the renderer never does. Callers that only need the pure, fs-free parts
 * (types, guards, DAG helpers, prompts) still get them here — only the
 * persistence helpers actually touch `node:fs`, and only when invoked.
 */

export * from './architect.js';
export * from './assemble.js';
export * from './budget.js';
export * from './ceo.js';
export * from './contracts.js';
export * from './dag.js';
export * from './delivery.js';
export * from './dispatch.js';
export * from './engineer.js';
export * from './escalate.js';
export * from './integrate.js';
export * from './integration-contract.js';
export * from './corp-mesh.js';
export * from './mesh.js';
export * from './org-chart.js';
export * from './persistence.js';
export * from './plan.js';
export * from './promotion.js';
export * from './prompts.js';
export * from './retry.js';
export * from './review.js';
export * from './revise.js';
export * from './role-agent-seam.js';
export * from './run.js';
export * from './sanitize.js';
export * from './verify.js';
export * from './vision.js';
export * from './workspace.js';
