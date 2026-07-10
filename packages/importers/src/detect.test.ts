import { describe, expect, it } from 'vitest';
import { detectInstalledSources } from './detect';
import { claudePaths, codexPaths, encodePiSessionFolder } from './paths';

const HOME = '/Users/test';

function fsWith(present: string[]) {
  const set = new Set(present);
  return { fileExists: (p: string) => set.has(p) };
}

describe('detectInstalledSources', () => {
  it('detects Claude via either config file', () => {
    const paths = claudePaths(HOME);
    expect(
      detectInstalledSources({ home: HOME, fs: fsWith([paths.themeConfig]) }).claude.installed,
    ).toBe(true);
    expect(
      detectInstalledSources({ home: HOME, fs: fsWith([paths.mcpConfig]) }).claude.installed,
    ).toBe(true);
  });

  it('detects Codex via config.toml', () => {
    const paths = codexPaths(HOME);
    expect(detectInstalledSources({ home: HOME, fs: fsWith([paths.config]) }).codex.installed).toBe(
      true,
    );
  });

  it('reports neither when nothing is present', () => {
    const result = detectInstalledSources({ home: HOME, fs: fsWith([]) });
    expect(result.claude.installed).toBe(false);
    expect(result.codex.installed).toBe(false);
  });
});

describe('encodePiSessionFolder', () => {
  it('matches pi 0.68.1 on-disk folder names (double-dashed both ends)', () => {
    expect(encodePiSessionFolder('/Users/jedd')).toBe('--Users-jedd--');
    expect(encodePiSessionFolder('/Users/jedd/Desktop')).toBe('--Users-jedd-Desktop--');
    expect(encodePiSessionFolder('/Users/jedd/Desktop/OSS-harness')).toBe(
      '--Users-jedd-Desktop-OSS-harness--',
    );
  });

  it('is idempotent to a trailing slash', () => {
    expect(encodePiSessionFolder('/Users/jedd/Desktop/')).toBe('--Users-jedd-Desktop--');
  });
});
