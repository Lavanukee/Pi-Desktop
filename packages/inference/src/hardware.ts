/**
 * macOS hardware detection via `sysctl`, used to size model recommendations.
 *
 * Pure parsing (`parseHardware`) is separated from the `sysctl` spawn so it
 * unit-tests without a subprocess. Electron-free.
 */
import { execFile as execFileCb } from 'node:child_process';
import { arch, platform } from 'node:os';
import { promisify } from 'node:util';
import type { ExecFileFn } from './llamacpp-manager.js';

const execFile = promisify(execFileCb);

export interface HardwareInfo {
  /** Physical RAM in GiB, rounded to the nearest whole GB. */
  readonly totalRamGB: number;
  /** Chip brand string, e.g. "Apple M5 Pro"; undefined if unknown. */
  readonly chip: string | undefined;
  readonly isAppleSilicon: boolean;
  /** Metal GPU available (true on Apple Silicon Macs). */
  readonly metal: boolean;
  /** Logical CPU count, if known. */
  readonly cpuCount: number | undefined;
}

export interface SysctlValues {
  /** `hw.memsize` — total RAM in bytes. */
  readonly memsize?: string;
  /** `machdep.cpu.brand_string`. */
  readonly brand?: string;
  /** `hw.optional.arm64` — "1" on Apple Silicon. */
  readonly arm64?: string;
  /** `hw.logicalcpu`. */
  readonly logicalcpu?: string;
}

/** Pure: derive {@link HardwareInfo} from raw sysctl strings + os fallbacks. */
export function parseHardware(v: SysctlValues, osArch: string = arch()): HardwareInfo {
  const bytes = Number(v.memsize);
  const totalRamGB = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 ** 3) : 0;
  const isAppleSilicon = v.arm64 === '1' || osArch === 'arm64';
  const cpu = Number(v.logicalcpu);
  return {
    totalRamGB,
    chip: v.brand !== undefined && v.brand.length > 0 ? v.brand : undefined,
    isAppleSilicon,
    metal: isAppleSilicon,
    cpuCount: Number.isFinite(cpu) && cpu > 0 ? cpu : undefined,
  };
}

async function sysctl(key: string, exec: ExecFileFn): Promise<string | undefined> {
  try {
    const { stdout } = await exec('sysctl', ['-n', key], { timeout: 5000 });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect the host hardware. On non-macOS hosts (CI Linux) `sysctl` is absent,
 * so the fields degrade gracefully (RAM 0, not Apple Silicon).
 */
export async function detectHardware(
  opts: { execFileImpl?: ExecFileFn } = {},
): Promise<HardwareInfo> {
  const exec = opts.execFileImpl ?? execFile;
  if (platform() !== 'darwin' && opts.execFileImpl === undefined) {
    return parseHardware({});
  }
  const [memsize, brand, arm64, logicalcpu] = await Promise.all([
    sysctl('hw.memsize', exec),
    sysctl('machdep.cpu.brand_string', exec),
    sysctl('hw.optional.arm64', exec),
    sysctl('hw.logicalcpu', exec),
  ]);
  return parseHardware({ memsize, brand, arm64, logicalcpu });
}
