/**
 * Source-app detection: which of Claude / Codex have config present. Pure over
 * an injected existence check so it is unit-testable without touching a disk.
 */
import { claudePaths, codexPaths } from './paths';
import type { DetectOptions, DetectResult } from './types';

export function detectInstalledSources({ home, fs }: DetectOptions): DetectResult {
  const claude = claudePaths(home);
  const codex = codexPaths(home);
  return {
    claude: {
      // Either file present is enough to say "Claude is here" — a user may have
      // theme config without ever having added an MCP server, or vice versa.
      installed: fs.fileExists(claude.themeConfig) || fs.fileExists(claude.mcpConfig),
      configPath: claude.base,
    },
    codex: {
      installed: fs.fileExists(codex.config),
      configPath: codex.config,
    },
  };
}
