/**
 * Read-only transcript view of a CHILD agent (a subagent / role running as its
 * own app-owned pi instance — MP1/MP2). Renders the child's ChatMsg[] through the
 * SAME AssistantGroup the main chat uses, so its user prompt, thinking blocks,
 * tool rows and responses look exactly like a normal chat — just not typeable.
 *
 * Selected from the nested sidebar dropdown (childAgentStore.viewedChildId); a
 * back affordance returns to the main chat.
 */
import { IconChevronDown, Spinner } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { useChildAgentStore } from '../state/child-agent-store';
import { AgentTranscript } from './AgentTranscript';

export function ChildChatView({ childId }: { childId: string }): ReactNode {
  const entry = useChildAgentStore((s) => s.children[childId]);
  const setViewedChild = useChildAgentStore((s) => s.setViewedChild);
  if (entry === undefined) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="child-chat-view">
      {/* Header: back to the main chat + the child's title/status. */}
      <div className="flex items-center gap-2 px-4 py-2 text-body text-text-secondary">
        <button
          type="button"
          className="pd-focusable flex items-center gap-1 rounded-md px-1.5 py-0.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          onClick={() => setViewedChild(null)}
          data-testid="child-chat-back"
        >
          <IconChevronDown size={14} className="rotate-90" />
          Back
        </button>
        <span className="text-text-muted">·</span>
        <span className="truncate font-medium text-text-primary">{entry.title}</span>
        {entry.running ? <Spinner size={13} /> : null}
      </div>

      {/* The transcript, through the ONE agent renderer the whole app uses —
          so a fix to how a tool row or a thought looks lands here too. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <AgentTranscript
            messages={entry.messages}
            empty={
              <div className="py-8 text-center text-body text-text-muted">
                {entry.running ? 'Starting…' : 'No activity yet.'}
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}
