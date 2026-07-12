/**
 * A skill detail view — finally lets you READ a skill's playbook before
 * enabling it (the Skills tab previously had no detail at all). Reads the
 * bundled SKILL.md via skills:read (traversal-fenced main-side) and renders it
 * as markdown, alongside the source/license badges and the install Switch.
 */
import { Badge, IconChevronLeft, Markdown, Spinner, Switch } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import type { SkillListItem } from '../../electron/skills/skills-contract';
import { useSkillsStore } from '../state/skills-store';

export function SkillDetail({
  skill,
  busy,
  onBack,
  onToggle,
}: {
  skill: SkillListItem;
  busy: boolean;
  onBack: () => void;
  onToggle: (next: boolean) => void;
}) {
  const readSkill = useSkillsStore((s) => s.readSkill);
  const [state, setState] = useState<{ loading: boolean; body: string; error?: string }>({
    loading: true,
    body: '',
  });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, body: '' });
    void readSkill(skill.id).then((res) => {
      if (cancelled) return;
      setState({ loading: false, body: res.body, error: res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [readSkill, skill.id]);

  return (
    <div className="mx-auto max-w-[720px] px-8 py-6" data-testid="skill-detail">
      <button
        type="button"
        onClick={onBack}
        data-testid="skill-detail-back"
        className="mb-5 inline-flex items-center gap-1 rounded-lg py-1 pr-2 pl-1 text-footnote text-text-secondary hover:bg-bg-hover"
      >
        <IconChevronLeft size={14} />
        Skills
      </button>

      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-heading text-text-primary">{skill.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={skill.license === 'Apache-2.0' ? 'info' : 'default'}>
              {skill.license}
            </Badge>
            {skill.source === 'anthropics/skills' ? (
              <Badge tone="default">anthropics/skills</Badge>
            ) : null}
            {skill.recommended ? <Badge tone="success">Recommended</Badge> : null}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {busy ? <Spinner size={16} /> : null}
          <Switch
            aria-label={`${skill.installed ? 'Remove' : 'Install'} ${skill.name}`}
            data-testid={`skill-detail-toggle-${skill.id}`}
            checked={skill.installed}
            disabled={busy}
            onCheckedChange={(v) => onToggle(v === true)}
          />
        </span>
      </div>

      {state.loading ? (
        <div className="flex justify-center py-12">
          <Spinner size={18} />
        </div>
      ) : state.error !== undefined ? (
        <p className="text-footnote text-status-danger-fg" data-testid="skill-detail-error">
          {state.error}
        </p>
      ) : (
        <Markdown data-testid="skill-detail-body">{state.body}</Markdown>
      )}
    </div>
  );
}
