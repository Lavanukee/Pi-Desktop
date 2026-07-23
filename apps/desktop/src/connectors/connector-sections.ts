/**
 * Connector gallery **sections** — the Codex-style grouping axis (By us /
 * Recommended for you / Official / Popular), which is orthogonal to a
 * connector's {@link KnownConnector.category} (files / dev / …).
 *
 * This is a renderer-local PURE module (mirrors modality-catalog-logic.ts): the
 * renderer is TYPE-ONLY on @pi-desktop/mcp-lite (value-importing its barrel
 * would pull the node-touching detect-apps), so the grouping operates on the
 * plain DTO shapes the connectors:list IPC already delivers. Unit-tested in
 * connector-sections.test.ts.
 *
 * Grouping is priority-deduped — a connector appears in the FIRST section it
 * qualifies for, in this order:
 *   1. by-us       — c.firstParty (authored by Bobble; e.g. Video editing)
 *   2. recommended — the /Applications scan result, minus anything above
 *   3. official    — c.official (the vendor's own server; HeyGen's HyperFrames,
 *                    GitHub, Notion…), minus anything above
 *   4. popular     — everything else (or c.popular when a curated flag is set)
 */
import type { KnownConnector } from '@pi-desktop/mcp-lite';

/** The four gallery sections (a different axis from ConnectorCategory). */
export type ConnectorSection = 'by-us' | 'recommended' | 'official' | 'popular';

/** One rendered section: its id, human title, and the connectors in it. */
export interface SectionGroup {
  id: ConnectorSection;
  title: string;
  items: KnownConnector[];
}

const SECTION_TITLES: Record<ConnectorSection, string> = {
  'by-us': 'By us',
  recommended: 'Recommended for you',
  official: 'Official',
  popular: 'Popular',
};

/** Substring match over name / description / category (case-insensitive). */
function matchesQuery(c: KnownConnector, q: string): boolean {
  // DEFERRED: semantic connector search — for now this is a plain substring
  // filter over the card's own text; swap this predicate for an embedding/rank
  // lookup when semantic search lands.
  if (q.length === 0) return true;
  return (
    c.name.toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q) ||
    c.category.toLowerCase().includes(q)
  );
}

/**
 * Group the catalog into the four gallery sections. `recommendedIds` is the
 * ordered scan result (recommendedConnectors). `query` filters WITHIN every
 * section (substring over name/description/category); sections that end up empty
 * are dropped.
 */
export function buildConnectorSections(
  catalog: KnownConnector[],
  recommendedIds: string[],
  query: string,
): SectionGroup[] {
  const q = query.trim().toLowerCase();
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const used = new Set<string>();

  const take = (c: KnownConnector): boolean => {
    if (used.has(c.id)) return false;
    used.add(c.id);
    return true;
  };

  // 1. By us — connectors we authored.
  const byUs = catalog.filter((c) => c.firstParty === true && take(c));

  // 2. Recommended — the scan result, in scan order, minus anything above.
  const recommended: KnownConnector[] = [];
  for (const id of recommendedIds) {
    const c = byId.get(id);
    if (c !== undefined && take(c)) recommended.push(c);
  }

  // 3. Official — the vendor's own servers, minus anything above.
  const official = catalog.filter((c) => c.official === true && take(c));

  // 4. Popular — everything else (curated flag OR fallthrough).
  const popular = catalog.filter((c) => take(c));

  const groups: Array<{ id: ConnectorSection; items: KnownConnector[] }> = [
    { id: 'by-us', items: byUs },
    { id: 'recommended', items: recommended },
    { id: 'official', items: official },
    { id: 'popular', items: popular },
  ];

  return groups
    .map(({ id, items }) => ({
      id,
      title: SECTION_TITLES[id],
      items: items.filter((c) => matchesQuery(c, q)),
    }))
    .filter((g) => g.items.length > 0);
}
