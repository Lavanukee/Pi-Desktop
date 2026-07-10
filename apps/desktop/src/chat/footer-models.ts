/**
 * Pure helpers for the round-10 #20a footer model dropdown restructure: which
 * local models the footer popup surfaces (downloaded / switch-now only) and
 * whether any switchable model exists at all. Deliberately free of store/browser
 * imports so they stay unit-testable in the node test env (importing the footer
 * component pulls in `window`-touching modules).
 */

/**
 * The downloaded (switch-now) subset of the local catalog — the only local
 * models the footer popup shows. Non-downloaded entries are dropped here; they
 * live in the full Model Manager (behind "More models").
 */
export function downloadedCatalog<T extends { downloaded?: boolean }>(catalog: T[]): T[] {
  return catalog.filter((entry) => entry.downloaded === true);
}

/**
 * Whether the footer has ANY model to switch to immediately (pi's available
 * models, on-device Apple Intelligence, or a downloaded local model) — gates the
 * "Models" group + the divider that precedes the "More models" row.
 */
export function hasSwitchableModel(
  piModelCount: number,
  appleAvailable: boolean,
  downloadedCount: number,
): boolean {
  return piModelCount > 0 || appleAvailable || downloadedCount > 0;
}
