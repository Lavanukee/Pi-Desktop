/**
 * The standalone canvas pop-out window (loaded with `?canvasPopout=1`). Fetches
 * the artifact main is holding, subscribes for live re-pops, and renders the
 * same <Canvas> full-window — no pi session, no chat chrome.
 */
import { type Artifact, Canvas } from '@pi-desktop/canvas';
import { useEffect, useState } from 'react';
import { payloadToArtifact } from './artifacts';

export function CanvasPopoutView() {
  const [artifact, setArtifact] = useState<Artifact | null>(null);

  useEffect(() => {
    void window.piDesktop.invoke('canvas:get-popout', undefined).then((res) => {
      if (res.artifact !== null) setArtifact(payloadToArtifact(res.artifact));
    });
    return window.piDesktop.onEvent('canvas:popout-artifact', (payload) => {
      setArtifact(payloadToArtifact(payload));
    });
  }, []);

  return (
    <div className="h-full bg-bg-base p-3" data-testid="canvas-popout">
      {artifact === null ? (
        <div className="grid h-full place-items-center text-body text-text-muted">
          No artifact to show.
        </div>
      ) : (
        <Canvas artifact={artifact} placement="inline" />
      )}
    </div>
  );
}
