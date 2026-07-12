/**
 * Pure `ModalityModel` → {@link ModalityCatalogEntry} DTO mapper. Kept in its
 * OWN electron-free module (no `electron` import) so the mapping is unit-testable
 * and so the value-import of the `@pi-desktop/gen-service` barrel stays on the
 * MAIN side of the boundary — the renderer only ever sees the plain DTO the
 * gen-manager sends over `gen:modality-catalog`.
 */
import type { ModalityModel } from '@pi-desktop/gen-service';
import type { ModalityCatalogEntry } from './gen-ipc-contract';

/**
 * Backends whose catalog rows are TOOLS, not browsable models — they must never
 * surface in the model browser's modality tabs. `hyperframes` is the Node/ffmpeg
 * motion-graphics runner: the agent authors HTML/CSS/JS→MP4 with it, so it is a
 * capability the model reaches for (and the connectors surface preinstalls it as
 * a connector), NOT a weight a user picks/downloads in the Video tab. Widen this
 * set if a later tool-only backend joins the catalog.
 */
export const TOOL_ONLY_BACKENDS: ReadonlySet<string> = new Set(['hyperframes']);

/**
 * Whether a catalog row should surface in the model browser. Tool-only backends
 * (see {@link TOOL_ONLY_BACKENDS}) are excluded — they are agent capabilities,
 * not models the user browses/installs. The single source of truth for the
 * browser's tools-are-not-models rule.
 */
export function surfacesAsModel(m: ModalityModel): boolean {
  return !TOOL_ONLY_BACKENDS.has(m.backend);
}

/**
 * The vetted catalog as browser DTOs — tool-only rows filtered OUT, the rest
 * flattened. This is what `gen:modality-catalog` answers; the renderer's
 * `useGenStore` therefore never even sees a tool row. Kept here (electron-free,
 * unit-testable) so the exclusion rule + the mapping stay together.
 */
export function surfaceModalityCatalog(catalog: readonly ModalityModel[]): ModalityCatalogEntry[] {
  return catalog.filter(surfacesAsModel).map(toModalityCatalogEntry);
}

/** Flatten one catalog row to the wire DTO (optional flags normalised to bool). */
export function toModalityCatalogEntry(m: ModalityModel): ModalityCatalogEntry {
  return {
    id: m.id,
    modality: m.modality,
    label: m.label,
    backend: m.backend,
    license: m.license,
    commercialUse: m.commercialUse,
    approxSizeGB: m.approxSizeGB,
    minUnifiedMemoryGB: m.minUnifiedMemoryGB,
    runsLocally: m.runsLocally,
    heavy: m.heavy,
    reserved: m.reserved === true,
    recommended: m.recommended === true,
    repo: m.repo,
    notes: m.notes,
  };
}
