import { describe, expect, it } from 'vitest';
import { BRANDED_CONNECTOR_IDS, connectorIconSvg } from './connector-icons';
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

  it('carries a self-contained inline SVG mark on every card (no remote refs)', () => {
    for (const c of KNOWN_CONNECTORS) {
      expect(c.iconSvg, `${c.id} has no iconSvg`).toBeDefined();
      const svg = c.iconSvg ?? '';
      expect(svg.startsWith('<svg'), `${c.id} iconSvg is not an <svg>`).toBe(true);
      expect(svg).toContain('</svg>');
      // No network/remote asset references (CSP + offline). xmlns namespace is fine.
      expect(svg, `${c.id} iconSvg pulls a remote/external asset`).not.toMatch(
        /href=|src=|url\(|<image/,
      );
      // Branded marks fill in a brand color (a #rrggbb hex — bright brands
      // directly, near-black brands as the --pd-connector-ink fallback); neutral
      // fallbacks stay monochrome via currentColor so they read on light + dark.
      if (BRANDED_CONNECTOR_IDS.includes(c.id)) {
        expect(svg, `${c.id} branded mark has no brand color`).toMatch(
          /fill="[^"]*#[0-9a-fA-F]{6}/,
        );
      } else {
        expect(svg, `${c.id} neutral mark is not currentColor`).toContain('currentColor');
      }
    }
  });

  it('renders github, figma, and blender in their brand color (real published glyphs)', () => {
    // Canonical simple-icons brand hex: figma #F24E1E, blender #E87D0D. GitHub
    // #181717 is near-black, so it fills via --pd-connector-ink (currentColor on
    // dark) with the brand hex as the light-theme fallback.
    const brandHex: Record<string, string> = {
      github: '#181717',
      figma: '#F24E1E',
      blender: '#E87D0D',
    };
    for (const id of ['github', 'figma', 'blender'] as const) {
      expect(BRANDED_CONNECTOR_IDS).toContain(id);
      const connector = KNOWN_CONNECTORS_BY_ID[id];
      const svg = connector?.iconSvg ?? '';
      // The branded marks are filled simple-icons paths on the 24x24 canvas.
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain('<path');
      // Filled in the brand color — no longer the old monochrome currentColor.
      expect(svg).toContain(brandHex[id]);
      expect(svg).not.toContain('fill="currentColor"');
      // The rendered card SVG matches the source-of-truth icon map.
      expect(svg).toBe(connectorIconSvg(id));
    }
  });

  it('falls back to a neutral (stroked) glyph for connectors without a brand mark', () => {
    // playwright/filesystem have no simple, published brand glyph in the set.
    for (const id of ['filesystem', 'playwright'] as const) {
      expect(BRANDED_CONNECTOR_IDS).not.toContain(id);
      const svg = KNOWN_CONNECTORS_BY_ID[id]?.iconSvg ?? '';
      expect(svg).toContain('stroke="currentColor"');
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

describe('catalog npx package specs are plausibly-real package names (round-9)', () => {
  // The first non-flag arg to `npx` is the package to run. Strip an optional
  // `@version` / `@latest` tag (scoped: the @ after the '/'; unscoped: the first @).
  function npxPackageSpec(args: readonly string[]): string | undefined {
    return args.find((a) => !a.startsWith('-') && !a.startsWith('http') && !a.startsWith('<'));
  }
  function stripVersion(spec: string): string {
    if (spec.startsWith('@')) {
      const slash = spec.indexOf('/');
      const at = slash >= 0 ? spec.indexOf('@', slash) : -1;
      return at > slash ? spec.slice(0, at) : spec;
    }
    const at = spec.indexOf('@');
    return at > 0 ? spec.slice(0, at) : spec;
  }
  // npm package-name shape: optional lowercase scope, then a lowercase name.
  const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

  const npxConnectors = KNOWN_CONNECTORS.filter((c) => c.template.command === 'npx');

  it('covers a meaningful number of npx connectors', () => {
    expect(npxConnectors.length).toBeGreaterThan(5);
  });

  for (const c of npxConnectors) {
    it(`${c.id}: launches a well-formed npm package name`, () => {
      const spec = npxPackageSpec(c.template.args ?? []);
      expect(spec, `${c.id} has no npx package arg`).toBeDefined();
      // No unresolved placeholder leaked into the package position.
      expect(spec).not.toMatch(/[<>]/);
      expect(NPM_NAME.test(stripVersion(spec ?? ''))).toBe(true);
    });
  }

  it('ships the CORRECT (non-404) package ids for the round-9 fixes', () => {
    const seq = KNOWN_CONNECTORS_BY_ID['sequential-thinking'];
    expect(seq?.template.args).toContain('@modelcontextprotocol/server-sequential-thinking');
    // The typo'd (hyphen-less) id must be gone.
    expect(JSON.stringify(seq)).not.toContain('sequentialthinking');

    const discord = KNOWN_CONNECTORS_BY_ID.discord;
    expect(discord?.template.args).toContain('mcp-discord');
    expect(JSON.stringify(discord)).not.toContain('@barryyip0625/mcp-discord');
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
