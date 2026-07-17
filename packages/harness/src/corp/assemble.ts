/**
 * Product ASSEMBLY — the structured manifest of the finished product (spec §8
 * review/merge, §5 the org chart).
 *
 * After dispatch (dispatch.ts) the workspace IS the integrated product: every
 * engineer wrote the file for its contract's DISTINCT slot (the integrity sweep
 * de-collides slots, so there is no merge conflict to resolve — assembly is
 * reading the tree back, not stitching branches). This module produces the
 * {@link ProductManifest}: a flat, structured description of what got built —
 * the divisions, the produced files (path + size), the cross-division interface
 * seams, and a coarse contract-status summary. It is the CLEAN ARTIFACT handed to
 * the CEO's final review (ceo.ts): the product, not the build transcript.
 *
 * Pure + fs-seam: it reads produced files through the injected
 * {@link WorkspaceReadFs} (in-memory in tests, node:fs in the driver) and never
 * mutates the chart or throws.
 */

import type { ContractStatus, InterfaceHandle, OrgChart } from './org-chart.js';
import { slotPath, type WorkspaceReadFs } from './workspace.js';

/** One produced file in the assembled product. */
export interface ProductFile {
  /** The project-relative slot the file was written to. */
  readonly slot: string;
  /** The absolute path inside the workspace root. */
  readonly path: string;
  /** UTF-8 byte length of the produced file. */
  readonly bytes: number;
}

/** One work division in the assembled product (from the org chart). */
export interface ProductDivision {
  readonly id: string;
  readonly name: string;
}

/**
 * Coarse roll-up of contract lifecycle into the three outcomes a reviewer cares
 * about: how many contracts produced work, failed, or never completed. Derived
 * purely from {@link Contract.status} (see {@link summarizeContractStatus}).
 */
export interface ContractStatusSummary {
  /** Contracts whose work was produced (`in-review` / `merged`). */
  readonly done: number;
  /** Contracts returned `unfulfillable`. */
  readonly failed: number;
  /** Contracts that never completed (`queued` / `ready` / `in-progress`). */
  readonly skipped: number;
}

/** The structured description of the finished product — the clean artifact the
 * CEO reviews (ceo.ts), never the build transcript. */
export interface ProductManifest {
  /** The work divisions (org-chart nodes of role `division`). */
  readonly divisions: readonly ProductDivision[];
  /** Every produced file found in the workspace, in contract order. */
  readonly files: readonly ProductFile[];
  /** The cross-division interface seams (from the shared architecture, if any). */
  readonly interfaces: readonly InterfaceHandle[];
  /** How the contracts ended up (produced / failed / never completed). */
  readonly contractStatusSummary: ContractStatusSummary;
  /** Total UTF-8 bytes across every produced file. */
  readonly totalBytes: number;
}

/** UTF-8 byte length of a produced file (no node:Buffer dependency). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Bucket a {@link ContractStatus} into the coarse produced/failed/not-done outcome
 * the manifest summarizes. `in-review`/`merged` = work produced (`done`);
 * `unfulfillable` = `failed`; everything else (`queued`/`ready`/`in-progress`)
 * never completed (`skipped`). Pure.
 */
export function summarizeContractStatus(status: ContractStatus): keyof ContractStatusSummary {
  if (status === 'merged' || status === 'in-review') return 'done';
  if (status === 'unfulfillable') return 'failed';
  return 'skipped';
}

/**
 * Build the {@link ProductManifest} for a dispatched chart. Divisions come from
 * the org-chart nodes; interfaces from the shared architecture; the contract
 * summary from each contract's status; and the file list from reading each
 * contract's slot back out of the workspace via `fs` — a contract with no file on
 * disk (skipped/failed) simply contributes no file entry. Distinct slots dedupe
 * to distinct files. Pure aside from the injected read seam; never throws.
 */
export function buildProductManifest(
  orgChart: OrgChart,
  workspace: string,
  fs: WorkspaceReadFs,
): ProductManifest {
  const divisions: ProductDivision[] = orgChart.nodes
    .filter((n) => n.role === 'division')
    .map((n) => ({ id: n.id, name: n.name }));

  const files: ProductFile[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const contract of orgChart.contracts) {
    const path = slotPath(workspace, contract.slot);
    if (seenPaths.has(path)) continue;
    const content = fs.readFile(path);
    if (content === undefined) continue; // not produced → no file entry
    seenPaths.add(path);
    const bytes = byteLength(content);
    totalBytes += bytes;
    files.push({ slot: contract.slot, path, bytes });
  }

  const summary: { done: number; failed: number; skipped: number } = {
    done: 0,
    failed: 0,
    skipped: 0,
  };
  for (const contract of orgChart.contracts) summary[summarizeContractStatus(contract.status)] += 1;

  return {
    divisions,
    files,
    interfaces: orgChart.architecture?.interfaces ?? [],
    contractStatusSummary: summary,
    totalBytes,
  };
}
