/**
 * Structural slice of `child_process.ChildProcess` + an injectable spawn fn, so
 * both `checkAvailability` and `streamAfm` unit-test in plain Node with a fake
 * child — no real `pi-afm` binary required (mirrors inference/supervisor.ts and
 * engine/pi-bridge.ts).
 */
import { spawn as nodeSpawn } from 'node:child_process';

/** The minimal stream surface we read from the child's stdout/stderr. */
export interface AfmReadable {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
}

/** The minimal stdin surface we write the request to. */
export interface AfmWritable {
  write(data: string, cb?: (err?: Error | null) => void): void;
  end(): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** Structural child so tests inject a fake without spawning anything. */
export interface AfmChildProcess {
  readonly pid?: number;
  stdin: AfmWritable | null;
  stdout: AfmReadable | null;
  stderr: AfmReadable | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** Spawn signature the wrapper depends on; defaults to node:child_process. */
export type AfmSpawnFn = (command: string, args: readonly string[]) => AfmChildProcess;

/** Real spawn with piped stdio, adapted to {@link AfmChildProcess}. */
export const defaultSpawn: AfmSpawnFn = (command, args) =>
  nodeSpawn(command, args as string[], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as AfmChildProcess;
