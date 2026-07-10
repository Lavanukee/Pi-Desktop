/**
 * Importer + onboarding IPC contract. Composed into the app-wide maps in
 * ../ipc-contract.ts. Type-only imports from @pi-desktop/importers keep the
 * importers runtime out of the sandboxed preload bundle (only the main-process
 * handler in ./import-main.ts pulls it in).
 *
 * These channels read Claude/Codex config off disk and write pi sessions / the
 * MCP registry, so they are trusted-sender gated exactly like the other app
 * channels (registered via registerImportIpc with the shared allowSender).
 */
import type {
  ClaudeImport,
  CodexConfigImport,
  CodexSessionIndexEntry,
  DetectResult,
  ImportedMcpServer,
} from '@pi-desktop/importers';

/** config.toml import plus the `~/.codex/skills` directory listing. */
export interface CodexConfigImportResult extends CodexConfigImport {
  skills: string[];
}

/** One picker row: the cheap session_index entry + its resolved rollout file. */
export interface CodexSessionListEntry extends CodexSessionIndexEntry {
  /** Absolute rollout JSONL path (always inside ~/.codex/sessions). */
  file: string;
}

/** The four generation pillars offered at onboarding (installs deferred). */
export interface GenerationCapabilities {
  image: boolean;
  video: boolean;
  audio: boolean;
  threeD: boolean;
}

/** Everything the wizard persists — read back at boot to skip the wizard. */
export interface OnboardingChoices {
  source: 'claude' | 'codex' | 'neither';
  imports: { mcp: boolean; theme: boolean; sessions: boolean; skills: boolean };
  theme: { flavor: 'claude' | 'codex'; mode: 'dark' | 'light' };
  experience: 'new' | 'knows-llamacpp' | 'no-tutorial';
  /** Derived from `experience`; gates the in-app tutorial. */
  tutorial: boolean;
  /** Derived from `experience`; the pi permission mode the harness starts in. */
  permissionMode: 'review-all' | 'reviewer' | 'bypass';
  capabilities: GenerationCapabilities;
  /** How many Codex sessions were converted into pi sessions. */
  importedSessionCount: number;
}

export interface OnboardingState {
  firstRunComplete: boolean;
  choices: OnboardingChoices | null;
}

export type ImportInvokeMap = {
  /** Which of Claude / Codex have config present. */
  'import:detect': { request: undefined; response: DetectResult };
  /** Claude mcpServers + theme mode + window bounds (never auth tokens). */
  'import:claude': { request: undefined; response: ClaudeImport };
  /** Codex config.toml + skills listing. */
  'import:codex-config': { request: undefined; response: CodexConfigImportResult };
  /** The session_index picker rows, resolved to their rollout files. */
  'import:codex-sessions-list': { request: undefined; response: CodexSessionListEntry[] };
  /** Convert the selected rollout files → pi session v3 files under ~/.pi/agent/sessions. */
  'import:codex-session-convert': {
    request: { files: string[] };
    response: { written: number; targets: string[]; errors: string[] };
  };
  /** Merge imported MCP servers into the mcp-lite registry (~/.pi/desktop/mcp-connectors.json). */
  'import:apply-mcp': {
    request: { servers: ImportedMcpServer[] };
    response: { applied: number; registryPath: string };
  };
  /** Copy the selected Codex skills into ~/.pi/agent/skills. */
  'import:apply-skills': {
    request: { names: string[] };
    response: { applied: number; errors: string[] };
  };
  /** First-run gate: whether onboarding is complete + the persisted choices. */
  'onboarding:get-state': { request: undefined; response: OnboardingState };
  /** Persist the wizard result + mark first-run complete. */
  'onboarding:complete': { request: { choices: OnboardingChoices }; response: { ok: boolean } };
};

export const IMPORT_INVOKE_CHANNELS = [
  'import:detect',
  'import:claude',
  'import:codex-config',
  'import:codex-sessions-list',
  'import:codex-session-convert',
  'import:apply-mcp',
  'import:apply-skills',
  'onboarding:get-state',
  'onboarding:complete',
] as const satisfies readonly (keyof ImportInvokeMap)[];
