/**
 * Tiny leveled, namespaced logger with no dependencies.
 * Sinks are injectable for tests and for routing (e.g. main-process file logs later).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface LogEntry {
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly namespace: string;
  readonly message: string;
  readonly args: readonly unknown[];
  readonly timestamp: number;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

export interface LoggerOptions {
  /** Overrides the global default level for this logger (and its children). */
  level?: LogLevel;
  sink?: LogSink;
}

export interface Logger {
  readonly namespace: string;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** Derives a logger namespaced `parent:child`, inheriting level and sink. */
  child(namespace: string): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

// `console` is host-provided in every runtime we target (Node, Electron, browsers),
// but is not part of the pure ES lib this package compiles against.
const hostConsole = (
  globalThis as unknown as {
    console: Record<'debug' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>;
  }
).console;

export const consoleSink: LogSink = {
  write(entry) {
    const time = new Date(entry.timestamp).toISOString();
    hostConsole[entry.level](`${time} [${entry.namespace}]`, entry.message, ...entry.args);
  },
};

let defaultLevel: LogLevel = 'info';

export function setDefaultLogLevel(level: LogLevel): void {
  defaultLevel = level;
}

export function getDefaultLogLevel(): LogLevel {
  return defaultLevel;
}

export function createLogger(namespace: string, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? consoleSink;

  function emit(level: Exclude<LogLevel, 'silent'>, message: string, args: unknown[]): void {
    const threshold = LEVEL_ORDER[options.level ?? defaultLevel];
    if (LEVEL_ORDER[level] < threshold) return;
    sink.write({ level, namespace, message, args, timestamp: Date.now() });
  }

  return {
    namespace,
    debug: (message, ...args) => emit('debug', message, args),
    info: (message, ...args) => emit('info', message, args),
    warn: (message, ...args) => emit('warn', message, args),
    error: (message, ...args) => emit('error', message, args),
    child: (sub) => createLogger(`${namespace}:${sub}`, options),
  };
}
