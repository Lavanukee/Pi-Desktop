import { IconCheck, IconClose, ShimmerText, Spinner } from '@pi-desktop/ui';
import { IconSubagent } from '../tab-icons.tsx';
import type { SubagentItem } from '../tabs/tab-model.ts';

export type { SubagentItem };

export interface SubagentSurfaceProps {
  subagents: SubagentItem[];
  onSelect?: (id: string) => void;
  className?: string;
}

function StatusGlyph({ status }: { status: SubagentItem['status'] }) {
  if (status === 'running') return <Spinner size={13} />;
  if (status === 'done') return <IconCheck size={14} />;
  if (status === 'error') return <IconClose size={14} />;
  return <IconSubagent size={14} />;
}

/**
 * SubagentSurface — a compact live list of subagents and their current step,
 * reusing the activity look (spinner while running, shimmered step text, check
 * on done). Pure/props-driven: the app feeds `subagents` and updates them via
 * `controller.updateTab(id, { subagents })`.
 */
export function SubagentSurface({ subagents, onSelect, className }: SubagentSurfaceProps) {
  const rootClass = ['pd-subagent-list', 'pd-scroll', className].filter(Boolean).join(' ');
  if (subagents.length === 0) {
    return (
      <div className={rootClass}>
        <div className="pd-subagent-empty">No subagents running</div>
      </div>
    );
  }
  return (
    <div className={rootClass}>
      {subagents.map((agent) => {
        const running = agent.status === 'running';
        return (
          <button
            key={agent.id}
            type="button"
            className="pd-subagent-row"
            data-status={agent.status ?? 'queued'}
            onClick={() => onSelect?.(agent.id)}
          >
            <span className="pd-subagent-glyph">
              <StatusGlyph status={agent.status} />
            </span>
            <span className="pd-subagent-text">
              <span className="pd-subagent-name">{agent.name}</span>
              {agent.step ? (
                <span className="pd-subagent-step">
                  {running ? <ShimmerText>{agent.step}</ShimmerText> : agent.step}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
