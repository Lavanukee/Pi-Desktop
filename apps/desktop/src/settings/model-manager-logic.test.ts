import { describe, expect, it } from 'vitest';
import {
  displaySizeBytes,
  formatBytes,
  formatSpeed,
  percent,
  ramVerdict,
  selectedQuant,
} from './model-manager-logic';

describe('ramVerdict', () => {
  it('unknown RAM (0) is neutral and states the requirement', () => {
    const v = ramVerdict(16, 0);
    expect(v.tone).toBe('default');
    expect(v.fits).toBe(true);
    expect(v.label).toContain('16 GB');
  });

  it('insufficient RAM is danger + does not fit', () => {
    expect(ramVerdict(32, 16)).toEqual({ tone: 'danger', label: 'Needs more RAM', fits: false });
  });

  it('a tight-but-adequate fit is a warning', () => {
    // 18 total, needs 16 → 2 GB headroom (< 4) → tight.
    expect(ramVerdict(16, 18)).toEqual({ tone: 'warning', label: 'Tight fit', fits: true });
  });

  it('comfortable headroom is success', () => {
    expect(ramVerdict(16, 32)).toEqual({ tone: 'success', label: 'Fits comfortably', fits: true });
  });

  it('exact minimum counts as a (tight) fit, not insufficient', () => {
    expect(ramVerdict(16, 16).fits).toBe(true);
    expect(ramVerdict(16, 16).tone).toBe('warning');
  });
});

describe('formatBytes', () => {
  it('formats GB with one decimal under 10, none at/above', () => {
    expect(formatBytes(2.53e9)).toBe('2.5 GB');
    expect(formatBytes(24e9)).toBe('24 GB');
  });
  it('falls back to MB under a GB', () => {
    expect(formatBytes(700e6)).toBe('700 MB');
  });
  it('renders a dash for unknown/zero sizes', () => {
    expect(formatBytes(0)).toBe('—');
  });
});

describe('formatSpeed', () => {
  it('MB/s above a megabyte, KB/s below, empty for null/zero', () => {
    expect(formatSpeed(12.4e6)).toBe('12.4 MB/s');
    expect(formatSpeed(500e3)).toBe('500 KB/s');
    expect(formatSpeed(null)).toBe('');
    expect(formatSpeed(0)).toBe('');
  });
});

describe('percent', () => {
  it('rounds + clamps a 0..1 fraction, passes null through', () => {
    expect(percent(0.256)).toBe(26);
    expect(percent(1.4)).toBe(100);
    expect(percent(-0.2)).toBe(0);
    expect(percent(null)).toBeNull();
  });
});

describe('selectedQuant / displaySizeBytes', () => {
  const entry = {
    quants: [
      { quant: 'Q4_K_M', bytes: 2e9 },
      { quant: 'Q6_K', bytes: 3e9 },
    ],
  };
  it('picks the named quant, else the first', () => {
    expect(selectedQuant(entry, 'Q6_K')?.bytes).toBe(3e9);
    expect(selectedQuant(entry)?.quant).toBe('Q4_K_M');
    expect(selectedQuant(entry, 'nope')?.quant).toBe('Q4_K_M');
  });
  it('displaySizeBytes uses the selected quant size', () => {
    const full = { ...entry, id: 'x', displayName: 'X' } as never;
    expect(displaySizeBytes(full, 'Q6_K')).toBe(3e9);
  });
});
