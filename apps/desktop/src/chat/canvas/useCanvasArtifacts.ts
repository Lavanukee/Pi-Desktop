/**
 * Detect canvas artifacts off the pi message stream. A cheap memoized string
 * scan shared by the inline widgets (THEME 2) and the canvas routing effect;
 * both re-derive the active artifact's live text every token. Active-tab /
 * placement selection now lives in the CanvasController, not here.
 */
import { useMemo } from 'react';
import { usePiStore } from '../../state/pi-slice';
import { type DetectedArtifact, detectArtifacts } from './artifacts';

export function useDetectedArtifacts(): DetectedArtifact[] {
  const messages = usePiStore((s) => s.messages);
  return useMemo(() => detectArtifacts(messages), [messages]);
}
