/**
 * Brings a local model online end-to-end and makes pi use it:
 *   download (if needed) → start llama-server (supervisor writes models.json) →
 *   re-point pi at the llamacpp provider.
 *
 * Model-switch strategy (hot-reload vs restart):
 * pi caches models.json at spawn, and the frozen provider-llamacpp extension
 * exposes no runtime "re-register with the new model" command, so a true
 * hot-reload isn't reachable from this workstream. We therefore do a GRACEFUL
 * restart that preserves the conversation: the pi child is respawned on the
 * SAME session file (the renderer keeps the rendered thread, and pi resumes the
 * session it was already writing), so switching models never dead-ends the
 * chat. If provider-llamacpp later gains a runtime re-register command, this is
 * the one seam to swap for a no-restart path.
 */

import { useLlmStore } from './llm-store';
import { getModels, restartPi, setModel } from './pi-connect';
import { usePiStore } from './pi-slice';
import { applySavedHarnessConfig } from './settings-store';

export async function activateLocalModel(
  modelId: string,
  quant?: string,
): Promise<{ success: boolean; error?: string }> {
  const store = useLlmStore.getState();
  if (!store.status.downloadedModelIds.includes(modelId)) {
    await store.downloadModel(modelId, quant);
    if (!useLlmStore.getState().status.downloadedModelIds.includes(modelId)) {
      return { success: false, error: 'download did not complete' };
    }
  }

  const started = await store.startServer(modelId, quant);
  if (!started.success) return started;

  // Graceful restart preserving the current session so the chat is not
  // dead-ended (see file header). Respawn on the same session file when one
  // exists; the rendered thread in the store stays put.
  const sessionFile = usePiStore.getState().session?.sessionFile;
  await restartPi(sessionFile !== undefined ? { sessionPath: sessionFile } : undefined);

  // Re-point pi at the freshly-registered llamacpp provider model.
  const models = await getModels();
  const target = models.models.find((m) => m.provider === 'llamacpp');
  if (target !== undefined) await setModel(target.provider, target.id);

  // A fresh session drops the harness runtime config — re-apply the saved one.
  applySavedHarnessConfig();
  return { success: true };
}
