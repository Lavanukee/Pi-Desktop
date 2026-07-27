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
import {
  type AssistantMsg,
  type ContentBlock,
  cleanErrorText,
  type ToolResultMsg,
} from '@pi-desktop/engine';
import type { ReactNode } from 'react';
import { generatedImageSrc, segmentGroup, toolStepKind } from './activity-mapping';
import { InlineArtifact } from './canvas/InlineArtifacts';
import { Markdown } from './markdown';
import { ThreadActivityChain } from './ThreadActivity';
import { ThreadImage } from './ThreadImage';
import { ThreadImagePlaceholder } from './ThreadImagePlaceholder';

export function AssistantGroup({
  group,
  resultByCallId,
  runningToolCalls,
  tps,
  onOpenFile,
  suppressInlineArtifacts = false,
}: {
  group: AssistantMsg[];
  resultByCallId: Map<string, ToolResultMsg>;
  runningToolCalls: string[];
  /** Current throughput from the inference supervisor (assistant footnote). */
  tps: number | undefined;
  /** Override the file-op row opener (the corp feed opens a live corp-peek). */
  onOpenFile?: (path: string) => void;
  /**
   * CORP feed rule (J3): the corp thread is text / thoughts / tool-call rows ONLY.
   * Any THEME-2 inline artifact widget (```html/```svg preview, a generated image)
   * is SUPPRESSED here and opened in the CANVAS instead — `CorpChatStream` detects
   * the same artifacts and routes each to a canvas tab, so a `mockup.html` the CEO
   * writes shows as a tool row + a canvas preview, never a black box inline. Normal
   * chat leaves this false and renders widgets inline (THEME 2), unchanged.
   */
  suppressInlineArtifacts?: boolean;
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

  // The image tool call this group is CURRENTLY waiting on, if any: an image
  // step the engine reports as executing that has not produced a result yet.
  // At most one is possible in practice — the generation engine runs one job at
  // a time on a 24 GB machine (see useDenoisePreview for why that invariant is
  // what makes the frame stream unambiguous) — and taking the first here makes
  // that explicit rather than assumed.
  let pendingImageCallId: string | undefined;
  if (!suppressInlineArtifacts) {
    for (const m of group) {
      for (const b of m.blocks) {
        if (b.type !== 'toolCall' || pendingImageCallId !== undefined) continue;
        if (toolStepKind(b.name) !== 'image') continue;
        if (!runningToolCalls.includes(b.id)) continue;
        if (resultForBlock.has(b.id)) continue;
        pendingImageCallId = b.id;
      }
    }
  }

  const segments = segmentGroup(group);
  const lastSegment = segments[segments.length - 1];
  const groupId = group[0]?.id ?? 'g';
  const rawError = group.find((m) => m.errorMessage !== undefined)?.errorMessage;
  // Clean once: a raw provider blob collapses to a short message, and a
  // user-initiated pause/stop ("aborted"/AbortError) collapses to '' — a clean
  // end renders NOTHING (never a red error row).
  const errorText = rawError !== undefined ? cleanErrorText(rawError) : '';
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
          // J3: never render an inline artifact widget in the corp feed — it opens
          // in the canvas instead (routed by CorpChatStream).
          if (suppressInlineArtifacts) return null;
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
          seg.kind === 'chain' && !suppressInlineArtifacts
            ? seg.blocks
                .filter(
                  (b): b is Extract<ContentBlock, { type: 'toolCall' }> => b.type === 'toolCall',
                )
                .map((b) => ({ id: b.id, src: generatedImageSrc(b, resultForBlock.get(b.id)) }))
                .filter((x): x is { id: string; src: string } => x.src !== undefined)
            : [];
        // While an image is being generated its card is NOT empty: the same box
        // the finished picture will occupy shows the model's own intermediate
        // decodes, resolving live (ThreadImagePlaceholder). It renders in the
        // chain that owns the pending call, which is where the finished image
        // would appear, so the swap happens in place.
        const pendingHere =
          pendingImageCallId !== undefined &&
          seg.kind === 'chain' &&
          seg.blocks.some((b) => b.type === 'toolCall' && b.id === pendingImageCallId);
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
            {/* Deliberately unkeyed and rendered from a stable position: the
                placeholder subscribes to the frame stream itself and drives its
                own DOM, so it must MOUNT ONCE per generation. Remounting it
                would replay its entrance animation mid-run. */}
            {pendingHere ? <ThreadImagePlaceholder /> : null}
          </div>
        );
      })}
      {errorText !== '' ? (
        // Defense-in-depth: never render a raw provider blob (an HTTP/JSON error)
        // in the chat — collapse it to a short human message. The provider already
        // emits clean text; this guards replayed transcripts + future paths. An
        // abort (pause/stop) cleaned to '' renders nothing.
        <div className="text-footnote text-status-danger-fg">{errorText}</div>
      ) : null}
    </div>
  );
}
