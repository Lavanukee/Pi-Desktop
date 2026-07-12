/**
 * A titled 2-column grid of connector cards (one gallery section: By us /
 * Recommended for you / Official / Popular). Heading rhythm + column count are
 * owner-validated (FEEL); the section testid is the fleet contract.
 */
import type { ReactNode } from 'react';
import type { ConnectorSection as SectionId } from './connector-sections';

export function ConnectorSection({
  id,
  title,
  count,
  children,
}: {
  id: SectionId;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section data-testid={`connectors-section-${id}`}>
      <h2 className="mb-2 flex items-center gap-2 text-body text-text-primary">
        {title}
        {count !== undefined ? <span className="text-text-muted">{count}</span> : null}
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{children}</div>
    </section>
  );
}
