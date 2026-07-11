/**
 * Pure `ModalityModel` → {@link ModalityCatalogEntry} DTO mapper. Kept in its
 * OWN electron-free module (no `electron` import) so the mapping is unit-testable
 * and so the value-import of the `@pi-desktop/gen-service` barrel stays on the
 * MAIN side of the boundary — the renderer only ever sees the plain DTO the
 * gen-manager sends over `gen:modality-catalog`.
 */
import type { ModalityModel } from '@pi-desktop/gen-service';
import type { ModalityCatalogEntry } from './gen-ipc-contract';

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
