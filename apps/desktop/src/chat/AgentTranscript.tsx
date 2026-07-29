/**
 * ONE renderer for "an agent's conversation", whoever the agent is.
 *
 * jedd: "why don't we treat each subagent as a new individual chat exactly the
 * same, allowing for easy both display of the chats and following the actions
 * they're taking just the same — it's the exact same thing in my eyes."
 *
 * It was the same thing, rendered twice. `ChildChatView` grouped messages and
 * mapped them to {@link AssistantGroup} with one private helper; `CorpWorkerFeed`
 * did the same job through a second, and the main thread a third. They drifted,
 * as duplicated renderers do: the corp one showed tool rows with no output for
 * months while the chat showed them in full, and each parity fix had to be found
 * and applied in every copy.
 *
 * So the grouping, the result lookup and the user bubble live here, once. A
 * caller supplies the messages and whatever chrome is genuinely its own — a
 * briefing card, a back button, a live tail.
 */
import type { AssistantMsg, ChatMsg, ToolResultMsg } from '@pi-desktop/engine';
import { MessageRow } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { AssistantGroup } from './AssistantGroup';

/** A user turn, or a run of assistant messages with no user turn between them. */
type Item =
  | { kind: 'user'; text: string; images: readonly string[] }
  | { kind: 'assistant'; group: AssistantMsg[] };

/**
 * Group consecutive assistant messages into one run, so a turn that spanned
 * several messages reads as a single reply rather than a stack of fragments —
 * the same shape the main thread builds.
 */
export function groupAgentMessages(messages: readonly ChatMsg[]): Item[] {
  const items: Item[] = [];
  let run: AssistantMsg[] | undefined;
  for (const m of messages) {
    if (m.kind === 'assistant') {
      if (run === undefined) {
        run = [m];
        items.push({ kind: 'assistant', group: run });
      } else {
        run.push(m);
      }
      continue;
    }
    if (m.kind === 'user') {
      run = undefined;
      items.push({ kind: 'user', text: m.text, images: m.images ?? [] });
    }
    // A toolResult belongs to the run it answers, by id — never its own row.
  }
  return items;
}

/** Tool results by the call they answer — how a chain finds a row's body. */
export function resultsByCallId(messages: readonly ChatMsg[]): Map<string, ToolResultMsg> {
  const out = new Map<string, ToolResultMsg>();
  for (const m of messages) if (m.kind === 'toolResult') out.set(m.toolCallId, m);
  return out;
}

export interface AgentTranscriptProps {
  /** The agent's conversation so far. */
  readonly messages: readonly ChatMsg[];
  /** Tool calls still running — drives the shimmering live row. */
  readonly runningToolCalls?: readonly string[];
  /** Keep html/svg fences out of the thread (the corp routes them to the canvas). */
  readonly suppressInlineArtifacts?: boolean;
  readonly onOpenFile?: (path: string) => void;
  /** Shown when there is nothing yet — say WHY, never leave a blank pane. */
  readonly empty?: ReactNode;
}

/** An agent's conversation, rendered exactly as the main chat renders one. */
export function AgentTranscript({
  messages,
  runningToolCalls,
  suppressInlineArtifacts,
  onOpenFile,
  empty,
}: AgentTranscriptProps): ReactNode {
  const items = groupAgentMessages(messages);
  const resultByCallId = resultsByCallId(messages);
  if (items.length === 0) return empty ?? null;
  return (
    <>
      {items.map((item, i) =>
        item.kind === 'user' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, read-only list
          <MessageRow key={`u${i}`} kind="user">
            <div className="flex flex-col gap-2">
              {item.images.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {item.images.map((src) => (
                    // biome-ignore lint/a11y/useAltText: user attachment thumbnail
                    <img key={src} src={src} className="max-h-32 rounded-md" />
                  ))}
                </div>
              ) : null}
              {item.text.length > 0 ? (
                <span className="whitespace-pre-wrap">{item.text}</span>
              ) : null}
            </div>
          </MessageRow>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, read-only list
          <MessageRow key={`g${i}`} kind="assistant">
            <AssistantGroup
              group={item.group}
              resultByCallId={resultByCallId}
              runningToolCalls={[...(runningToolCalls ?? [])]}
              tps={undefined}
              {...(suppressInlineArtifacts === true ? { suppressInlineArtifacts: true } : {})}
              {...(onOpenFile !== undefined ? { onOpenFile } : {})}
            />
          </MessageRow>
        ),
      )}
    </>
  );
}
