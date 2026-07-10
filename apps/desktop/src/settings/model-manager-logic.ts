/**
 * Pure presentation logic for the Model Manager — kept React-free so the
 * RAM-fit verdict, size/speed formatting, and quant selection are unit-testable
 * and can't drift silently.
 */
import type { LlmCatalogEntry } from '../../electron/ipc-contract';

export type RamTone = 'success' | 'warning' | 'danger' | 'default';

export interface RamVerdict {
  tone: RamTone;
  label: string;
  /** Whether the machine meets the model's minimum RAM. */
  fits: boolean;
}

/**
 * Green/ok/insufficient verdict comparing a model's minimum RAM against
 * detected RAM. Unknown RAM (0, e.g. non-macOS detect) yields a neutral badge
 * that just states the requirement rather than guessing a fit.
 */
export function ramVerdict(minRamGB: number, totalRamGB: number): RamVerdict {
  if (totalRamGB <= 0) return { tone: 'default', label: `${minRamGB} GB RAM`, fits: true };
  if (totalRamGB < minRamGB) return { tone: 'danger', label: 'Needs more RAM', fits: false };
  if (totalRamGB - minRamGB < 4) return { tone: 'warning', label: 'Tight fit', fits: true };
  return { tone: 'success', label: 'Fits comfortably', fits: true };
}

/** Human byte size (binary-ish, matches how model files are quoted). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1e6;
  return `${mb.toFixed(0)} MB`;
}

/** Transfer rate, e.g. "12.4 MB/s"; null/zero → empty so the UI can omit it. */
export function formatSpeed(bytesPerSec: number | null): string {
  if (bytesPerSec === null || bytesPerSec <= 0) return '';
  const mb = bytesPerSec / 1e6;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bytesPerSec / 1e3;
  return `${kb.toFixed(0)} KB/s`;
}

