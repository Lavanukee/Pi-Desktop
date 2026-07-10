import { describe, expect, it } from 'vitest';
import {
  connectorNeedsConfig,
  type DetectAppsEnv,
  detectApps,
  detectedSuggestions,
  KNOWN_CONNECTORS,
  KNOWN_CONNECTORS_BY_ID,
  recommendedConnectors,
} from './detect-apps';

function env(overrides: Partial<DetectAppsEnv>): DetectAppsEnv {
  return {
    listApps: () => [],
    listProcesses: () => [],
    hasCommand: () => false,
    ...overrides,
  };
}

describe('detectApps', () => {
  it('annotates every known connector', () => {
    const out = detectApps(env({}));
    expect(out).toHaveLength(KNOWN_CONNECTORS.length);
    expect(out.every((s) => s.detected === false)).toBe(true);
  });

  it('detects a connector by installed app bundle', () => {
    const out = detectApps(env({ listApps: () => ['Slack.app', 'Safari.app'] }));
    const slack = out.find((s) => s.id === 'slack');
    expect(slack?.detected).toBe(true);
    expect(slack?.reason).toContain('Slack.app');
  });

  it('detects a connector by running process', () => {
    const out = detectApps(env({ listProcesses: () => ['Blender', 'kernel_task'] }));
    const blender = out.find((s) => s.id === 'blender');
    expect(blender?.detected).toBe(true);
    expect(blender?.reason).toContain('Blender');
  });

  it('matches case-insensitively and as a substring', () => {
    const out = detectApps(env({ listApps: () => ['slack.APP'] }));
    expect(out.find((s) => s.id === 'slack')?.detected).toBe(true);
  });

  it('carries a ready-to-add template and required env for the gallery', () => {
    const slack = detectApps(env({})).find((s) => s.id === 'slack');
    expect(slack?.template.command).toBe('npx');
    expect(slack?.requiresEnv).toContain('SLACK_MCP_XOXP_TOKEN');
  });

  it('detects a connector by CFBundleIdentifier', () => {
    const out = detectApps(env({ listBundleIds: () => ['org.blenderfoundation.blender'] }));
    const blender = out.find((s) => s.id === 'blender');
    expect(blender?.detected).toBe(true);
  });

  it('carries category + official metadata on every card', () => {
    for (const c of KNOWN_CONNECTORS) {
      expect(typeof c.category).toBe('string');
      expect(typeof c.official).toBe('boolean');
    }
  });

  it('no longer ships the archived first-party servers', () => {
    const flat = JSON.stringify(KNOWN_CONNECTORS);
    expect(flat).not.toContain('@modelcontextprotocol/server-github');
    expect(flat).not.toContain('@modelcontextprotocol/server-slack');
    expect(flat).not.toContain('@modelcontextprotocol/server-postgres');
    expect(flat).not.toContain('@modelcontextprotocol/server-puppeteer');
  });
});

describe('connectorNeedsConfig', () => {
  it('is true for secret/placeholder connectors, false for plain local ones', () => {
    // biome-ignore lint/style/noNonNullAssertion: fixed catalog ids
    expect(connectorNeedsConfig(KNOWN_CONNECTORS_BY_ID.slack!)).toBe(true); // requiresEnv
    // biome-ignore lint/style/noNonNullAssertion: fixed catalog ids
    expect(connectorNeedsConfig(KNOWN_CONNECTORS_BY_ID.filesystem!)).toBe(true); // <ALLOWED_DIR>
    // biome-ignore lint/style/noNonNullAssertion: fixed catalog ids
    expect(connectorNeedsConfig(KNOWN_CONNECTORS_BY_ID.memory!)).toBe(false);
  });
});

describe('detectedSuggestions', () => {
  it('returns only detected connectors', () => {
    const out = detectedSuggestions(
      env({ listApps: () => ['Slack.app'], listProcesses: () => ['postgres'] }),
    );
    expect(out.map((s) => s.id).sort()).toEqual(['postgres', 'slack']);
  });
});

describe('recommendedConnectors', () => {
  it('pins Blender first when Blender is installed', () => {
    const out = recommendedConnectors(env({ listApps: () => ['Blender.app', 'Safari.app'] }));
    expect(out[0]?.id).toBe('blender');
    expect(out[0]?.reason).toBe('Blender is installed');
  });

  it('expands a multi-connector app mapping (VS Code → git/filesystem/github)', () => {
    const out = recommendedConnectors(env({ listApps: () => ['Visual Studio Code.app'] }));
    expect(out.map((s) => s.id)).toEqual(['git', 'filesystem', 'github']);
  });

  it('is empty when nothing relevant is installed', () => {
    expect(recommendedConnectors(env({ listApps: () => ['Safari.app'] }))).toHaveLength(0);
  });
});
