/** Shared layout atoms for the Settings panels (consistent spacing + labels). */
import type { ReactNode } from 'react';

export function SettingSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-heading text-text-primary">{title}</h2>
        {description !== undefined ? (
          <p className="mt-1 text-footnote text-text-muted">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border-default bg-bg-raised p-4">
      <div className="flex flex-col gap-1">
        <span className="text-body text-text-primary">{label}</span>
        {hint !== undefined ? <span className="text-footnote text-text-muted">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}
