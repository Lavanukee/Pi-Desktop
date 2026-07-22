/**
 * Pure transcript-fold primitives — the building blocks that turn a stream of
 * StoreSink callbacks into a `ChatMsg[]`. Shared by the main chat store
 * (pi-slice) and the child-agent store (child-agent-store) so a subagent/role
 * renders through the EXACT same fold as the main chat, not a parallel copy.
 */
import type { AssistantMsg, ChatMsg, ToolResultMsg } from '@pi-desktop/engine';

/** Map the assistant message with `id`, leaving every other row untouched. */
export function mutateAssistant(
  messages: ChatMsg[],
  id: string,
  mutate: (msg: AssistantMsg) => AssistantMsg,
): ChatMsg[] {
  return messages.map((m) => (m.kind === 'assistant' && m.id === id ? mutate(m) : m));
}

/** Append a text/thinking delta onto the assistant's LAST block of that kind,
 * or start a new block — the token-append that produces the streaming look. */
export function appendOrMergeBlock(
  messages: ChatMsg[],
  id: string,
  kind: 'text' | 'thinking',
  delta: string,
): ChatMsg[] {
  return mutateAssistant(messages, id, (m) => {
    const blocks = [...m.blocks];
    const last = blocks[blocks.length - 1];
    if (kind === 'text') {
      if (last?.type === 'text')
        blocks[blocks.length - 1] = { type: 'text', text: last.text + delta };
      else blocks.push({ type: 'text', text: delta });
    } else {
      if (last?.type === 'thinking') {
        blocks[blocks.length - 1] = { type: 'thinking', thinking: last.thinking + delta };
      } else {
        blocks.push({ type: 'thinking', thinking: delta });
      }
    }
    return { ...m, blocks };
  });
}

/** Insert-or-replace a tool result keyed by its (assistant-scoped) row id —
 * providers reuse toolCallIds across runs, so match on `id`, never toolCallId. */
export function upsertToolResultMsg(messages: ChatMsg[], result: ToolResultMsg): ChatMsg[] {
  const existing = messages.findIndex((m) => m.kind === 'toolResult' && m.id === result.id);
  return existing >= 0
    ? messages.map((m, i) => (i === existing ? result : m))
    : [...messages, result];
}
