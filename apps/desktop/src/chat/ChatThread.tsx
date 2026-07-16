/**
 * Streamed conversation view: renders pi-slice `messages` through the design
 * system. Consecutive assistant messages with NO user turn between them (pi
 * models each agentic iteration as its own message) are merged into ONE
 * response unit so their tool/thinking runs collapse into a single Activity
 * CHAIN (THEME 3). User bubbles, assistant text (markdown), standalone
 * thoughts, inline generated images (round-5 #7), the response speed shown as a
 * message-action-bar item (Wave B #2 — the pinned tok/s footnote was removed;
 * the raw model-id footnote earlier, #11), the ONE consolidated live status
 * indicator ({@link ThreadStatusIndicator}, jedd blind-test #1) while streaming,
 * inline artifact widgets (THEME 2), and auto-scroll.
 */
import type {
  AssistantMsg,
  BashExecMsg,
  ChatMsg,
  ContentBlock,
  ToolResultMsg,
  UserMsg,
} from '@pi-desktop/engine';
import {
  ActivityRow,
  BranchSwitcher,
  EditableMessage,
  IconTerminal,
  MessageActions,
  MessageRow,
  ScrollArea,
  Thread,
} from '@pi-desktop/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useLlmStore } from '../state/llm-store';
import { forkAndReprompt, sendPrompt, switchBranch } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { generatedImageSrc, segmentGroup } from './activity-mapping';
import { InlineArtifact } from './canvas/InlineArtifacts';
import { HarnessChecklistPanel, ThreadStatusIndicator } from './HarnessStatus';
import { Markdown } from './markdown';
import { ThreadActivityChain } from './ThreadActivity';
import { ThreadImage } from './ThreadImage';

