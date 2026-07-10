import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeImport,
  parseClaudeMcpServers,
  parseClaudeTheme,
  parseClaudeWindowState,
} from './claude';

function fixture(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), 'utf8');
}

const mcpConfig = fixture('claude/claude_desktop_config.json');
const themeConfig = fixture('claude/config.json');
const windowState = fixture('claude/window-state.json');

describe('parseClaudeMcpServers', () => {
  it('reads command/args/env and drops servers without a command', () => {
    const servers = parseClaudeMcpServers(mcpConfig);
    expect(servers.map((s) => s.name)).toEqual(['filesystem', 'github']);
    const github = servers.find((s) => s.name === 'github');
    expect(github?.command).toBe('docker');
    expect(github?.env).toEqual({ GITHUB_TOKEN: 'user-provided-server-secret' });
    const fs = servers.find((s) => s.name === 'filesystem');
    expect(fs?.env).toBeUndefined();
    expect(fs?.args).toContain('@modelcontextprotocol/server-filesystem');
  });

  it('returns [] for missing block or invalid JSON', () => {
    expect(parseClaudeMcpServers('{}')).toEqual([]);
    expect(parseClaudeMcpServers('not json')).toEqual([]);
  });
});

describe('parseClaudeTheme (no-token guarantee)', () => {
  it('extracts only userThemeMode', () => {
    expect(parseClaudeTheme(themeConfig)).toEqual({ themeMode: 'dark' });
  });

  it('never surfaces oauth / cache token blobs', () => {
    const result = parseClaudeTheme(themeConfig);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/oauth/i);
    expect(serialized).not.toContain('SECRET');
    expect(Object.keys(result)).toEqual(['themeMode']);
  });

  it('null when userThemeMode is absent or invalid', () => {
    expect(parseClaudeTheme('{}').themeMode).toBeNull();
    expect(parseClaudeTheme('{"userThemeMode":"neon"}').themeMode).toBeNull();
  });
});

describe('parseClaudeWindowState', () => {
  it('reads bounds', () => {
    expect(parseClaudeWindowState(windowState).bounds).toEqual({
      width: 1200,
      height: 800,
      x: 156,
      y: 67,
      isMaximized: false,
      isFullScreen: false,
    });
  });

  it('null when width/height missing', () => {
    expect(parseClaudeWindowState('{"x":1}').bounds).toBeNull();
    expect(parseClaudeWindowState('nope').bounds).toBeNull();
  });
});

describe('buildClaudeImport', () => {
  it('assembles all three files and tolerates nulls', () => {
    const full = buildClaudeImport({ mcpConfig, themeConfig, windowState });
    expect(full.mcpServers).toHaveLength(2);
    expect(full.theme.themeMode).toBe('dark');
    expect(full.window.bounds?.width).toBe(1200);

    const empty = buildClaudeImport({ mcpConfig: null, themeConfig: null, windowState: null });
    expect(empty).toEqual({
      mcpServers: [],
      theme: { themeMode: null },
      window: { bounds: null },
    });
  });
});
