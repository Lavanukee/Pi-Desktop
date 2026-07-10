/**
 * THEME 2 routing glue: turn detected stream artifacts (```svg / ```html) into
 * canvas tab specs, and auto-open the ones that belong in the canvas
 * (`shouldGoToCanvas`) keyed by artifact id so re-streaming focuses the SAME
 * tab (via `upsertTab`) instead of piling up duplicates. Small svg/html stay
 * inline (rendered by InlineArtifact at their source position in the thread)
 * until the user moves them over.
 */
import { type CanvasTabSpec, shouldGoToCanvas, useCanvasTabs } from '@pi-desktop/canvas';
import { useEffect } from 'react';
import { type DetectedArtifact, toCanvasArtifact } from './artifacts';
import { useDetectedArtifacts } from './useCanvasArtifacts';

/** A canvas tab spec for a detected artifact (keyed by its stable id). */
export function specForArtifact(detected: DetectedArtifact): CanvasTabSpec {
  const artifact = toCanvasArtifact(detected);
  return {
    kind: detected.kind,
    key: detected.id,
    title: detected.title,
    artifact,
  };
}

/** True when this artifact belongs in the canvas rather than inline in the chat. */
export function artifactGoesToCanvas(detected: DetectedArtifact): boolean {
  return shouldGoToCanvas(toCanvasArtifact(detected));
}

/**
 * Watch the detected-artifact stream and keep the canvas in sync: open a new
 * canvas-bound artifact once (focus + un-collapse) and thereafter refresh its
 * content quietly via `updateTab` so streaming never steals focus back.
 */
export function useArtifactCanvasRouting(): void {
  const { controller } = useCanvasTabs();
  const detected = useDetectedArtifacts();

  useEffect(() => {
    for (const d of detected) {
      if (!artifactGoesToCanvas(d)) continue;
      const spec = specForArtifact(d);
      const existing = controller.getState().tabs.find((t) => t.key === d.id);
      if (existing === undefined) {
        controller.upsertTab(d.id, spec);
      } else {
        // Quiet content refresh — do NOT re-focus/un-collapse on every token.
        controller.updateTab(existing.id, { artifact: spec.artifact, title: spec.title });
      }
    }
  }, [detected, controller]);
}
