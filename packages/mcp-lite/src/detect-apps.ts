/**
 * Connector app detection — scans installed apps / running processes for signs
 * of known MCP connectors and returns gallery suggestions.
 *
 * The scan environment is injected ({@link DetectAppsEnv}) so {@link detectApps}
 * is pure and unit-tests against fixtures. {@link nodeDetectAppsEnv} provides the
 * macOS-backed implementation (reads /Applications, runs `ps`). Full-disk access
 * is assumed already granted by the app, so no extra prompts here.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { McpMode, McpServerConfig } from './registry';

/** A connector we know how to detect and pre-fill a config for. */
export interface KnownConnector {
  id: string;
  name: string;
  icon: string;
  description: string;
  homepage?: string;
  /** macOS app bundle names that imply this connector is relevant. */
  appBundles?: string[];
  /** Process (comm) names that imply this connector is relevant. */
  processNames?: string[];
  /** Env vars the user must supply (e.g. tokens) before the server will run. */
  requiresEnv?: string[];
  /** Ready-to-add config template; command/args/env may still need user edits. */
  template: Omit<McpServerConfig, 'enabled'> & { mode?: McpMode };
}

/** A known connector annotated with whether it was detected on this machine. */
export interface ConnectorSuggestion extends KnownConnector {
  detected: boolean;
  /** Why it was (or wasn't) detected — shown in the gallery. */
  reason: string;
}

/** Injected scan surface so detection is deterministic in tests. */
export interface DetectAppsEnv {
  /** Names of entries in the applications directory (e.g. "Slack.app"). */
  listApps(): string[];
  /** Running process command names (e.g. from `ps -A -o comm=`). */
  listProcesses(): string[];
  /** Whether an executable resolves on PATH. */
  hasCommand(command: string): boolean;
}

/**
 * The built-in connector catalog. This is the data the gallery renders as its
 * "+" button grid; detection just annotates which cards to highlight.
 */
export const KNOWN_CONNECTORS: KnownConnector[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    icon: '📁',
    description: 'Read and write files under an allowed directory.',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    template: {
      id: 'filesystem',
      name: 'Filesystem',
      icon: '📁',
      description: 'Read and write files under an allowed directory.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '<ALLOWED_DIR>'],
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    description: 'Search repos, read code, and manage issues/PRs.',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    processNames: ['GitHub Desktop'],
    appBundles: ['GitHub Desktop.app'],
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    template: {
      id: 'github',
      name: 'GitHub',
      icon: '🐙',
      description: 'Search repos, read code, and manage issues/PRs.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    },
  },
  {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    description: 'Read and post to Slack channels.',
    appBundles: ['Slack.app'],
    processNames: ['Slack'],
    requiresEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    template: {
      id: 'slack',
      name: 'Slack',
      icon: '💬',
      description: 'Read and post to Slack channels.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
    },
  },
  {
    id: 'postgres',
    name: 'Postgres',
    icon: '🐘',
    description: 'Query a Postgres database read-only.',
    appBundles: ['Postgres.app'],
    processNames: ['postgres'],
    template: {
      id: 'postgres',
      name: 'Postgres',
      icon: '🐘',
      description: 'Query a Postgres database read-only.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', '<CONNECTION_STRING>'],
    },
  },
  {
    id: 'blender',
    name: 'Blender',
    icon: '🎨',
    description: 'Drive Blender scenes and rendering over MCP.',
    appBundles: ['Blender.app'],
    processNames: ['Blender'],
    template: {
      id: 'blender',
      name: 'Blender',
      icon: '🎨',
      description: 'Drive Blender scenes and rendering over MCP.',
      command: 'uvx',
      args: ['blender-mcp'],
    },
  },
  {
    id: 'puppeteer',
    name: 'Browser (Puppeteer)',
    icon: '🌐',
    description: 'Automate a headless Chromium browser.',
    appBundles: ['Google Chrome.app', 'Chromium.app'],
    processNames: ['Google Chrome'],
    template: {
      id: 'puppeteer',
      name: 'Browser (Puppeteer)',
      icon: '🌐',
      description: 'Automate a headless Chromium browser.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    },
  },
];

/** Case-insensitive substring match against a list. */
function anyMatch(needles: string[] | undefined, haystack: string[]): boolean {
  if (!needles || needles.length === 0) return false;
  const lower = haystack.map((h) => h.toLowerCase());
  return needles.some((n) => {
    const needle = n.toLowerCase();
    return lower.some((h) => h.includes(needle));
  });
}

/**
 * Annotate the known-connector catalog with detection results for this machine.
 * Pure over the injected {@link DetectAppsEnv}.
 */
export function detectApps(
  env: DetectAppsEnv,
  catalog: KnownConnector[] = KNOWN_CONNECTORS,
): ConnectorSuggestion[] {
  const apps = env.listApps();
  const procs = env.listProcesses();
  return catalog.map((c) => {
    const byApp = anyMatch(c.appBundles, apps);
    const byProc = anyMatch(c.processNames, procs);
    const detected = byApp || byProc;
    let reason: string;
    if (byApp) {
      const hit = c.appBundles?.find((b) =>
        apps.some((a) => a.toLowerCase().includes(b.toLowerCase())),
      );
      reason = `${hit ?? 'app'} is installed`;
    } else if (byProc) {
      const hit = c.processNames?.find((p) =>
        procs.some((a) => a.toLowerCase().includes(p.toLowerCase())),
      );
      reason = `${hit ?? 'process'} is running`;
    } else {
      reason = 'not detected';
    }
    return { ...c, detected, reason };
  });
}

/** Only the connectors that were detected, most-relevant first. */
export function detectedSuggestions(
  env: DetectAppsEnv,
  catalog: KnownConnector[] = KNOWN_CONNECTORS,
): ConnectorSuggestion[] {
  return detectApps(env, catalog).filter((s) => s.detected);
}

/** macOS-backed scan environment. Failures degrade to empty lists. */
export function nodeDetectAppsEnv(applicationsDir = '/Applications'): DetectAppsEnv {
  return {
    listApps() {
      try {
        return fs.readdirSync(applicationsDir);
      } catch {
        return [];
      }
    },
    listProcesses() {
      try {
        const out = execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8' });
        return (
          out
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            // `ps -o comm=` yields full paths; keep the basename for matching.
            .map((l) => l.split('/').pop() ?? l)
        );
      } catch {
        return [];
      }
    },
    hasCommand(command) {
      try {
        execFileSync('which', [command], { encoding: 'utf8' });
        return true;
      } catch {
        return false;
      }
    },
  };
}
