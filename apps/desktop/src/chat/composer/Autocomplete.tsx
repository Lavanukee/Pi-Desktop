/**
 * Codex-style autocomplete popover for @-mentions and /commands. Presentational:
 * the parent owns the item list, selection index, and pick handler. Anchored
 * above the composer input; sections group files/skills/plugins/commands.
 */
import { IconFile, IconSearch, IconTerminal, Kbd } from '@pi-desktop/ui';
import type { ReactNode } from 'react';

export type AcItemKind = 'file' | 'command' | 'plugin' | 'skill';

export interface AcItem {
  /** The literal text spliced into the editor when picked (e.g. `@src/x.ts`). */
  id: string;
  label: string;
  subtitle?: string;
  section?: string;
  kind: AcItemKind;
}

function iconFor(kind: AcItemKind): ReactNode {
  switch (kind) {
    case 'command':
      return <IconTerminal size={14} />;
    case 'skill':
    case 'plugin':
      return <IconSearch size={14} />;
    default:
      return <IconFile size={14} />;
  }
}

export function Autocomplete({
  items,
  selectedIndex,
  onPick,
  onHover,
}: {
  items: AcItem[];
  selectedIndex: number;
  onPick: (item: AcItem) => void;
  onHover: (index: number) => void;
}) {
  if (items.length === 0) return null;

  let lastSection: string | undefined;
  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-[min(28rem,90vw)] overflow-y-auto rounded-lg border border-border-default bg-bg-overlay p-1 shadow-popover"
      data-testid="composer-autocomplete"
      role="listbox"
    >
      {items.map((item, index) => {
        const header = item.section !== undefined && item.section !== lastSection;
        lastSection = item.section;
        return (
          <div key={item.id}>
            {header ? (
              <div className="px-2 pb-0.5 pt-1.5 text-caption uppercase tracking-wider text-text-muted">
                {item.section}
              </div>
            ) : null}
            <div
              role="option"
              tabIndex={-1}
              aria-selected={index === selectedIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(item);
              }}
              onMouseEnter={() => onHover(index)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 ${
                index === selectedIndex ? 'bg-bg-active' : ''
              }`}
            >
              <span className="text-text-muted">{iconFor(item.kind)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-footnote text-text-primary">{item.label}</div>
                {item.subtitle !== undefined ? (
                  <div className="truncate text-caption text-text-muted">{item.subtitle}</div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-1.5 px-2 pb-0.5 pt-1 text-caption text-text-muted">
        <Kbd keys="↑↓" appearance="bare" /> navigate
        <Kbd keys="tab" appearance="bare" /> accept
      </div>
    </div>
  );
}
