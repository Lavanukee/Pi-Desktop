import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  getDefaultLogLevel,
  type LogEntry,
  type LogSink,
  setDefaultLogLevel,
} from './logger';

function createMemorySink(): { entries: LogEntry[] } & LogSink {
  const entries: LogEntry[] = [];
  return {
    entries,
    write(entry) {
      entries.push(entry);
    },
  };
}

const initialLevel = getDefaultLogLevel();
afterEach(() => setDefaultLogLevel(initialLevel));

describe('createLogger', () => {
  it('writes namespace, level, message, and args to the sink', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1234);
    const sink = createMemorySink();
    const log = createLogger('engine', { level: 'debug', sink });

    log.warn('slow response', { ms: 900 });

    expect(sink.entries).toEqual([
      {
        level: 'warn',
        namespace: 'engine',
        message: 'slow response',
        args: [{ ms: 900 }],
        timestamp: 1234,
      },
    ]);
    vi.useRealTimers();
  });

  it('filters entries below the configured level', () => {
    const sink = createMemorySink();
    const log = createLogger('x', { level: 'warn', sink });

    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes');

    expect(sink.entries.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('silent suppresses everything', () => {
    const sink = createMemorySink();
    const log = createLogger('x', { level: 'silent', sink });
    log.error('nope');
    expect(sink.entries).toEqual([]);
  });

  it('uses the mutable global default level when none is set', () => {
    const sink = createMemorySink();
    const log = createLogger('x', { sink });

    log.debug('hidden at default info');
    setDefaultLogLevel('debug');
    log.debug('visible now');

    expect(sink.entries.map((e) => e.message)).toEqual(['visible now']);
  });

  it('child loggers extend the namespace and inherit options', () => {
    const sink = createMemorySink();
    const log = createLogger('desktop', { level: 'debug', sink });

    log.child('main').child('ipc').debug('hello');

    expect(sink.entries[0]?.namespace).toBe('desktop:main:ipc');
  });
});
