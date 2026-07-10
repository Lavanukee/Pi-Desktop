/**
 * THEME 2 inline widgets: small svg/html artifacts that belong IN the chat.
 * Each renders as an `InlineWidget` — size-capped and NEVER scrollable; when it
 * overflows the cap it fades + offers "Open in canvas" instead of scrolling.
 * Its always-present "Move to canvas" button (and the overflow button) call
 * `controller.openTab`, promoting it to a canvas tab keyed by artifact id; once
 * a tab with that key exists the widget drops out of the thread (the tab owns
 * it), so inline↔canvas stays a single source of truth.
 *
 * A1: a widget renders INLINE at its source position within the assistant
 * message (ChatThread splices one `<InlineArtifact>` where each fence occurred),
 * not in a single block at the thread foot.
 */
import { InlineWidget, useCanvasTabs } from '@pi-desktop/canvas';
import type { DetectedArtifact } from './artifacts';
import { artifactGoesToCanvas, specForArtifact } from './tabs-routing';

/**
 * One detected artifact rendered inline in the thread. Renders nothing when the
 * artifact belongs in the canvas (too big) or already lives in an open canvas
 * tab (its `id` is a tab key) — that tab is the single source of truth.
 */
export function InlineArtifact({ artifact: detected }: { artifact: DetectedArtifact }) {
  const { tabs, upsertTab } = useCanvasTabs();

  const openKeys = new Set(tabs.map((t) => t.key).filter((k): k is string => k !== undefined));
  if (artifactGoesToCanvas(detected) || openKeys.has(detected.id)) return null;

  const spec = specForArtifact(detected);
  return (
    <div className="flex flex-col gap-3" data-testid="inline-artifacts">
      <InlineWidget
        artifact={
          spec.artifact ?? {
            id: detected.id,
            content: { kind: detected.kind, text: detected.text },
          }
        }
        onMoveToCanvas={() => upsertTab(detected.id, spec)}
      />
    </div>
  );
}
