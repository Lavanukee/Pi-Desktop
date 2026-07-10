/**
 * Shared importer types. Everything here is JSON-serializable so the electron
 * IPC layer can hand these straight to the renderer.
 */
import type { SessionEntry, SessionHeader } from '@pi-desktop/engine';

/** A migrated MCP server definition, source-app agnostic. Auth-bearing `env`
 * values belong to the user's OWN server config and are migrated intentionally;
 * the importers never touch the source apps' auth-token caches (see the
 * no-token guarantee in claude.ts / the codex config parser). */
export interface ImportedMcpServer {
  /** Server name as declared in the source app's config. */
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// ── Claude ──────────────────────────────────────────────────────────────────

export type ClaudeThemeMode = 'light' | 'dark' | 'system';

export interface ClaudeThemeImport {
  /** `userThemeMode` from Claude's config.json, or null when absent. */
  themeMode: ClaudeThemeMode | null;
}

export interface ClaudeWindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
  isFullScreen: boolean;
}

export interface ClaudeWindowStateImport {
  bounds: ClaudeWindowBounds | null;
}

export interface ClaudeImport {
  mcpServers: ImportedMcpServer[];
  theme: ClaudeThemeImport;
  window: ClaudeWindowStateImport;
}

// ── Codex ───────────────────────────────────────────────────────────────────

export interface CodexPlugin {
  /** e.g. `browser@openai-bundled`. */
  id: string;
  enabled: boolean;
}

export interface CodexConfigImport {
  model: string | null;
  reasoningEffort: string | null;
  plugins: CodexPlugin[];
  /** Absolute paths Codex has marked `trust_level = "trusted"`. */
  trustedProjects: string[];
  mcpServers: ImportedMcpServer[];
}

/** One row of `~/.codex/session_index.jsonl` — the cheap import picker source. */
export interface CodexSessionIndexEntry {
  id: string;
  threadName: string;
  updatedAt: string;
}

/** Result of converting one Codex rollout JSONL into a pi session v3 file. */
export interface ConvertedCodexSession {
  /** Codex session id (also the pi session id + filename stem). */
  sessionId: string;
  /** Working directory the session ran in (drives the pi sessions folder). */
  cwd: string;
  /** ISO start timestamp (session_meta.timestamp). */
  startedAt: string;
  /** Count of user + assistant turns (for the picker summary). */
  messageCount: number;
  header: SessionHeader;
  entries: SessionEntry[];
  /** Fully serialized pi session v3 file content (header + entries, newline-joined). */
  jsonl: string;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/** Injectable existence check so detection is unit-testable without a disk. */
export interface DetectFs {
  fileExists(path: string): boolean;
}

export interface DetectOptions {
  home: string;
  fs: DetectFs;
}

export interface DetectedSource {
  installed: boolean;
  /** The config path that was probed (surfaced for diagnostics/UI). */
  configPath: string;
}

export interface DetectResult {
  claude: DetectedSource;
  codex: DetectedSource;
}
