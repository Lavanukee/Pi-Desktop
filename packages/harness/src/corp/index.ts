/**
 * `@pi-desktop/harness/corp` — the corporation data-model backbone (spec §4/§5/
 * §6/§7): the org-chart/contract/queue types + guards, the dependency-DAG
 * helpers, per-project persistence, and the predefined system-prompt library.
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

export * from './contracts.js';
export * from './dag.js';
export * from './org-chart.js';
export * from './persistence.js';
export * from './promotion.js';
export * from './prompts.js';
