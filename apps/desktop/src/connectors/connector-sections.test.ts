import type { KnownConnector } from '@pi-desktop/mcp-lite';
import { describe, expect, it } from 'vitest';
import { buildConnectorSections, type ConnectorSection } from './connector-sections';

function connector(over: Partial<KnownConnector> & { id: string }): KnownConnector {
  return {
    name: over.id,
    icon: '🔌',
    description: `${over.id} description`,
    category: 'dev',
    official: false,
    template: { id: over.id, name: over.id, icon: '🔌', description: '', command: 'npx' },
    ...over,
  };
}

/** The catalog shape the connectors:list IPC delivers (builtins first). */
const CATALOG: KnownConnector[] = [
  connector({ id: 'video-editing', firstParty: true, official: true, kind: 'builtin' }),
  connector({ id: 'hyperframes', firstParty: false, official: true, kind: 'builtin' }),
  connector({ id: 'github', official: true }),
  connector({ id: 'notion', official: true }),
  connector({ id: 'blender', official: false }),
  connector({ id: 'postgres', official: false }),
];

const ids = (groups: { items: KnownConnector[] }[]) => groups.map((g) => g.items.map((c) => c.id));
const sectionIds = (groups: { id: ConnectorSection }[]) => groups.map((g) => g.id);

describe('buildConnectorSections', () => {
  it('places our tool under By us and the third-party bundled tool under Official', () => {
    const groups = buildConnectorSections(CATALOG, [], '');
    const byUs = groups.find((g) => g.id === 'by-us');
    const official = groups.find((g) => g.id === 'official');
    // Owner correction: video-editing is ours; HyperFrames is HeyGen's (Official).
    expect(byUs?.items.map((c) => c.id)).toEqual(['video-editing']);
    expect(official?.items.map((c) => c.id)).toContain('hyperframes');
    expect(byUs?.items.map((c) => c.id)).not.toContain('hyperframes');
  });

  it('titles the sections and drops empty ones', () => {
    const groups = buildConnectorSections(CATALOG, [], '');
    expect(sectionIds(groups)).toEqual(['by-us', 'official', 'popular']);
    expect(groups.map((g) => g.title)).toEqual(['By us', 'Official', 'Popular']);
    // No 'recommended' section because the scan returned nothing.
    expect(sectionIds(groups)).not.toContain('recommended');
  });

  it('surfaces the scan result as Recommended, in scan order', () => {
    const groups = buildConnectorSections(CATALOG, ['blender', 'github'], '');
    const rec = groups.find((g) => g.id === 'recommended');
    expect(rec?.items.map((c) => c.id)).toEqual(['blender', 'github']);
  });

  it('priority-dedups: a connector lands in the FIRST section it qualifies for', () => {
    // github is official AND recommended → it belongs to recommended only.
    const groups = buildConnectorSections(CATALOG, ['github'], '');
    const rec = groups.find((g) => g.id === 'recommended');
    const official = groups.find((g) => g.id === 'official');
    expect(rec?.items.map((c) => c.id)).toEqual(['github']);
    expect(official?.items.map((c) => c.id)).not.toContain('github');
    // And it never double-counts across all sections.
    const all = ids(groups).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('puts non-official, non-recommended connectors in Popular', () => {
    const groups = buildConnectorSections(CATALOG, [], '');
    const popular = groups.find((g) => g.id === 'popular');
    expect(popular?.items.map((c) => c.id).sort()).toEqual(['blender', 'postgres']);
  });

  it('applies the search query within every section (name/description/category)', () => {
    const groups = buildConnectorSections(CATALOG, ['blender'], 'git');
    // Only github (name) survives; blender's recommended section is now empty → dropped.
    expect(sectionIds(groups)).toEqual(['official']);
    expect(groups[0]?.items.map((c) => c.id)).toEqual(['github']);
  });

  it('returns no sections when the query matches nothing', () => {
    expect(buildConnectorSections(CATALOG, [], 'zzzznomatch')).toEqual([]);
  });

  it('ignores recommended ids that are not in the catalog', () => {
    const groups = buildConnectorSections(CATALOG, ['ghost-id', 'github'], '');
    const rec = groups.find((g) => g.id === 'recommended');
    expect(rec?.items.map((c) => c.id)).toEqual(['github']);
  });
});
