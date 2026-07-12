/**
 * The connectors screen's **Skills** tab. Lists the bundled skill catalog with a
 * description, a source/license badge, and an install/enable toggle that copies
 * the skill into `~/.pi/agent/skills/<id>` (or removes it) via the skills store.
 * The pi engine auto-discovers an installed skill on the next session.
 *
 * A row now OPENS a {@link SkillDetail} (reads the SKILL.md body) — mirroring the
 * connector selection — so a skill's playbook is finally readable, not just
 * toggleable. Owns only this tab; the Plugins tab is untouched.
 */
import { Badge, SearchInput, Spinner, Switch } from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import type { SkillListItem } from '../../electron/skills/skills-contract';
import { useSkillsStore } from '../state/skills-store';
import { SkillDetail } from './SkillDetail';

function SkillRow({
  skill,
  busy,
  onOpen,
  onToggle,
}: {
  skill: SkillListItem;
  busy: boolean;
  onOpen: () => void;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-border-default px-4 py-3 hover:bg-bg-hover"
      data-testid={`skill-card-${skill.id}`}
    >
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-body text-text-primary">{skill.name}</span>
          <Badge tone={skill.license === 'Apache-2.0' ? 'info' : 'default'}>{skill.license}</Badge>
          {skill.source === 'anthropics/skills' ? (
            <Badge tone="default">anthropics/skills</Badge>
          ) : null}
          {skill.recommended ? <Badge tone="success">Recommended</Badge> : null}
        </span>
        <span className="mt-0.5 block text-footnote text-text-muted">{skill.description}</span>
      </button>
      <span className="flex shrink-0 items-center gap-2">
        {busy ? <Spinner size={16} /> : null}
        <Switch
          aria-label={`${skill.installed ? 'Remove' : 'Install'} ${skill.name}`}
          data-testid={`skill-toggle-${skill.id}`}
          checked={skill.installed}
          disabled={busy}
          onCheckedChange={(v) => onToggle(v === true)}
        />
      </span>
    </div>
  );
}

export function SkillsTab() {
  const skills = useSkillsStore((s) => s.skills);
  const loaded = useSkillsStore((s) => s.loaded);
  const busyId = useSkillsStore((s) => s.busyId);
  const error = useSkillsStore((s) => s.error);
  const load = useSkillsStore((s) => s.load);
  const toggle = useSkillsStore((s) => s.toggle);

  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q.length === 0
        ? skills
        : skills.filter(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q) ||
              s.category.includes(q),
          ),
    [skills, q],
  );
  const installedCount = skills.filter((s) => s.installed).length;
  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) ?? null,
    [skills, selectedId],
  );

  if (!loaded) {
    return (
      <div className="flex justify-center py-16" data-testid="connectors-skills">
        <Spinner size={18} />
      </div>
    );
  }

  if (selected !== null) {
    return (
      <SkillDetail
        skill={selected}
        busy={busyId === selected.id}
        onBack={() => setSelectedId(null)}
        onToggle={(next) => void toggle(selected.id, next)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="connectors-skills">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-footnote text-text-muted">
          Skills are saved playbooks Pi follows. Enable one to copy it into your agent —
          {installedCount > 0 ? ` ${installedCount} enabled.` : ' none enabled yet.'}
        </p>
      </div>

      <SearchInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search skills"
        data-testid="skills-search"
      />

      {error !== null ? (
        <p className="text-footnote text-status-danger-fg" data-testid="skills-error">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        {filtered.length === 0 ? (
          <p className="text-footnote text-text-muted">No skills match your search.</p>
        ) : (
          filtered.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              busy={busyId === skill.id}
              onOpen={() => setSelectedId(skill.id)}
              onToggle={(next) => void toggle(skill.id, next)}
            />
          ))
        )}
      </div>
    </div>
  );
}
