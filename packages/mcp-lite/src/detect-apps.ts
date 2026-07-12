/**
 * Connector app detection + the built-in connector catalog.
 *
 * {@link KNOWN_CONNECTORS} is the first-party curated set of MCP servers the
 * gallery renders. {@link detectApps} scans installed apps / running processes /
 * bundle ids for signs of a connector and annotates each with `{detected,
 * reason}`; {@link recommendedConnectors} turns the {@link APP_CONNECTOR_MAP}
 * into the "Recommended for you" list (e.g. Blender installed ⇒ blender pinned).
 *
 * The scan environment is injected ({@link DetectAppsEnv}) so detection is pure
 * and unit-tests against fixtures. {@link nodeDetectAppsEnv} provides the
 * macOS-backed implementation (reads /Applications, runs `ps`, reads Info.plist
 * bundle ids best-effort). Full-disk access is assumed already granted, and the
 * scan sends nothing off-device.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BUILTIN_CONNECTORS } from './builtin-connectors';
import { CONNECTOR_ICON_SVGS } from './connector-icons';
import type { McpMode, McpServerConfig } from './registry';

/** Gallery grouping category. */
export type ConnectorCategory =
  | 'files'
  | 'dev'
  | 'database'
  | 'browser'
  | 'design'
  | 'docs'
  | 'project'
  | 'comms'
  | 'analytics'
  | 'creative'
  | 'media'
  | 'devops'
  | 'search'
  | 'observability'
  | 'meetings';

/** A connector we know how to detect and pre-fill a config for. */
export interface KnownConnector {
  id: string;
  name: string;
  /** Emoji fallback mark (used only if {@link iconSvg} is absent). */
  icon: string;
  /**
   * Self-contained, monochrome inline SVG brand mark (no remote URLs, CSP/offline
   * safe) rendered by the gallery in place of {@link icon}. A real published brand
   * glyph for known brands, a neutral category glyph otherwise. Attached from
   * {@link CONNECTOR_ICON_SVGS} when the catalog is built — see the file footer.
   */
  iconSvg?: string;
  description: string;
  homepage?: string;
  /** Gallery grouping. */
  category: ConnectorCategory;
  /** First-party vendor server (vs. community)? Drives the "official" badge. */
  official: boolean;
  /** macOS app bundle names that imply this connector is relevant. */
  appBundles?: string[];
  /** CFBundleIdentifiers that imply relevance (more robust than the name). */
  bundleIds?: string[];
  /** Process (comm) names that imply this connector is relevant. */
  processNames?: string[];
  /** Env vars the user must supply (e.g. tokens) before the server will run. */
  requiresEnv?: string[];
  /** Ready-to-add config template; command/args/env may still need user edits. */
  template: Omit<McpServerConfig, 'enabled'> & { mode?: McpMode };
  /**
   * `'mcp'` (a stdio MCP server — the default) or `'builtin'` (a bundled pi tool
   * that is always on and never spawns a server). Absent ⇒ `'mcp'`. A builtin is
   * not necessarily authored by us — see {@link firstParty}.
   */
  kind?: 'mcp' | 'builtin';
  /**
   * Authored by us (Pi Desktop) — drives the gallery's "By us" section. Distinct
   * from both {@link official} (the vendor's own server, e.g. GitHub's) and
   * {@link kind} `'builtin'` (bundled/preinstalled): HeyGen's HyperFrames is a
   * builtin + official but NOT first-party, so it shows under "Official".
   */
  firstParty?: boolean;
  /** Curated "Popular" flag. Absence ⇒ the connector falls through to Popular. */
  popular?: boolean;
  /**
   * Static tool list for the detail view — always shown for builtins, and a
   * fallback for MCP cards before/without a live `connectors:tools` fetch.
   */
  tools?: ReadonlyArray<{ name: string; description: string }>;
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
  /** CFBundleIdentifiers of installed apps (optional; robustness upgrade). */
  listBundleIds?(): string[];
}

/** Build a `{command, args?, env?}` template with a repeated id/name/icon. */
function tmpl(
  base: Omit<McpServerConfig, 'enabled' | 'name' | 'icon' | 'description'> & {
    name: string;
    icon: string;
    description: string;
    mode?: McpMode;
  },
): KnownConnector['template'] {
  return base;
}

