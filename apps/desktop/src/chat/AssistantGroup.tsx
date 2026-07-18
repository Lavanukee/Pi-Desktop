/**
 * One assistant response GROUP rendered through the design system — the single
 * render path for streamed assistant output. `segmentGroup` splits the group's
 * blocks into markdown text / inline artifacts / tool+thinking CHAINS, which
 * render via {@link Markdown} + {@link ThreadActivityChain}.
 *
 * Extracted from `ChatThread` (not just exported) so the corp feed can stream a
 * watched agent through the EXACT same path without an import cycle
 * (`ChatThread → CorpChatStream → CorpWorkerPane`). Reusing it gives the corp feed
 * the normal chat's behavior verbatim: append-stable segment keys (a new block
 * never re-mounts the existing chain), the collapsible thinking block WITH its
 * rail while streaming (a thinking run is an ActivityChain, not a component that
 * swaps type when it settles), and real tool/file activity rows.
 */
import type { AssistantMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import type { ReactNode } from 'react';
import { generatedImageSrc, segmentGroup } from './activity-mapping';
import { InlineArtifact } from './canvas/InlineArtifacts';
import { Markdown } from './markdown';
import { ThreadActivityChain } from './ThreadActivity';
import { ThreadImage } from './ThreadImage';

export function AssistantGroup({
  group,
  resultByCallId,
  runningToolCalls,
  tps,
  onOpenFile,
}: {
  group: AssistantMsg[];
  resultByCallId: Map<string, ToolResultMsg>;
  runningToolCalls: string[];
  /** Current throughput from the inference supervisor (assistant footnote). */
  tps: number | undefined;
  /** Override the file-op row opener (the corp feed opens a live corp-peek). */
  onOpenFile?: (path: string) => void;
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
              {...(onOpenFile !== undefined ? { onOpenFile } : {})}
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
