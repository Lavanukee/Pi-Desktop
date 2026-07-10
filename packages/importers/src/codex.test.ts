import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCodexConfig, parseCodexSessionIndex } from './codex';

function fixture(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), 'utf8');
}

describe('parseCodexConfig', () => {
  const config = parseCodexConfig(fixture('codex/config.toml'));

  it('reads model + reasoning effort', () => {
    expect(config.model).toBe('gpt-5.6-luna');
    expect(config.reasoningEffort).toBe('low');
  });

  it('lists plugins with their enabled flag', () => {
    expect(config.plugins).toContainEqual({ id: 'computer-use@openai-bundled', enabled: true });
    expect(config.plugins).toContainEqual({ id: 'legacy@openai-bundled', enabled: false });
  });

  it('keeps only trusted projects', () => {
    expect(config.trustedProjects).toEqual(['/Users/test/Documents/Codex/project-a']);
  });

  it('imports enabled mcp servers with env, skips disabled ones', () => {
    expect(config.mcpServers.map((s) => s.name)).toEqual(['node_repl']);
    expect(config.mcpServers[0]?.env).toEqual({ CODEX_HOME: '/Users/test/.codex' });
  });

  it('returns empty shape on invalid toml', () => {
    expect(parseCodexConfig('= = broken')).toEqual({
      model: null,
      reasoningEffort: null,
      plugins: [],
      trustedProjects: [],
      mcpServers: [],
    });
  });
});

describe('parseCodexSessionIndex', () => {
  it('parses valid rows, skips blanks/malformed, sorts newest first', () => {
    const rows = parseCodexSessionIndex(fixture('codex/session_index.jsonl'));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.threadName).toBe('Refactor trajectory simulation');
    expect(rows.map((r) => r.id)).not.toContain(undefined);
    expect((rows[0]?.updatedAt ?? '') >= (rows[1]?.updatedAt ?? '')).toBe(true);
  });
});
