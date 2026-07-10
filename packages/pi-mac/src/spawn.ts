/**
 * Structural slice of `child_process.ChildProcess` + an injectable spawn fn, so
 * both `checkTcc` and `MacHelperClient` unit-test in plain Node with a fake
 * child — no real `pi-mac` binary required (mirrors @pi-desktop/afm's spawn.ts).
 */
import { spawn as nodeSpawn } from 'node:child_process';

/** The minimal stream surface we read from the child's stdout/stderr. */
export interface MacReadable {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
}

/** The minimal stdin surface we write requests to. */
export interface MacWritable {
  write(data: string, cb?: (err?: Error | null) => void): void;
  end(): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** Structural child so tests inject a fake without spawning anything. */
export interface MacChildProcess {
  readonly pid?: number;
  stdin: MacWritable | null;
  stdout: MacReadable | null;
  stderr: MacReadable | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** Spawn signature the wrapper depends on; defaults to node:child_process. */
export type MacSpawnFn = (command: string, args: readonly string[]) => MacChildProcess;

/** Real spawn with piped stdio, adapted to {@link MacChildProcess}. */
export const defaultSpawn: MacSpawnFn = (command, args) =>
  nodeSpawn(command, args as string[], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as MacChildProcess;
