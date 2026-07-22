/**
 * Read-only transcript view of a CHILD agent (a subagent / role running as its
 * own app-owned pi instance — MP1/MP2). Renders the child's ChatMsg[] through the
 * SAME AssistantGroup the main chat uses, so its user prompt, thinking blocks,
 * tool rows and responses look exactly like a normal chat — just not typeable.
 *
 * Selected from the nested sidebar dropdown (childAgentStore.viewedChildId); a
 * back affordance returns to the main chat.
 */
import type { AssistantMsg, ChatMsg, ToolResultMsg } from '@pi-desktop/engine';
import { IconChevronDown, Spinner } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { useChildAgentStore } from '../state/child-agent-store';
import { AssistantGroup } from './AssistantGroup';

type Item =
  | { kind: 'user'; message: Extract<ChatMsg, { kind: 'user' }> }
  | { kind: 'group'; group: AssistantMsg[] };

/** Group consecutive assistant messages (no user turn between) into one group —
 * the same coalescing rule the main thread uses. */
function toItems(messages: ChatMsg[]): Item[] {
  const items: Item[] = [];
  let group: AssistantMsg[] = [];
  const flush = (): void => {
    if (group.length > 0) items.push({ kind: 'group', group });
    group = [];
  };
  for (const m of messages) {
    if (m.kind === 'assistant') {
      group.push(m);
    } else if (m.kind === 'user') {
      flush();
      items.push({ kind: 'user', message: m });
    }
    // toolResult rows are consumed via resultByCallId, not rendered standalone.
  }
  flush();
  return items;
}

export function ChildChatView({ childId }: { childId: string }): ReactNode {
  const entry = useChildAgentStore((s) => s.children[childId]);
  const setViewedChild = useChildAgentStore((s) => s.setViewedChild);
  if (entry === undefined) return null;

  const resultByCallId = new Map<string, ToolResultMsg>();
  for (const m of entry.messages) {
    if (m.kind === 'toolResult') resultByCallId.set(m.toolCallId, m);
  }
  const items = toItems(entry.messages);

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

      {/* The transcript, rendered through the same components as the main chat. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {items.map((item, i) =>
            item.kind === 'user' ? (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: read-only static list
                key={`u${i}`}
                className="self-end rounded-2xl bg-bg-elevated px-4 py-2 text-body text-text-primary"
              >
                {item.message.text}
              </div>
            ) : (
              <AssistantGroup
                // biome-ignore lint/suspicious/noArrayIndexKey: read-only static list
                key={`g${i}`}
                group={item.group}
                resultByCallId={resultByCallId}
                runningToolCalls={[]}
                tps={undefined}
              />
            ),
          )}
          {items.length === 0 ? (
            <div className="py-8 text-center text-body text-text-muted">
              {entry.running ? 'Starting…' : 'No activity yet.'}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
