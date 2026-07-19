/**
 * Parent-death watchdog for the llama-server child.
 *
 * The supervisor's graceful kill ladder (SIGTERM→SIGKILL) and the utilityProcess
 * signal/`exit` handlers only run when the parent gets a *chance* to run them. A
 * hard crash or `SIGKILL` of the parent (the inference utilityProcess, or the
 * Electron process that forked it) skips every handler, orphaning the
 * llama-server — it keeps the model pinned in RAM/VRAM after the app is gone
 * (the "9 orphans" the user just reaped). macOS has no `PR_SET_PDEATHSIG`, so we
 * cannot ask the kernel to signal the child on parent death.
 *
 * The fix is a tiny detached sidecar process that outlives the parent by design
 * and kills the tracked llama-server PID the instant its parent goes away. It
 * detects parent death two ways, either of which is sufficient:
 *
 *   1. **stdin pipe EOF (primary, immediate).** The sidecar is spawned with its
 *      stdin wired to a pipe whose write end the parent holds. The OS closes
 *      every fd when a process dies *for any reason, including SIGKILL*, so the
 *      write end closes → the sidecar reads EOF on stdin → it SIGKILLs the
 *      target. This is race-free: it fires exactly when the parent is gone.
 *   2. **reparenting poll (secondary, belt-and-suspenders).** After the parent
 *      dies the sidecar is reparented to init (`ppid === 1`); a 1s poll catches
 *      the transition in case the pipe path is somehow defeated.
 *
 * On a *graceful* teardown the parent calls {@link WatchdogHandle.stop}, which
 * sends `disarm` down the pipe and SIGKILLs the sidecar, so it exits WITHOUT
 * touching the target (the supervisor is already reaping it) — no PID-reuse race.
 *
 * The sidecar program is shipped as a self-contained source string run via
 * `execPath -e` (with `ELECTRON_RUN_AS_NODE=1` so an Electron `execPath` behaves
 * as Node). That needs no separate bundled file and no TS runtime — it survives
 * packaging. The spawn wiring is injectable so it unit-tests without real
 * processes, and the script itself is exercised end-to-end by an integration
 * test that orphans a real child and asserts it dies.
 */
import { type ChildProcess, spawn as spawnCb } from 'node:child_process';

/** A live watchdog guarding one llama-server PID. */
export interface WatchdogHandle {
  /**
   * Stand the watchdog down — the parent is handling teardown itself, so the
   * sidecar must NOT kill the target. Sends `disarm` then terminates the
   * sidecar. Idempotent and synchronous (safe from a `process.on('exit')`).
   */
  stop(): void;
}

/**
 * The self-contained sidecar program (plain, dependency-free JS run via
 * `execPath -e <script> <targetPid>`). Kills `targetPid` on parent death (stdin
 * EOF or reparent-to-init) unless it first reads `disarm` on stdin.
 *
 * Kept intentionally small and defensive: every listener funnels into a single
 * idempotent `reap()`, and nothing throws out of the process.
 */
export const WATCHDOG_SCRIPT = `'use strict';
var pid = parseInt(process.argv[process.argv.length - 1], 10);
var disarmed = false;
var done = false;
function reap() {
  if (done) return;
  done = true;
  if (!disarmed && pid > 0) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
  }
  try { process.exit(0); } catch (e) {}
}
var buf = '';
try {
  process.stdin.on('data', function (d) {
    buf += String(d);
    if (buf.indexOf('disarm') !== -1) { disarmed = true; reap(); }
  });
  process.stdin.on('end', reap);
  process.stdin.on('close', reap);
  process.stdin.on('error', reap);
  process.stdin.resume();
} catch (e) {}
var startPpid = process.ppid;
var timer = setInterval(function () {
  var p = process.ppid;
  if (p === 1 || (startPpid !== 1 && p !== startPpid)) reap();
}, 1000);
if (timer && timer.unref) timer.unref();
`;

/**
 * The macOS reaper as a POSIX-shell one-liner run via `/bin/sh -c <script> sh
 * <targetPid>`. Same contract as {@link WATCHDOG_SCRIPT} — kill `$1` on parent
 * death (stdin EOF) or reparent-to-init, UNLESS `disarm` is read first — but it
 * runs `/bin/sh` (bash, on macOS) instead of the Electron `execPath`. That's the
 * whole point: an `ELECTRON_RUN_AS_NODE` sidecar spawned from the inference
 * utilityProcess still flashed a bouncing dock icon each time a llama-server
 * started; a plain shell has no GUI layer, so nothing appears in the Dock.
 *
 * `read -t 1` (bash, which macOS `/bin/sh` is) gives BOTH signals in one loop
 * with no leaked background poller: EOF (rc 1) → the parent's pipe closed → kill;
 * timeout (rc > 128) → check ppid for the reparent case; a `disarm` line → exit
 * clean. stop() writes `disarm\n` WITH a newline, so the disarm read always
 * completes before any EOF, never mis-firing the kill.
 */
