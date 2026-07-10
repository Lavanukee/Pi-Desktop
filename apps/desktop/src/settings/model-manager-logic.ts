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
