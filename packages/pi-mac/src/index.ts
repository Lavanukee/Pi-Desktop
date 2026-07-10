/**
 * @pi-desktop/pi-mac — the Mac computer-use bridge helper.
 *
 * A Swift `pi-mac` CLI (indexed Accessibility-tree snapshot + CGEvent
 * click/type/key/scroll + a TCC status probe) plus this electron-free Node
 * wrapper: `checkTcc` (the capability gate) and `MacHelperClient` (the long-
 * lived `--serve` NDJSON client Electron main drives). The desktop app injects
 * the bundle-relative helper path; nothing here imports electron.
 */
export { type CheckTccOptions, checkTcc, parseCheckLine } from './check.js';
export {
  buildHelper,
  devHelperPath,
  helperPath,
  swiftDir,
} from './helper-path.js';
export { MacHelperClient, type MacHelperClientOptions } from './serve-client.js';
export {
  defaultSpawn,
  type MacChildProcess,
  type MacReadable,
  type MacSpawnFn,
  type MacWritable,
} from './spawn.js';
export type { TccStatus } from './types.js';