/** 0..1 fraction → integer percent, clamped; null → null (indeterminate). */
export function percent(fraction: number | null): number | null {
  if (fraction === null) return null;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/** The quant to size/act on: the named one, else the first (smallest listed). */
export function selectedQuant(
  entry: Pick<LlmCatalogEntry, 'quants'>,
  quant?: string,
): { quant: string; bytes: number } | undefined {
  if (quant !== undefined) {
    const match = entry.quants.find((q) => q.quant === quant);
    if (match !== undefined) return match;
  }
  return entry.quants[0];
}

/** The size shown on a card: downloaded → the on-disk quant, else the default. */
export function displaySizeBytes(entry: LlmCatalogEntry, quant?: string): number {
  return selectedQuant(entry, quant)?.bytes ?? 0;
}

// ---------------------------------------------------------------------------
// Reliable-publisher labelling (round-12 #2)
// ---------------------------------------------------------------------------

/**
 * Reliable-publisher allowlist — a renderer-side MIRROR of
 * `@pi-desktop/inference`'s catalog `RELIABLE_PUBLISHERS` (kept in sync with
 * keystone). We can't import the package barrel into the renderer bundle (it
 * re-exports the node-only supervisor/downloader), so curated cards read the
 * flag the contract already carries (`entry.publisher.reliable`) and this list
 * powers the Browse-HF author check, where no flag is wired. NOTE: community
 * re-quanters (e.g. `mradermacher`) are deliberately NOT reliable.
 */
export const RELIABLE_PUBLISHERS: readonly string[] = [
  'unsloth',
  'bartowski',
  'ggml-org',
  'nvidia',
  'Qwen',
  'google',
  'deepmind',
  'mlx-community',
  'lmstudio-community',
];

/** Whether an HF publisher handle is in the reliable allowlist (exact match,
 * matching keystone's `isReliablePublisher`). */
export function isReliablePublisher(handle: string): boolean {
  return RELIABLE_PUBLISHERS.includes(handle);
}

// ---------------------------------------------------------------------------
// De-duplicated model grouping — model → variant → quant (round-12 #1, #3)
// ---------------------------------------------------------------------------

/** Speculative-decoding speed method (mirror of the catalog `SpecMethod`). */
export type SpecMethod = 'mtp' | 'eagle3' | 'dflash';

/** Order the variant dropdown offers methods in: [MTP / DFlash / EAGLE-3]. */
export const VARIANT_ORDER: readonly SpecMethod[] = ['mtp', 'dflash', 'eagle3'];

/** Human label per speed method. */
export const VARIANT_LABEL: Record<SpecMethod, string> = {
  mtp: 'MTP',
  dflash: 'DFlash',
  eagle3: 'EAGLE-3',
};

/** Trailing "(MTP)" / "(EAGLE-3)" / "(DFlash)" suffix on a display name. */
const VARIANT_SUFFIX_RE = /\s*\((?:MTP|EAGLE-?3|DFlash)\)\s*$/i;

/** A model size token, e.g. `E2B`, `12B`, `0.8B`, `26B-A4B`, `30B-A3B`. */
const SIZE_TOKEN_RE = /^E?\d+(?:\.\d+)?B(?:-A\d+B)?$/i;

/** The de-duplication key: a display name stripped of its speed-variant suffix,
 * so "Qwen3.6 27B (MTP)" and "Qwen3.6 27B (EAGLE-3)" collapse to one model. */
export function baseModelName(displayName: string): string {
  return displayName.replace(VARIANT_SUFFIX_RE, '').trim();
}

/** The model FAMILY label (everything before the size token), for the
 * power-user categorized view — e.g. "Gemma 4 12B Instruct" → "Gemma 4",
 * "Qwen3.6 27B (MTP)" → "Qwen3.6", "NVIDIA Nemotron-3 Nano 30B-A3B" →
 * "NVIDIA Nemotron-3 Nano". */
export function modelFamily(displayName: string): string {
  const base = baseModelName(displayName);
  const tokens = base.split(/\s+/);
  const idx = tokens.findIndex((t) => SIZE_TOKEN_RE.test(t));
  if (idx <= 0) return base;
  return tokens.slice(0, idx).join(' ');
}

/** One speed variant option on a grouped card — a method plus the CONCRETE
 * catalog entry (repo) its Download/Start resolves to. */
export interface VariantOption {
  method: SpecMethod;
  label: string;
  /** The catalog entry id to download/start when this variant is selected. */
  entryId: string;
  /** Separate draft-GGUF repo (EAGLE-3 / DFlash), surfaced in Advanced. */
  draftRepo?: string;
  /** True when the head is embedded in the main GGUF (no separate draft). */
  embedded?: boolean;
}

/** One de-duplicated model: a single card that fans out to its variants (repos)
 * and quants. */
export interface ModelGroup {
  /** De-dup key = base display name. */
  key: string;
  /** Base display name (no variant suffix) shown on the card. */
  displayName: string;
  /** Family label for the categorized view. */
  family: string;
  /** Every catalog entry that collapsed into this model. */
  entries: LlmCatalogEntry[];
  /** The representative entry (badges / RAM / publisher / tier / size). */
  primary: LlmCatalogEntry;
  /** Available speed variants (deduped union, in {@link VARIANT_ORDER}). */
  variants: VariantOption[];
  /** Min system RAM (from the primary) — the size-sort key. */
  minRamGB: number;
}

/** Pick a group's representative entry: prefer the simple MTP/embedded default,
 * else the smallest by RAM. (A group is never empty, so `reduce` without a seed
 * always returns an entry.) */
function pickPrimary(entries: readonly LlmCatalogEntry[]): LlmCatalogEntry {
  return entries.reduce((best, e) => {
    const bestIsMtp = best.spec === 'mtp' || best.mtp;
    const eIsMtp = e.spec === 'mtp' || e.mtp;
    if (eIsMtp !== bestIsMtp) return eIsMtp ? e : best;
    return e.minRamGB < best.minRamGB ? e : best;
  });
}

/** Build the deduped variant option list for a group's entries. For each method
 * (in dropdown order) the option resolves to the entry that best provides it:
 * an entry whose DEFAULT spec is that method (its dedicated repo), else the
 * first entry that lists it among its `variants`. */
function buildVariants(entries: readonly LlmCatalogEntry[]): VariantOption[] {
  const options: VariantOption[] = [];
  for (const method of VARIANT_ORDER) {
    const dedicated = entries.find((e) => e.spec === method);
    const lister = entries.find((e) => e.variants?.some((v) => v.method === method));
    const entry = dedicated ?? lister;
    if (entry === undefined) continue;
    const v = entry.variants?.find((x) => x.method === method);
    options.push({
      method,
      label: VARIANT_LABEL[method],
      entryId: entry.id,
      draftRepo: v?.draftRepo,
      embedded: v?.embedded,
    });
  }
  // Defensive: a text-only / no-variants entry still gets its default spec as an
  // option so the card can render (and resolve) something.
  const first = entries[0];
  if (options.length === 0 && first !== undefined && first.spec !== undefined) {
    options.push({ method: first.spec, label: VARIANT_LABEL[first.spec], entryId: first.id });
  }
  return options;
}

/** Collapse catalog entries into de-duplicated model groups (one card each). */
export function groupCatalog(entries: readonly LlmCatalogEntry[]): ModelGroup[] {
  const byKey = new Map<string, LlmCatalogEntry[]>();
  for (const entry of entries) {
    const key = baseModelName(entry.displayName);
    const arr = byKey.get(key);
    if (arr !== undefined) arr.push(entry);
    else byKey.set(key, [entry]);
  }
  const groups: ModelGroup[] = [];
  for (const [key, groupEntries] of byKey) {
    const primary = pickPrimary(groupEntries);
    groups.push({
      key,
      displayName: key,
      family: modelFamily(primary.displayName),
      entries: groupEntries,
      primary,
      variants: buildVariants(groupEntries),
      minRamGB: primary.minRamGB,
    });
  }
  return groups;
}

/** The default variant a group opens on: the primary's own spec when available,
 * else the first offered variant. */
export function defaultVariant(group: ModelGroup): SpecMethod {
  const spec = group.primary.spec;
  if (spec !== undefined && group.variants.some((v) => v.method === spec)) return spec;
  return group.variants[0]?.method ?? 'mtp';
}

/** Resolve a group + chosen variant method → the concrete catalog entry (repo)
 * its Download/Start acts on. */
export function variantEntry(group: ModelGroup, method: SpecMethod): LlmCatalogEntry {
  const opt = group.variants.find((v) => v.method === method);
  const id = opt?.entryId ?? group.primary.id;
  return group.entries.find((e) => e.id === id) ?? group.primary;
}

/** A family section for the categorized power-user view. */
export interface FamilySection {
  family: string;
  groups: ModelGroup[];
}

/** Categorize groups by model family, sorting models within a family by size
 * (RAM) and families by their smallest member — the power-user Recommended view. */
export function categorizeByFamily(groups: readonly ModelGroup[]): FamilySection[] {
  const byFamily = new Map<string, ModelGroup[]>();
  for (const group of groups) {
    const arr = byFamily.get(group.family);
    if (arr !== undefined) arr.push(group);
    else byFamily.set(group.family, [group]);
  }
  const sections: FamilySection[] = [];
  for (const [family, gs] of byFamily) {
    gs.sort((a, b) => a.minRamGB - b.minRamGB || a.displayName.localeCompare(b.displayName));
    sections.push({ family, groups: gs });
  }
  sections.sort(
    (a, b) =>
      (a.groups[0]?.minRamGB ?? 0) - (b.groups[0]?.minRamGB ?? 0) ||
      a.family.localeCompare(b.family),
  );
  return sections;
}

// ---------------------------------------------------------------------------
// Quant ladder — merge the entry's known quants with a live hf:list-files ladder
// ---------------------------------------------------------------------------

export interface QuantOption {
  quant: string;
  bytes: number;
}

/** Rough Q2…Q8 ordering key (UD-/IQ- prefixes keep their base digit). */
function quantRank(quant: string): number {
  const m = quant.match(/Q(\d)/i);
  return m !== null ? Number(m[1]) : 5;
}

/**
 * Merge a catalog entry's known quants (always present, offline) with a live
 * `hf:list-files` quant ladder (real Q2…Q8), deduped by quant label (live size
 * wins when known) and sorted low→high. Returns the base list unchanged when no
 * ladder was fetched, so the dropdown is deterministic without the network.
 */
export function mergeQuantLadder(
  base: readonly QuantOption[],
  fetched?: ReadonlyArray<{ quant?: string; sizeBytes?: number }>,
): QuantOption[] {
  const map = new Map<string, QuantOption>();
  for (const q of base) map.set(q.quant, { quant: q.quant, bytes: q.bytes });
  for (const f of fetched ?? []) {
    if (f.quant === undefined || f.quant.length === 0) continue;
    const existing = map.get(f.quant);
    map.set(f.quant, { quant: f.quant, bytes: f.sizeBytes ?? existing?.bytes ?? 0 });
  }
  return [...map.values()].sort(
    (a, b) => quantRank(a.quant) - quantRank(b.quant) || a.quant.localeCompare(b.quant),
  );
}