export const SHELL_WATCHDOG_SCRIPT = [
  't="$1"',
  'while :; do',
  '  IFS= read -r -t 1 line; rc=$?',
  '  if [ "$rc" -gt 128 ]; then',
  '    [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d " ")" = 1 ] && { kill -9 "$t" 2>/dev/null; break; }',
  '  elif [ "$rc" -ne 0 ]; then',
  '    kill -9 "$t" 2>/dev/null; break',
  '  else',
  '    case "$line" in *disarm*) break;; esac',
  '  fi',
  'done',
  'exit 0',
].join('\n');

export interface StartWatchdogOptions {
  /** The llama-server PID to SIGKILL when the parent dies. */
  readonly targetPid: number;
  /** Binary to run the sidecar with (default `process.execPath`). */
  readonly execPath?: string;
  /** Override the sidecar program (tests). Default {@link WATCHDOG_SCRIPT}. */
  readonly script?: string;
  /** Injectable spawn (tests). Default `node:child_process` spawn. */
  readonly spawnFn?: typeof spawnCb;
  /**
   * Set `ELECTRON_RUN_AS_NODE=1` so an Electron `execPath` runs the script as
   * Node (default true). Harmless under a real Node `execPath`, which ignores it.
   */
  readonly runAsNode?: boolean;
  /** Base environment for the sidecar (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Run the reaper as a plain `/bin/sh` process instead of the Electron
   * `execPath` (default: true on macOS). A shell has no GUI layer, so it never
   * shows a Dock icon — the fix for the bouncing "exec" app a llama-server start
   * used to spawn. Off-darwin defaults to the Node/Electron sidecar. Injectable
   * so tests exercise both strategies regardless of the host platform.
   */
  readonly useShellReaper?: boolean;
}

/**
 * Spawn a detached parent-death watchdog guarding `targetPid`. Returns a handle
 * whose {@link WatchdogHandle.stop} disarms and terminates it. The sidecar's
 * stdin is a pipe held open by THIS process; when this process dies, the pipe
 * EOFs and the sidecar SIGKILLs `targetPid`.
 */
export function startParentDeathWatchdog(opts: StartWatchdogOptions): WatchdogHandle {
  const spawn = opts.spawnFn ?? spawnCb;
  const useShell = opts.useShellReaper ?? process.platform === 'darwin';
  const baseEnv = opts.env ?? process.env;

  // On macOS the reaper runs as `/bin/sh` (no GUI → no Dock icon). Elsewhere it's
  // the Electron `execPath` as Node. Both share the SAME wiring below (detached,
  // stdin=death pipe) and the SAME stop() contract — only the program differs.
  let command: string;
  let args: readonly string[];
  let env: NodeJS.ProcessEnv;
  if (useShell) {
    command = '/bin/sh';
    // `sh -c <script> sh <pid>` → inside the script $0=sh, $1=<pid>.
    args = ['-c', opts.script ?? SHELL_WATCHDOG_SCRIPT, 'sh', String(opts.targetPid)];
    env = { ...baseEnv };
  } else {
    const runAsNode = opts.runAsNode ?? true;
    command = opts.execPath ?? process.execPath;
    args = ['-e', opts.script ?? WATCHDOG_SCRIPT, String(opts.targetPid)];
    env = runAsNode ? { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' } : { ...baseEnv };
  }

  const child: ChildProcess = spawn(command, args, {
    // Detached: its own session, so a signal to the parent's process group does
    // NOT hit the watchdog — it must survive the parent to do its job.
    detached: true,
    // stdin is the death-detection pipe; stdout/stderr are irrelevant.
    stdio: ['pipe', 'ignore', 'ignore'],
    env,
  });
  // Do not let the sidecar keep the parent's event loop alive; the stdin fd
  // stays OPEN (we never end it) until the parent process exits, which is the
  // signal the sidecar waits for.
  child.unref();
  try {
    // stdin is a Socket at runtime (has `unref`), but typed as Writable here.
    (child.stdin as { unref?: () => void } | null)?.unref?.();
  } catch {
    // no stdin (spawn failed) → stop() is a no-op below
  }

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        // `disarm` first (belt) then SIGKILL the sidecar (braces) — either alone
        // guarantees it never kills an already-handled target.
        child.stdin?.end('disarm\n');
      } catch {
        // stdin already closed/destroyed
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    },
  };
}
