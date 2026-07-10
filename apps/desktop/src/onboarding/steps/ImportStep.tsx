/**
 * Step 2 — what should we bring over? Toggle rows for MCP servers, theme, Codex
 * sessions (with a per-session picker from the cheap session index) and skills.
 * "Neither" sources see a start-fresh note instead.
 */
import { Badge, Checkbox } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { cx } from '../cx';
import { useOnboardingStore } from '../useOnboarding';

function ToggleRow({
  checked,
  onToggle,
  title,
  meta,
  children,
  testId,
}: {
  checked: boolean;
  onToggle: () => void;
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border border-border-default bg-bg-raised">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox (custom control) */}
      <label className="flex cursor-pointer items-center gap-3 p-3">
        <Checkbox checked={checked} onCheckedChange={() => onToggle()} data-testid={testId} />
        <span className="min-w-0 flex-1">
          <span className="text-body text-text-primary">{title}</span>
        </span>
        {meta}
      </label>
      {checked && children != null ? (
        <div className="border-border-subtle border-t px-3 pb-3">{children}</div>
      ) : null}
    </div>
  );
}

export function ImportStep() {
  const source = useOnboardingStore((s) => s.source);
  const claude = useOnboardingStore((s) => s.claude);
  const codex = useOnboardingStore((s) => s.codex);
  const sessions = useOnboardingStore((s) => s.sessions);
  const imports = useOnboardingStore((s) => s.imports);
  const selectedSessions = useOnboardingStore((s) => s.selectedSessions);
  const selectedSkills = useOnboardingStore((s) => s.selectedSkills);
  const toggleImport = useOnboardingStore((s) => s.toggleImport);
  const toggleSession = useOnboardingStore((s) => s.toggleSession);
  const toggleSkill = useOnboardingStore((s) => s.toggleSkill);

  if (source === 'neither') {
    return (
      <div className="rounded-lg border border-border-default border-dashed bg-bg-raised p-6 text-center">
        <p className="text-body text-text-primary">Starting fresh</p>
        <p className="mt-1 text-footnote text-text-muted">
          Nothing to import. You can connect apps and import sessions anytime from Settings.
        </p>
      </div>
    );
  }

  const mcpCount =
    source === 'claude' ? (claude?.mcpServers.length ?? 0) : (codex?.mcpServers.length ?? 0);
  const skills = codex?.skills ?? [];

  return (
    <div className="flex flex-col gap-3" data-testid="import-checklist">
      <ToggleRow
        testId="import-mcp"
        checked={imports.mcp}
        onToggle={() => toggleImport('mcp')}
        title="MCP servers"
        meta={
          <Badge tone={mcpCount > 0 ? 'accent' : 'default'} size="sm">
            {mcpCount}
          </Badge>
        }
      />

      <ToggleRow
        testId="import-theme"
        checked={imports.theme}
        onToggle={() => toggleImport('theme')}
        title={source === 'claude' ? 'Claude appearance' : 'Codex appearance'}
        meta={<span className="text-footnote text-text-muted">theme</span>}
      />

      {source === 'codex' ? (
        <>
          <ToggleRow
            testId="import-sessions"
            checked={imports.sessions}
            onToggle={() => toggleImport('sessions')}
            title="Past conversations"
            meta={
              <Badge tone={sessions.length > 0 ? 'accent' : 'default'} size="sm">
                {sessions.length}
              </Badge>
            }
          >
            <div className="mt-2 max-h-44 overflow-y-auto pd-scroll" data-testid="session-picker">
              {sessions.length === 0 ? (
                <p className="py-2 text-footnote text-text-muted">No Codex sessions found.</p>
              ) : (
                sessions.map((session) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox (custom control)
                  <label
                    key={session.file}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover"
                  >
                    <Checkbox
                      checked={selectedSessions.has(session.file)}
                      onCheckedChange={() => toggleSession(session.file)}
                    />
                    <span className="min-w-0 flex-1 truncate text-footnote text-text-secondary">
                      {session.threadName || 'Untitled session'}
                    </span>
                    <span className="shrink-0 text-caption text-text-muted">
                      {session.updatedAt.slice(0, 10)}
                    </span>
                  </label>
                ))
              )}
            </div>
          </ToggleRow>

          <ToggleRow
            testId="import-skills"
            checked={imports.skills}
            onToggle={() => toggleImport('skills')}
            title="Skills"
            meta={
              <Badge tone={skills.length > 0 ? 'accent' : 'default'} size="sm">
                {skills.length}
              </Badge>
            }
          >
            <div className="mt-2 flex flex-wrap gap-1.5">
              {skills.length === 0 ? (
                <p className="py-1 text-footnote text-text-muted">No skills found.</p>
              ) : (
                skills.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleSkill(name)}
                    className={cx(
                      'rounded-md border px-2 py-1 text-caption transition-colors',
                      selectedSkills.has(name)
                        ? 'border-border-focus bg-accent-subtle text-text-primary'
                        : 'border-border-default text-text-muted hover:bg-bg-hover',
                    )}
                  >
                    {name}
                  </button>
                ))
              )}
            </div>
          </ToggleRow>
        </>
      ) : null}
    </div>
  );
}
