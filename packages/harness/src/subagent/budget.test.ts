import { describe, expect, it } from 'vitest';
import { computeConcurrencyBudget, detectBudget, LOW_RAM_GB } from './budget.js';

describe('computeConcurrencyBudget', () => {
  it('scales concurrency with RAM and cores, capped by the hard cap', () => {
    const b = computeConcurrencyBudget({ totalRamGB: 64, cpuCount: 12, hasUtilityModel: true });
    // 64 GB - 4 reserve = 60 GB / 1.5 = 40 by RAM; 11 by cpu; hardCap 4 wins.
    expect(b.maxConcurrency).toBe(4);
    expect(b.ramBudgetGB).toBe(60);
    expect(b.perAgentGB).toBe(1.5);
  });

  it('is bounded by CPU count (leaves one core for the parent)', () => {
    const b = computeConcurrencyBudget({
      totalRamGB: 64,
      cpuCount: 3,
      hasUtilityModel: true,
      hardCap: 10,
    });
    expect(b.maxConcurrency).toBe(2); // cpuCount - 1
  });

  it('is bounded by RAM when RAM is the scarce resource', () => {
    const b = computeConcurrencyBudget({
      totalRamGB: 16,
      cpuCount: 16,
      hasUtilityModel: true,
      hardCap: 10,
      perAgentGB: 4,
    });
    // (16 - 4) / 4 = 3 by RAM; cpu 15; hardCap 10 → 3.
    expect(b.maxConcurrency).toBe(3);
  });

  it('collapses to 1 with no utility model (conservative default)', () => {
    const b = computeConcurrencyBudget({ totalRamGB: 64, cpuCount: 16, hasUtilityModel: false });
    expect(b.maxConcurrency).toBe(1);
    expect(b.reason).toMatch(/no utility model/i);
  });

  it('collapses to 1 on a low-RAM host', () => {
    const b = computeConcurrencyBudget({
      totalRamGB: LOW_RAM_GB,
      cpuCount: 16,
      hasUtilityModel: true,
    });
    expect(b.maxConcurrency).toBe(1);
    expect(b.reason).toMatch(/low ram/i);
  });

  it('collapses to 1 on a single-core host', () => {
    const b = computeConcurrencyBudget({ totalRamGB: 64, cpuCount: 1, hasUtilityModel: true });
    expect(b.maxConcurrency).toBe(1);
    expect(b.reason).toMatch(/single/i);
  });

  it('always allows at least one subagent (unknown host)', () => {
    const b = computeConcurrencyBudget({ totalRamGB: 0, cpuCount: 0, hasUtilityModel: true });
    expect(b.maxConcurrency).toBe(1);
    expect(b.ramBudgetGB).toBeGreaterThanOrEqual(b.perAgentGB);
  });
});

describe('detectBudget', () => {
  it('uses the injected host probe over node:os', () => {
    const b = detectBudget({
      hasUtilityModel: true,
      probe: { totalRamGB: 32, cpuCount: 8 },
    });
    expect(b.maxConcurrency).toBe(4); // hardCap
  });

  it('degrades to 1 when no utility model regardless of a beefy probe', () => {
    const b = detectBudget({
      hasUtilityModel: false,
      probe: { totalRamGB: 128, cpuCount: 32 },
    });
    expect(b.maxConcurrency).toBe(1);
  });
});
