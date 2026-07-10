import { describe, expect, it } from 'vitest';
import {
  type DetectAppsEnv,
  detectApps,
  detectedSuggestions,
  KNOWN_CONNECTORS,
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
    expect(slack?.requiresEnv).toContain('SLACK_BOT_TOKEN');
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
