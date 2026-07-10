import { IconCheck, IconChevronDown, IconFolderPlus, IconSearch } from '@pi-desktop/ui';
import { useMemo, useRef, useState } from 'react';
import { IconFolder } from '../tab-icons.tsx';
import { useOutsideClose } from './use-outside-close.ts';

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
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));

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
        type="button"
        className="pd-project-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pd-project-chip-icon" aria-hidden="true">
          <IconFolder size={14} />
        </span>
        <span className="pd-project-chip-label">{activeProject?.name ?? placeholder}</span>
        <IconChevronDown size={12} />
      </button>
      {open ? (
        <div className="pd-menu pd-canvas-popmenu" data-align="start" role="menu">
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
                className="pd-menu-item"
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
            role="menuitem"
            className="pd-menu-item"
            onClick={() => pick(onClear)}
          >
            <span className="pd-menu-icon" aria-hidden="true" />
            Don't work in a project
          </button>
        </div>
      ) : null}
    </div>
  );
}
