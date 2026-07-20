import { IconCheck, IconChevronDown, IconFolderPlus, IconSearch } from '@pi-desktop/ui';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconFolder } from '../tab-icons.tsx';
import { useOutsideClose } from './use-outside-close.ts';

/** Fixed-viewport placement for the dropdown so it never clips off-screen. */
interface MenuPos {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/**
 * Place the "Search projects" dropdown in FIXED/viewport coords so it is never
 * clipped (round-10 #10): it opens below the chip, but FLIPS above when there
 * isn't room below (the picker sits near the bottom of the window, above the
 * composer), and clamps its left edge + height to the viewport. Pure so it's
 * unit-testable; returns null with no anchor / outside a DOM.
 */
export function placeProjectMenu(
  anchor: HTMLElement | null,
  viewport: { width: number; height: number } = {
    width: window.innerWidth,
    height: window.innerHeight,
  },
): MenuPos | null {
  if (!anchor) return null;
  const rect = anchor.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const width = Math.min(280, viewport.width - margin * 2);
  const left = Math.max(margin, Math.min(rect.left, viewport.width - width - margin));
  const spaceBelow = viewport.height - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;
  // Prefer below; flip up when below is tight AND there's more room above.
  const flipUp = spaceBelow < 240 && spaceAbove > spaceBelow;
  return flipUp
    ? {
        left,
        width,
        bottom: viewport.height - rect.top + gap,
        maxHeight: Math.max(140, spaceAbove),
      }
    : { left, width, top: rect.bottom + gap, maxHeight: Math.max(140, spaceBelow) };
}

function menuStyle(pos: MenuPos): CSSProperties {
  return {
    position: 'fixed',
    left: pos.left,
    right: 'auto',
    top: pos.top,
    bottom: pos.bottom,
    width: pos.width,
    maxHeight: pos.maxHeight,
    overflowY: 'auto',
  };
}

/** One selectable project (pure data — no UI coupling). */
export interface ProjectPickerItem {
  id: string;
  name: string;
}

export interface ProjectPickerProps {
  /** Projects to list (filtered locally by the search box). */
  projects: ProjectPickerItem[];
  /** The active project id, or null when working outside a project. */
  active?: string | null;
  /** A project row was chosen. */
  onSelect: (id: string) => void;
  /** "New project" chosen — the app creates + activates it. */
  onNew: () => void;
  /** "Don't work in a project" chosen — the app clears the working folder. */
  onClear: () => void;
  /** Optional live search hook (fires on every keystroke; local filter still runs). */
  onSearch?: (query: string) => void;
  /** Chip label shown when no project is active. */
  placeholder?: string;
  className?: string;
}

/**
 * ProjectPicker — the presentational "📁 <project>" chip (img66/67) that opens a
 * "Search projects" popover: a filter input over the project list (a ✓ on the
 * active one), then "New project" + "Don't work in a project". Pure UI — the app
 * owns the project data + the working folder (which scopes the file tree + cwd).
 * Renders above the composer in the app; lives here for reuse.
 */
export function ProjectPicker({
  projects,
  active,
  onSelect,
  onNew,
  onClear,
  onSearch,
  placeholder = 'No project',
  className,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<MenuPos | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu is PORTALED to <body> (below) so `.pd-composer`'s backdrop-filter
  // can't trap its position:fixed — pass menuRef so a click inside the portaled
  // menu isn't treated as an outside dismiss.
  useOutsideClose(ref, open, () => setOpen(false), menuRef);

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    setPos(placeProjectMenu(chipRef.current));
    setOpen(true);
  };

  // Keep the placement correct if the window resizes / scrolls while open.
  useEffect(() => {
    if (!open) return;
    const update = (): void => setPos(placeProjectMenu(chipRef.current));
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const activeProject = active != null ? projects.find((p) => p.id === active) : undefined;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  const rootClass = ['pd-project-picker', className].filter(Boolean).join(' ');
  const pick = (fn: () => void): void => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className={rootClass}>
      <button
        ref={chipRef}
        type="button"
        className="pd-project-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="pd-project-chip-icon" aria-hidden="true">
          <IconFolder size={14} />
        </span>
        <span className="pd-project-chip-label">{activeProject?.name ?? placeholder}</span>
        <IconChevronDown size={12} />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="pd-menu pd-project-menu"
              role="menu"
              style={pos ? menuStyle(pos) : undefined}
            >
              <div className="pd-project-search">
            <IconSearch size={14} />
            <input
              className="pd-project-search-input"
              type="text"
              placeholder="Search projects"
              aria-label="Search projects"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                onSearch?.(event.target.value);
              }}
            />
          </div>
          {filtered.length > 0 ? (
            filtered.map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitemradio"
                aria-checked={project.id === active}
                className={`pd-menu-item${project.id === active ? ' pd-menu-item--current' : ''}`}
                onClick={() => pick(() => onSelect(project.id))}
              >
                <span className="pd-menu-icon" aria-hidden="true">
                  <IconFolder size={16} />
                </span>
                <span className="pd-project-name">{project.name}</span>
                {project.id === active ? (
                  <span className="pd-menu-check" aria-hidden="true">
                    <IconCheck size={14} />
                  </span>
                ) : null}
              </button>
            ))
          ) : (
            <p className="pd-project-empty">No matching projects</p>
          )}
          <div className="pd-menu-separator" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="pd-menu-item"
            onClick={() => pick(onNew)}
          >
            <span className="pd-menu-icon" aria-hidden="true">
              <IconFolderPlus size={16} />
            </span>
            New project
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={active == null}
            className={`pd-menu-item${active == null ? ' pd-menu-item--current' : ''}`}
            onClick={() => pick(onClear)}
          >
            <span className="pd-menu-icon" aria-hidden="true">
              {/* Folder with a slash — "no working folder". */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <line x1="3.5" y1="3.5" x2="20.5" y2="20.5" />
              </svg>
            </span>
            <span className="pd-project-name">Don't work in a project</span>
            {active == null ? (
              <span className="pd-menu-check" aria-hidden="true">
                <IconCheck size={14} />
              </span>
            ) : null}
          </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
