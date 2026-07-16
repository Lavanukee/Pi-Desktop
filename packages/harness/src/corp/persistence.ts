/**
 * Per-project org-chart persistence skeleton (spec §5).
 *
 * The org chart is a single JSON artifact at the PROJECT level — projects are a
 * directory feature, so the chart lives under the project's working directory
 * at `<projectDir>/.pi/org-chart.json` (same `.pi/` project-data convention as
 * project skills) and is shared across the project's chats.
 *
 * Skeleton only: pure serialize/parse + a thin injected-fs wrapper. Nothing
 * live reads or writes this yet (Phase 2 wires it). The fs seam keeps every
 * path unit-testable without touching disk, matching the house style
 * (see verify.ts's ProjectProbe).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isOrgChart, type OrgChart } from './org-chart.js';

/** Project-relative location of the persisted chart. */
export const ORG_CHART_RELATIVE_PATH = '.pi/org-chart.json';

/**
 * Bumped on breaking shape changes so a loader can migrate/refuse old files.
 * Stored alongside the chart in the on-disk envelope.
 */
export const ORG_CHART_SCHEMA_VERSION = 1;

/** Absolute path of the org-chart file for a project directory. */
export function orgChartPath(projectDir: string): string {
  return join(projectDir, ORG_CHART_RELATIVE_PATH);
}

/** The on-disk envelope: schema version + the chart itself. */
interface OrgChartFile {
  readonly version: number;
  readonly chart: OrgChart;
}

/** Serialize a chart to the on-disk JSON envelope (pretty — it's a per-project
 * artifact a user may reasonably open). Pure. */
export function serializeOrgChart(chart: OrgChart): string {
  const file: OrgChartFile = { version: ORG_CHART_SCHEMA_VERSION, chart };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Parse + validate on-disk JSON back into an {@link OrgChart}. Returns
 * `undefined` for anything unusable (bad JSON, wrong shape, future schema
 * version) — a corrupt chart must never crash a resume; the caller falls back
 * to an empty chart. Pure.
 */
export function parseOrgChart(json: string): OrgChart | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (decoded === null || typeof decoded !== 'object') return undefined;
  const file = decoded as Record<string, unknown>;
  if (typeof file.version !== 'number' || file.version > ORG_CHART_SCHEMA_VERSION) {
    return undefined;
  }
  return isOrgChart(file.chart) ? file.chart : undefined;
}

/** The thin fs seam: exactly what load/save need, injectable for tests. */
export interface OrgChartFs {
  /** Read a text file, or undefined if absent/unreadable. */
  readonly readText: (path: string) => string | undefined;
  /** Write a text file, creating parent directories. Atomic where possible. */
  readonly writeText: (path: string, text: string) => void;
}

/** The default seam, backed by node:fs (write = temp file + rename, so a crash
 * mid-save never leaves a truncated chart). */
export function makeNodeOrgChartFs(): OrgChartFs {
  return {
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeText: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, text, 'utf8');
      renameSync(tmp, path);
    },
  };
}

/**
 * Load the project's org chart, or `undefined` when none exists yet / the file
 * is unusable (callers start from {@link emptyOrgChart}). Never throws.
 */
export function loadOrgChart(
  projectDir: string,
  fs: OrgChartFs = makeNodeOrgChartFs(),
): OrgChart | undefined {
  const text = fs.readText(orgChartPath(projectDir));
  return text === undefined ? undefined : parseOrgChart(text);
}

/** Save the project's org chart (whole-artifact write; it's small). */
export function saveOrgChart(
  projectDir: string,
  chart: OrgChart,
  fs: OrgChartFs = makeNodeOrgChartFs(),
): void {
  fs.writeText(orgChartPath(projectDir), serializeOrgChart(chart));
}
