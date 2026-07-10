import type { ReactNode } from 'react';

/** Shared story scaffolding (labels/rows) — not a story file. */

export function Story({ children }: { children: ReactNode }) {
  return <div className="pd-story">{children}</div>;
}

export function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="pd-story-row">
      {label !== undefined ? <p className="pd-story-label">{label}</p> : null}
      {children}
    </div>
  );
}