/** Concatenated visible text of an assistant response group (for copy). */
function groupPlainText(group: AssistantMsg[]): string {
  return group
    .flatMap((m) => m.blocks)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** One rendered row in the thread. */
type RenderItem =
  | { kind: 'user'; message: UserMsg }
  | { kind: 'bash'; message: BashExecMsg }
  | { kind: 'orphanTool'; message: ToolResultMsg }
  | { kind: 'assistant'; group: AssistantMsg[] };

/** Coalesce consecutive assistant messages (no user turn between) into groups. */
function toRenderItems(messages: ChatMsg[], claimed: Set<string>): RenderItem[] {
  const items: RenderItem[] = [];
  let group: AssistantMsg[] = [];
  const flush = () => {
    if (group.length > 0) items.push({ kind: 'assistant', group });
    group = [];
  };
  for (const m of messages) {
    if (m.kind === 'assistant') {
      group.push(m);
      continue;
    }
    // A claimed tool result belongs to the in-flight response (pi interleaves
    // result rows between the agent-iteration messages) — it must NOT split the
    // group, or each iteration's tool would render as its own chain.
    if (m.kind === 'toolResult' && claimed.has(m.toolCallId)) continue;
    flush();
    if (m.kind === 'user') items.push({ kind: 'user', message: m });
    else if (m.kind === 'bashExec') items.push({ kind: 'bash', message: m });
    else if (m.kind === 'toolResult') items.push({ kind: 'orphanTool', message: m });
  }
  flush();
  return items;
}

function AssistantGroup({
  group,
  resultByCallId,
  runningToolCalls,
  tps,
}: {
  group: AssistantMsg[];
  resultByCallId: Map<string, ToolResultMsg>;
  runningToolCalls: string[];
  /** Current throughput from the inference supervisor (assistant footnote). */
  tps: number | undefined;
}): ReactNode {
  const streaming = group.some((m) => m.isStreaming === true);
  // Owner-scoped result per tool-call id (avoids a bare-id collision with a
  // provider-reused toolCallId in a later user turn).
  const resultForBlock = new Map<string, ToolResultMsg>();
  for (const m of group) {
    for (const b of m.blocks) {
      if (b.type !== 'toolCall') continue;
      const r = resultByCallId.get(`${m.id}:${b.id}`) ?? resultByCallId.get(b.id);
      if (r !== undefined) resultForBlock.set(b.id, r);
    }
  }

  const segments = segmentGroup(group);
  const lastSegment = segments[segments.length - 1];
  const groupId = group[0]?.id ?? 'g';
  const errorMessage = group.find((m) => m.errorMessage !== undefined)?.errorMessage;
  let textN = 0;
  let activityN = 0;
  return (
    // min-w-0 so this flex child can shrink below its content's intrinsic width
    // and the prose reflows when the canvas narrows the column (blindtest #9).
    <div className="flex min-w-0 flex-col gap-2">
      {segments.map((seg) => {
        if (seg.kind === 'text') {
          return <Markdown key={`${groupId}-t${textN++}`} text={seg.text} />;
        }
        if (seg.kind === 'artifact') {
          return <InlineArtifact key={seg.artifact.id} artifact={seg.artifact} />;
        }
        // Round-6 UNIFY: a tool chain AND a thinking-only run both render through
        // ONE ActivityChain, so every thought gets the chain chrome (clock icon +
        // connector line + "Done ✓"). ONE shared counter keys both kinds, so a run
        // that starts thinking-only and later gains a tool call keeps the SAME
        // component instance (no remount → the expand/collapse rolls smoothly).
        // Generated images a chain produced render INLINE beneath it (round-5 #7);
        // a thinking-only run never has tool calls, so it contributes none.
        const chainImages =
          seg.kind === 'chain'
            ? seg.blocks
                .filter(
                  (b): b is Extract<ContentBlock, { type: 'toolCall' }> => b.type === 'toolCall',
                )
                .map((b) => ({ id: b.id, src: generatedImageSrc(b, resultForBlock.get(b.id)) }))
                .filter((x): x is { id: string; src: string } => x.src !== undefined)
            : [];
        return (
          <div key={`${groupId}-a${activityN++}`} className="flex min-w-0 flex-col gap-2">
            <ThreadActivityChain
              blocks={seg.blocks}
              resultForBlock={resultForBlock}
              runningToolCalls={runningToolCalls}
              streaming={streaming && seg === lastSegment}
              turnStartedAt={group[0]?.timestamp}
              tps={tps}
            />
            {chainImages.map((img) => (
              <ThreadImage key={img.id} src={img.src} />
            ))}
          </div>
        );
      })}
      {errorMessage !== undefined ? (
        <div className="text-footnote text-status-danger-fg">{errorMessage}</div>
      ) : null}
    </div>
  );
}

export function ChatThread() {
  const messages = usePiStore((s) => s.messages);
  const runningToolCalls = usePiStore((s) => s.runningToolCalls);
  const historyTruncated = usePiStore((s) => s.historyTruncated);
  const branches = usePiStore((s) => s.branches);
  const tps = useLlmStore((s) => s.status.metrics?.avgTps ?? s.status.metrics?.lastTps);

  const [editingId, setEditingId] = useState<string | null>(null);

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };
  // Retry: re-send the user turn that preceded this assistant response.
  const retryFrom = (firstAssistantId: string) => {
    const idx = messages.findIndex((m) => m.id === firstAssistantId);
    for (let i = idx - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.kind === 'user') {
        void sendPrompt(m.text);
        return;
      }
    }
  };
  // Inline edit (round-3 #A9): clicking Edit flips THAT user bubble into an
  // editable textarea (EditableMessage). Saving FORKS a new pi branch at that
  // message (pi:fork/pi:get-fork-messages) and streams the edited turn into it,
  // so the message now carries alternates surfaced by the BranchSwitcher below.
  const saveEdit = (text: string) => {
    const id = editingId;
    setEditingId(null);
    if (id !== null) void forkAndReprompt(id, text);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  // Autoscroll "stick": true only while the user is parked at the bottom. It is
  // released the instant the user scrolls UP (free-scroll during generation,
  // round-8) and re-armed only when they return to the bottom — so a burst of
  // streaming re-renders can never yank the view back down while they read above.
  const pinnedRef = useRef(true);

  // Re-arm the stick only when genuinely back at the bottom (tight threshold so
  // scrolling even slightly up stays released).
  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
  };

  // Release the stick on any explicit upward intent BEFORE the next streaming
  // render can re-pin. Wheel/touch/keys fire ahead of the scroll event — which
  // is exactly where the old snap-back race lived — so releasing here lets the
  // user scroll up freely and STAY there mid-generation.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const releaseUp = () => {
      pinnedRef.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) releaseUp();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') releaseUp();
    };
    let lastY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > lastY + 1) releaseUp(); // finger drags down → content moves up
      lastY = y;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // Keep the newest content in view ONLY while pinned (never fights a scroll-up).
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && pinnedRef.current) el.scrollTop = el.scrollHeight;
  });

  // Index tool results by both the assistant-scoped id and the bare callId so a
  // tool call finds its result whether streamed live or rehydrated.
  const resultByCallId = new Map<string, ToolResultMsg>();
  const claimed = new Set<string>();
  for (const m of messages) {
    if (m.kind === 'assistant') {
      for (const b of m.blocks) if (b.type === 'toolCall') claimed.add(b.id);
    }
  }
  for (const m of messages) {
    if (m.kind === 'toolResult') {
      resultByCallId.set(m.toolCallId, m);
      if (m.assistantId !== undefined) resultByCallId.set(`${m.assistantId}:${m.toolCallId}`, m);
    }
  }

  // User-message ordinal (0-based among user messages) — the key the fork
  // registry uses to attach a BranchSwitcher to the right bubble.
  const userOrdinalById = new Map<string, number>();
  {
    let n = -1;
    for (const m of messages) if (m.kind === 'user') userOrdinalById.set(m.id, ++n);
  }

  const items = toRenderItems(messages, claimed);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The live task checklist stays pinned above the scrolling transcript so
          the user watches items flip pending → in_progress → done during a task. */}
      <HarnessChecklistPanel />
      <ScrollArea
        ref={scrollRef}
        onScroll={onScroll}
        className="pd-elastic-scroll min-h-0 flex-1"
        data-testid="chat-scroll"
      >
        <Thread>
          {historyTruncated ? (
            <div className="pb-2 text-center text-footnote text-text-muted">
              Earlier messages were truncated when this session was restored.
            </div>
          ) : null}

          {items.map((item) => {
            if (item.kind === 'user') {
              const message = item.message;
              const ordinal = userOrdinalById.get(message.id) ?? -1;
              const group = branches[ordinal];
              // A message with alternates shows a persistent ‹ n / m › switcher
              // beneath its bubble (kept out of the hover-only action bar so the
              // alternates are always discoverable).
              const switcher =
                group !== undefined && group.files.length > 1 ? (
                  <div className="flex justify-end">
                    <BranchSwitcher
                      data-testid="branch-switcher"
                      index={group.active}
                      total={group.files.length}
                      onPrev={() => void switchBranch(ordinal, group.active - 1)}
                      onNext={() => void switchBranch(ordinal, group.active + 1)}
                    />
                  </div>
                ) : null;

              // Inline edit mode: the bubble becomes an editable textarea (#A9).
              if (editingId === message.id) {
                return (
                  <div key={message.id} className="flex flex-col gap-1">
                    <EditableMessage
                      data-testid="editing-message"
                      value={message.text}
                      editing
                      onSave={saveEdit}
                      onCancel={() => setEditingId(null)}
                    />
                    {switcher}
                  </div>
                );
              }
              return (
                <div key={message.id} className="flex flex-col gap-1">
                  <MessageRow
                    kind="user"
                    actions={
                      <MessageActions
                        onCopy={() => copyText(message.text)}
                        onEdit={() => setEditingId(message.id)}
                      />
                    }
                  >
                    <div className="flex flex-col gap-2">
                      {message.images !== undefined && message.images.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {message.images.map((src) => (
                            // biome-ignore lint/a11y/useAltText: user attachment thumbnail
                            <img key={src} src={src} className="max-h-32 rounded-md" />
                          ))}
                        </div>
                      ) : null}
                      {message.text.length > 0 ? (
                        <span className="whitespace-pre-wrap">{message.text}</span>
                      ) : null}
                    </div>
                  </MessageRow>
                  {switcher}
                </div>
              );
            }

            if (item.kind === 'assistant') {
              const group = item.group;
              const first = group[0];
              if (first === undefined) return null;
              const totalTokens = [...group].reverse().find((m) => m.usage !== undefined)
                ?.usage?.totalTokens;
              const streaming = group.some((m) => m.isStreaming === true);
              return (
                <MessageRow
                  key={first.id}
                  kind="assistant"
                  actions={
                    <MessageActions
                      onCopy={() => copyText(groupPlainText(group))}
                      onRetry={() => retryFrom(first.id)}
                      tokenCount={totalTokens}
                      tokensPerSecond={streaming ? undefined : tps}
                    />
                  }
                >
                  <AssistantGroup
                    group={group}
                    resultByCallId={resultByCallId}
                    runningToolCalls={runningToolCalls}
                    tps={streaming ? undefined : tps}
                  />
                </MessageRow>
              );
            }

            if (item.kind === 'bash') {
              const message = item.message;
              return (
                <ActivityRow
                  key={message.id}
                  icon={<IconTerminal size={14} />}
                  label={`! ${message.command}`}
                >
                  <pre className="whitespace-pre-wrap pt-1 text-code text-text-secondary">
                    {message.output || '(no output)'}
                  </pre>
                </ActivityRow>
              );
            }

            // Orphan tool result (rehydrated with no matching assistant block).
            const message = item.message;
            return (
              <ActivityRow
                key={message.id}
                icon={<IconTerminal size={14} />}
                label={message.toolName}
              >
                <pre className="whitespace-pre-wrap pt-1 text-code text-text-secondary">
                  {message.text || '(no output)'}
                </pre>
              </ActivityRow>
            );
          })}

          {/* The ONE live status indicator (jedd blind-test #1): a single
                thread-rendered element that reads "Thinking" while the model
                reasons and "Working" while it acts, with the harness stage folded
                in subtly. No duplicate label, no footer status, no stray spinner. */}
          <ThreadStatusIndicator />
        </Thread>
      </ScrollArea>
    </div>
  );
}