/**
 * The first-party connector catalog. Replaces the earlier set that launched
 * ARCHIVED `@modelcontextprotocol/server-{github,slack,postgres,puppeteer}`
 * packages with the current, maintained servers. Secrets/OAuth connectors are
 * catalog cards only (install-on-demand, disabled until configured); the
 * install flow never seeds a token.
 *
 * Each card's `iconSvg` (the real brand mark / neutral fallback the gallery
 * renders) is attached from {@link CONNECTOR_ICON_SVGS} just below the array.
 */
const CATALOG_BASE: KnownConnector[] = [
  // ── Reference / foundational (MCP steering group; no secrets) ──────────────
  {
    id: 'filesystem',
    name: 'Filesystem',
    icon: '📁',
    description: 'Read and write files under an allowed directory.',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    category: 'files',
    official: true,
    template: tmpl({
      id: 'filesystem',
      name: 'Filesystem',
      icon: '📁',
      description: 'Read and write files under an allowed directory.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '<ALLOWED_DIR>'],
    }),
  },
  {
    id: 'git',
    name: 'Git',
    icon: '🔧',
    description: 'Read, search, and manipulate a Git repository.',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    category: 'dev',
    official: true,
    template: tmpl({
      id: 'git',
      name: 'Git',
      icon: '🔧',
      description: 'Read, search, and manipulate a Git repository.',
      command: 'uvx',
      args: ['mcp-server-git', '--repository', '<REPO_PATH>'],
    }),
  },
  {
    id: 'memory',
    name: 'Memory',
    icon: '🧠',
    description: 'A persistent knowledge-graph memory for the agent.',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    category: 'dev',
    official: true,
    template: tmpl({
      id: 'memory',
      name: 'Memory',
      icon: '🧠',
      description: 'A persistent knowledge-graph memory for the agent.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    }),
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    icon: '🔬',
    description: 'Structured step-by-step reasoning scratchpad.',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    category: 'dev',
    official: true,
    template: tmpl({
      id: 'sequential-thinking',
      name: 'Sequential Thinking',
      icon: '🔬',
      description: 'Structured step-by-step reasoning scratchpad.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    }),
  },
  {
    id: 'time',
    name: 'Time',
    icon: '🕐',
    description: 'Current time and timezone conversions.',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    category: 'dev',
    official: true,
    template: tmpl({
      id: 'time',
      name: 'Time',
      icon: '🕐',
      description: 'Current time and timezone conversions.',
      command: 'uvx',
      args: ['mcp-server-time'],
    }),
  },

  // ── Dev / code / infra ─────────────────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    description: 'Search repos, read code, and manage issues/PRs.',
    homepage: 'https://github.com/github/github-mcp-server',
    category: 'dev',
    official: true,
    appBundles: ['GitHub Desktop.app'],
    bundleIds: ['com.github.GitHubClient'],
    processNames: ['GitHub Desktop'],
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    template: tmpl({
      id: 'github',
      name: 'GitHub',
      icon: '🐙',
      description: 'Search repos, read code, and manage issues/PRs.',
      command: 'docker',
      args: [
        'run',
        '-i',
        '--rm',
        '-e',
        'GITHUB_PERSONAL_ACCESS_TOKEN',
        'ghcr.io/github/github-mcp-server',
      ],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    }),
  },
  {
    id: 'postgres',
    name: 'Postgres',
    icon: '🐘',
    description: 'Query a Postgres database (restricted access mode).',
    homepage: 'https://github.com/crystaldba/postgres-mcp',
    category: 'database',
    official: false,
    appBundles: ['Postgres.app'],
    processNames: ['postgres'],
    requiresEnv: ['DATABASE_URI'],
    template: tmpl({
      id: 'postgres',
      name: 'Postgres',
      icon: '🐘',
      description: 'Query a Postgres database (restricted access mode).',
      command: 'uvx',
      args: ['postgres-mcp', '--access-mode=restricted'],
      env: { DATABASE_URI: '' },
    }),
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    icon: '🗃️',
    description: 'Query and inspect a local SQLite database file.',
    homepage: 'https://github.com/modelcontextprotocol/servers-archived',
    category: 'database',
    official: false,
    template: tmpl({
      id: 'sqlite',
      name: 'SQLite',
      icon: '🗃️',
      description: 'Query and inspect a local SQLite database file.',
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', '<DB_PATH>'],
    }),
  },
  {
    id: 'playwright',
    name: 'Playwright',
    icon: '🎭',
    description: 'Drive a browser for testing and codegen via Playwright.',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    category: 'browser',
    official: true,
    template: tmpl({
      id: 'playwright',
      name: 'Playwright',
      icon: '🎭',
      description: 'Drive a browser for testing and codegen via Playwright.',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    }),
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    icon: '🌐',
    description: 'Debug pages and capture performance traces via Chrome DevTools.',
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    category: 'browser',
    official: true,
    appBundles: ['Google Chrome.app', 'Arc.app'],
    bundleIds: ['com.google.Chrome', 'company.thebrowser.Browser'],
    processNames: ['Google Chrome'],
    template: tmpl({
      id: 'chrome-devtools',
      name: 'Chrome DevTools',
      icon: '🌐',
      description: 'Debug pages and capture performance traces via Chrome DevTools.',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest'],
    }),
  },
  {
    id: 'postman',
    name: 'Postman',
    icon: '📮',
    description: 'Run collections and query APIs and specs.',
    homepage: 'https://github.com/postmanlabs/postman-mcp-server',
    category: 'dev',
    official: true,
    appBundles: ['Postman.app'],
    bundleIds: ['com.postmanlabs.mac'],
    requiresEnv: ['POSTMAN_API_KEY'],
    template: tmpl({
      id: 'postman',
      name: 'Postman',
      icon: '📮',
      description: 'Run collections and query APIs and specs.',
      command: 'npx',
      args: ['-y', '@postman/postman-mcp-server'],
      env: { POSTMAN_API_KEY: '' },
    }),
  },
  {
    id: 'sentry',
    name: 'Sentry',
    icon: '🛡️',
    description: 'Inspect errors, issues, and releases (remote, OAuth).',
    homepage: 'https://mcp.sentry.dev',
    category: 'observability',
    official: true,
    template: tmpl({
      id: 'sentry',
      name: 'Sentry',
      icon: '🛡️',
      description: 'Inspect errors, issues, and releases (remote, OAuth).',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.sentry.dev/mcp'],
    }),
  },
  {
    id: 'xcode',
    name: 'Xcode',
    icon: '📱',
    description: 'Build, test, and debug iOS & macOS projects.',
    homepage: 'https://github.com/cameroncooke/XcodeBuildMCP',
    category: 'dev',
    official: true,
    appBundles: ['Xcode.app'],
    bundleIds: ['com.apple.dt.Xcode'],
    template: tmpl({
      id: 'xcode',
      name: 'Xcode',
      icon: '📱',
      description: 'Build, test, and debug iOS & macOS projects.',
      command: 'npx',
      args: ['-y', 'xcodebuildmcp@latest'],
    }),
  },
  {
    id: 'docker',
    name: 'Docker',
    icon: '🐳',
    description: 'Manage containers, images, and compose stacks.',
    homepage: 'https://docs.docker.com/ai/mcp-catalog-and-toolkit/',
    category: 'devops',
    official: true,
    appBundles: ['Docker.app', 'Docker Desktop.app'],
    bundleIds: ['com.docker.docker'],
    processNames: ['com.docker.backend'],
    template: tmpl({
      id: 'docker',
      name: 'Docker',
      icon: '🐳',
      description: 'Manage containers, images, and compose stacks.',
      command: 'docker',
      args: ['mcp', 'gateway', 'run'],
    }),
  },

  // ── SaaS / productivity (secrets/OAuth → install-on-demand) ────────────────
  {
    id: 'notion',
    name: 'Notion',
    icon: '📝',
    description: 'Query and update a Notion workspace.',
    homepage: 'https://github.com/makenotion/notion-mcp-server',
    category: 'docs',
    official: true,
    appBundles: ['Notion.app'],
    bundleIds: ['notion.id'],
    requiresEnv: ['NOTION_TOKEN'],
    template: tmpl({
      id: 'notion',
      name: 'Notion',
      icon: '📝',
      description: 'Query and update a Notion workspace.',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: { NOTION_TOKEN: '' },
    }),
  },
  {
    id: 'linear',
    name: 'Linear',
    icon: '📐',
    description: 'Read and update Linear issues, projects, and cycles.',
    homepage: 'https://linear.app/docs/mcp',
    category: 'project',
    official: true,
    appBundles: ['Linear.app'],
    bundleIds: ['com.linear'],
    template: tmpl({
      id: 'linear',
      name: 'Linear',
      icon: '📐',
      description: 'Read and update Linear issues, projects, and cycles.',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.linear.app/sse'],
    }),
  },
  {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    description: 'Read and post to Slack channels.',
    homepage: 'https://github.com/korotovsky/slack-mcp-server',
    category: 'comms',
    official: false,
    appBundles: ['Slack.app'],
    bundleIds: ['com.tinyspeck.slackmacgap'],
    processNames: ['Slack'],
    requiresEnv: ['SLACK_MCP_XOXP_TOKEN'],
    template: tmpl({
      id: 'slack',
      name: 'Slack',
      icon: '💬',
      description: 'Read and post to Slack channels.',
      command: 'npx',
      args: ['-y', 'slack-mcp-server@latest'],
      env: { SLACK_MCP_XOXP_TOKEN: '' },
    }),
  },
  {
    id: 'figma',
    name: 'Figma',
    icon: '🎨',
    description: 'Read designs and Dev Mode data for handoff.',
    homepage: 'https://github.com/GLips/Figma-Context-MCP',
    category: 'design',
    official: true,
    appBundles: ['Figma.app'],
    bundleIds: ['com.figma.Desktop'],
    requiresEnv: ['FIGMA_API_KEY'],
    template: tmpl({
      id: 'figma',
      name: 'Figma',
      icon: '🎨',
      description: 'Read designs and Dev Mode data for handoff.',
      command: 'npx',
      args: ['-y', 'figma-developer-mcp', '--stdio'],
      env: { FIGMA_API_KEY: '' },
    }),
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    icon: '📂',
    description: 'Search and read files in Google Drive (OAuth).',
    homepage: 'https://github.com/modelcontextprotocol/servers-archived',
    category: 'files',
    official: false,
    requiresEnv: ['GDRIVE_CREDENTIALS_PATH'],
    template: tmpl({
      id: 'google-drive',
      name: 'Google Drive',
      icon: '📂',
      description: 'Search and read files in Google Drive (OAuth).',
      command: 'npx',
      args: ['-y', '@isaacphi/mcp-gdrive'],
      env: { GDRIVE_CREDENTIALS_PATH: '' },
    }),
  },
  {
    id: 'gmail',
    name: 'Gmail',
    icon: '📧',
    description: 'Read, search, and send Gmail (OAuth).',
    homepage: 'https://github.com/GongRzhe/Gmail-MCP-Server',
    category: 'comms',
    official: false,
    requiresEnv: ['GMAIL_CREDENTIALS_PATH'],
    template: tmpl({
      id: 'gmail',
      name: 'Gmail',
      icon: '📧',
      description: 'Read, search, and send Gmail (OAuth).',
      command: 'npx',
      args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
      env: { GMAIL_CREDENTIALS_PATH: '' },
    }),
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    icon: '📅',
    description: 'Read and manage Google Calendar events (OAuth).',
    homepage: 'https://github.com/nspady/google-calendar-mcp',
    category: 'meetings',
    official: false,
    requiresEnv: ['GOOGLE_OAUTH_CREDENTIALS'],
    template: tmpl({
      id: 'google-calendar',
      name: 'Google Calendar',
      icon: '📅',
      description: 'Read and manage Google Calendar events (OAuth).',
      command: 'npx',
      args: ['-y', '@cocal/google-calendar-mcp'],
      env: { GOOGLE_OAUTH_CREDENTIALS: '' },
    }),
  },

  // ── Data / BI ──────────────────────────────────────────────────────────────
  {
    id: 'tableau',
    name: 'Tableau',
    icon: '📊',
    description: 'Query published data sources and workbooks.',
    homepage: 'https://github.com/tableau/tableau-mcp',
    category: 'analytics',
    official: true,
    appBundles: ['Tableau Desktop.app'],
    bundleIds: ['com.tableausoftware.tableaudesktop'],
    requiresEnv: ['SERVER', 'SITE_NAME', 'PAT_NAME', 'PAT_VALUE'],
    template: tmpl({
      id: 'tableau',
      name: 'Tableau',
      icon: '📊',
      description: 'Query published data sources and workbooks.',
      command: 'npx',
      args: ['-y', '@tableau/mcp-server@latest'],
      env: { SERVER: '', SITE_NAME: '', PAT_NAME: '', PAT_VALUE: '' },
    }),
  },

  // ── Content / knowledge / search ───────────────────────────────────────────
  {
    id: 'obsidian',
    name: 'Obsidian',
    icon: '💜',
    description: 'Read and search an Obsidian vault (Local REST API plugin).',
    homepage: 'https://github.com/MarkusPfundstein/mcp-obsidian',
    category: 'docs',
    official: false,
    appBundles: ['Obsidian.app'],
    bundleIds: ['md.obsidian'],
    requiresEnv: ['OBSIDIAN_API_KEY'],
    template: tmpl({
      id: 'obsidian',
      name: 'Obsidian',
      icon: '💜',
      description: 'Read and search an Obsidian vault (Local REST API plugin).',
      command: 'uvx',
      args: ['mcp-obsidian'],
      env: { OBSIDIAN_API_KEY: '' },
    }),
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    icon: '🦁',
    description: 'Web and local search via the Brave Search API.',
    homepage: 'https://github.com/brave/brave-search-mcp-server',
    category: 'search',
    official: true,
    requiresEnv: ['BRAVE_API_KEY'],
    template: tmpl({
      id: 'brave-search',
      name: 'Brave Search',
      icon: '🦁',
      description: 'Web and local search via the Brave Search API.',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server'],
      env: { BRAVE_API_KEY: '' },
    }),
  },

  // ── Creative / media / games ───────────────────────────────────────────────
  {
    id: 'blender',
    name: 'Blender',
    icon: '🟠',
    description: 'Drive Blender scenes and rendering over MCP.',
    homepage: 'https://github.com/ahujasid/blender-mcp',
    category: 'creative',
    official: false,
    appBundles: ['Blender.app'],
    bundleIds: ['org.blenderfoundation.blender'],
    processNames: ['Blender'],
    template: tmpl({
      id: 'blender',
      name: 'Blender',
      icon: '🟠',
      description: 'Drive Blender scenes and rendering over MCP.',
      command: 'uvx',
      args: ['blender-mcp'],
    }),
  },
  {
    id: 'unity',
    name: 'Unity',
    icon: '🎮',
    description: 'Drive the Unity editor over MCP (needs the Unity bridge).',
    homepage: 'https://github.com/CoplayDev/unity-mcp',
    category: 'creative',
    official: false,
    appBundles: ['Unity.app', 'Unity Hub.app'],
    bundleIds: ['com.unity3d.unityhub'],
    template: tmpl({
      id: 'unity',
      name: 'Unity',
      icon: '🎮',
      description: 'Drive the Unity editor over MCP (needs the Unity bridge).',
      command: 'uvx',
      args: ['unity-mcp-server'],
    }),
  },
  {
    id: 'spotify',
    name: 'Spotify',
    icon: '🎧',
    description: 'Control playback and query your library (OAuth).',
    homepage: 'https://github.com/marcelmarais/spotify-mcp-server',
    category: 'media',
    official: false,
    appBundles: ['Spotify.app'],
    bundleIds: ['com.spotify.client'],
    processNames: ['Spotify'],
    requiresEnv: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
    template: tmpl({
      id: 'spotify',
      name: 'Spotify',
      icon: '🎧',
      description: 'Control playback and query your library (OAuth).',
      command: 'uvx',
      args: ['spotify-mcp'],
      env: { SPOTIFY_CLIENT_ID: '', SPOTIFY_CLIENT_SECRET: '' },
    }),
  },

  // ── Communication / meetings ───────────────────────────────────────────────
  {
    id: 'discord',
    name: 'Discord',
    icon: '🎮',
    description: 'Read and post to Discord servers and DMs.',
    homepage: 'https://github.com/barryyip0625/mcp-discord',
    category: 'comms',
    official: false,
    appBundles: ['Discord.app'],
    bundleIds: ['com.hnc.Discord'],
    processNames: ['Discord'],
    requiresEnv: ['DISCORD_BOT_TOKEN'],
    template: tmpl({
      id: 'discord',
      name: 'Discord',
      icon: '🎮',
      description: 'Read and post to Discord servers and DMs.',
      command: 'npx',
      args: ['-y', 'mcp-discord'],
      env: { DISCORD_BOT_TOKEN: '' },
    }),
  },
  {
    id: 'zoom',
    name: 'Zoom',
    icon: '🎥',
    description: 'Meetings, recordings, and summaries (remote, OAuth).',
    homepage: 'https://mcp.zoom.us',
    category: 'meetings',
    official: true,
    appBundles: ['zoom.us.app'],
    bundleIds: ['us.zoom.xos'],
    template: tmpl({
      id: 'zoom',
      name: 'Zoom',
      icon: '🎥',
      description: 'Meetings, recordings, and summaries (remote, OAuth).',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.zoom.us/mcp'],
    }),
  },
];

/**
 * The rendered catalog: every card annotated with its self-contained inline SVG
 * mark ({@link CONNECTOR_ICON_SVGS}) — a real brand glyph where one is published,
 * a neutral category glyph otherwise. The emoji `icon` stays as a last-resort
 * fallback for any card without an SVG.
 *
 * The built-in connectors ({@link BUILTIN_CONNECTORS} — HyperFrames, Video
 * editing) are prepended so they land first in the gallery and cross the
 * connectors IPC in `catalog`.
 */
export const KNOWN_CONNECTORS: KnownConnector[] = [...BUILTIN_CONNECTORS, ...CATALOG_BASE].map(
  (c) => ({ ...c, iconSvg: CONNECTOR_ICON_SVGS[c.id] ?? c.iconSvg }),
);

/** Lookup a known connector by id. */
export const KNOWN_CONNECTORS_BY_ID: Record<string, KnownConnector> = Object.fromEntries(
  KNOWN_CONNECTORS.map((c) => [c.id, c]),
);

/** True when a connector needs config before it can run (secrets or a
 * `<PLACEHOLDER>` arg), so the install flow adds it disabled until configured. */
export function connectorNeedsConfig(connector: KnownConnector): boolean {
  if (connector.requiresEnv && connector.requiresEnv.length > 0) return true;
  const args = connector.template.args ?? [];
  return args.some((a) => /<[^>]+>/.test(a));
}

/**
 * True when a connector is a bundled builtin (always on — never installed,
 * removed, or spawned as a server). The connectors IPC no-ops install/remove/
 * enable for these, and the gallery renders "Preinstalled" instead of "+".
 */
export function isBuiltinConnector(id: string): boolean {
  return KNOWN_CONNECTORS_BY_ID[id]?.kind === 'builtin';
}

/** A mapping from an installed macOS app to the connector(s) it implies. */
export interface AppConnectorMapping {
  appBundles: string[];
  bundleIds?: string[];
  connectorId: string | string[];
  reason: string;
}

/**
 * Installed-app → connector map used for "Recommended for you". Matching an
 * app name (or bundle id) pins the mapped connector(s) to the top of the
 * gallery. Blender-installed ⇒ blender pinned first.
 */
export const APP_CONNECTOR_MAP: AppConnectorMapping[] = [
  {
    appBundles: ['Blender.app'],
    bundleIds: ['org.blenderfoundation.blender'],
    connectorId: 'blender',
    reason: 'Blender is installed',
  },
  {
    appBundles: ['Visual Studio Code.app'],
    bundleIds: ['com.microsoft.VSCode'],
    connectorId: ['git', 'filesystem', 'github'],
    reason: 'VS Code is installed',
  },
  {
    appBundles: ['Figma.app'],
    bundleIds: ['com.figma.Desktop'],
    connectorId: 'figma',
    reason: 'Figma is installed',
  },
  {
    appBundles: ['Slack.app'],
    bundleIds: ['com.tinyspeck.slackmacgap'],
    connectorId: 'slack',
    reason: 'Slack is installed',
  },
  {
    appBundles: ['Notion.app'],
    bundleIds: ['notion.id'],
    connectorId: 'notion',
    reason: 'Notion is installed',
  },
  {
    appBundles: ['Docker.app', 'Docker Desktop.app'],
    bundleIds: ['com.docker.docker'],
    connectorId: 'docker',
    reason: 'Docker is installed',
  },
  {
    appBundles: ['Xcode.app'],
    bundleIds: ['com.apple.dt.Xcode'],
    connectorId: 'xcode',
    reason: 'Xcode is installed',
  },
  {
    appBundles: ['Obsidian.app'],
    bundleIds: ['md.obsidian'],
    connectorId: 'obsidian',
    reason: 'Obsidian is installed',
  },
  {
    appBundles: ['Spotify.app'],
    bundleIds: ['com.spotify.client'],
    connectorId: 'spotify',
    reason: 'Spotify is installed',
  },
  {
    appBundles: ['Discord.app'],
    bundleIds: ['com.hnc.Discord'],
    connectorId: 'discord',
    reason: 'Discord is installed',
  },
  {
    appBundles: ['zoom.us.app'],
    bundleIds: ['us.zoom.xos'],
    connectorId: 'zoom',
    reason: 'Zoom is installed',
  },
  {
    appBundles: ['Google Chrome.app'],
    bundleIds: ['com.google.Chrome'],
    connectorId: 'chrome-devtools',
    reason: 'Chrome is installed (browsing is built-in; DevTools adds debugging)',
  },
  {
    appBundles: ['Arc.app'],
    bundleIds: ['company.thebrowser.Browser'],
    connectorId: 'chrome-devtools',
    reason: 'Arc is installed (Chromium-based)',
  },
  {
    appBundles: ['Postman.app'],
    bundleIds: ['com.postmanlabs.mac'],
    connectorId: 'postman',
    reason: 'Postman is installed',
  },
  {
    appBundles: ['Tableau Desktop.app'],
    bundleIds: ['com.tableausoftware.tableaudesktop'],
    connectorId: 'tableau',
    reason: 'Tableau is installed',
  },
  {
    appBundles: ['Unity.app', 'Unity Hub.app'],
    bundleIds: ['com.unity3d.unityhub'],
    connectorId: 'unity',
    reason: 'Unity is installed',
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

/** Exact (case-insensitive) membership match for bundle ids. */
function anyExact(needles: string[] | undefined, haystack: string[]): boolean {
  if (!needles || needles.length === 0 || haystack.length === 0) return false;
  const lower = new Set(haystack.map((h) => h.toLowerCase()));
  return needles.some((n) => lower.has(n.toLowerCase()));
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
  const bundleIds = env.listBundleIds?.() ?? [];
  return catalog.map((c) => {
    const byApp = anyMatch(c.appBundles, apps);
    const byBundle = anyExact(c.bundleIds, bundleIds);
    const byProc = anyMatch(c.processNames, procs);
    const detected = byApp || byBundle || byProc;
    let reason: string;
    if (byApp) {
      const hit = c.appBundles?.find((b) =>
        apps.some((a) => a.toLowerCase().includes(b.toLowerCase())),
      );
      reason = `${hit ?? 'app'} is installed`;
    } else if (byBundle) {
      reason = `${c.name} app is installed`;
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

/**
 * "Recommended for you": walk {@link APP_CONNECTOR_MAP}, and for every installed
 * app pin its mapped connector(s), de-duplicated and in map order (so Blender,
 * listed first, is pinned top when installed). Each carries the mapping reason.
 */
export function recommendedConnectors(
  env: DetectAppsEnv,
  catalog: KnownConnector[] = KNOWN_CONNECTORS,
): ConnectorSuggestion[] {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const apps = env.listApps();
  const bundleIds = env.listBundleIds?.() ?? [];
  const out: ConnectorSuggestion[] = [];
  const seen = new Set<string>();
  for (const mapping of APP_CONNECTOR_MAP) {
    const hit = anyMatch(mapping.appBundles, apps) || anyExact(mapping.bundleIds, bundleIds);
    if (!hit) continue;
    const ids = Array.isArray(mapping.connectorId) ? mapping.connectorId : [mapping.connectorId];
    for (const id of ids) {
      const connector = byId.get(id);
      if (connector === undefined || seen.has(id)) continue;
      seen.add(id);
      out.push({ ...connector, detected: true, reason: mapping.reason });
    }
  }
  return out;
}

/** Read a `.app`'s CFBundleIdentifier from Info.plist (best-effort, no parse). */
function readBundleId(appPath: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const m = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** macOS-backed scan environment. Failures degrade to empty lists. */
export function nodeDetectAppsEnv(applicationsDir = '/Applications'): DetectAppsEnv {
  const listApps = (): string[] => {
    try {
      return fs.readdirSync(applicationsDir);
    } catch {
      return [];
    }
  };
  return {
    listApps,
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
    listBundleIds() {
      const ids: string[] = [];
      for (const name of listApps()) {
        if (!name.endsWith('.app')) continue;
        const id = readBundleId(path.join(applicationsDir, name));
        if (id !== null) ids.push(id);
      }
      return ids;
    },
  };
}
