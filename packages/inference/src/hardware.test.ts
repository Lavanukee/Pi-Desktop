import { describe, expect, it } from 'vitest';
import { detectHardware, parseHardware } from './hardware.js';

describe('parseHardware', () => {
  it('parses an Apple Silicon machine', () => {
    const hw = parseHardware(
      {
        memsize: String(24 * 1024 ** 3),
        brand: 'Apple M5 Pro',
        arm64: '1',
        logicalcpu: '12',
      },
      'arm64',
    );
    expect(hw.totalRamGB).toBe(24);
    expect(hw.chip).toBe('Apple M5 Pro');
    expect(hw.isAppleSilicon).toBe(true);
    expect(hw.metal).toBe(true);
    expect(hw.cpuCount).toBe(12);
  });

  it('degrades gracefully with missing values', () => {
    const hw = parseHardware({}, 'x64');
    expect(hw.totalRamGB).toBe(0);
    expect(hw.chip).toBeUndefined();
    expect(hw.isAppleSilicon).toBe(false);
    expect(hw.metal).toBe(false);
  });

  it('detectHardware drives an injected sysctl', async () => {
    const values: Record<string, string> = {
      'hw.memsize': String(32 * 1024 ** 3),
      'machdep.cpu.brand_string': 'Apple M4 Max',
      'hw.optional.arm64': '1',
      'hw.logicalcpu': '16',
    };
    const hw = await detectHardware({
      execFileImpl: async (_cmd, args) => ({
        stdout: `${values[args[1] ?? ''] ?? ''}\n`,
        stderr: '',
      }),
    });
    expect(hw.totalRamGB).toBe(32);
    expect(hw.chip).toBe('Apple M4 Max');
    expect(hw.isAppleSilicon).toBe(true);
  });
});
