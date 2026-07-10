/**
 * Makes pi use the Apple Foundation Models on-device model:
 *   write the `afm` block into models.json (main) → graceful pi restart → re-point
 *   pi at the afm provider model.
 *
 * There is no server to start and nothing to download (the model is built into
 * the OS), so this is simpler than the llama.cpp path (state/local-model.ts) but
 * mirrors its restart-to-pick-up-models.json strategy: pi caches models.json at
 * spawn, so we respawn on the SAME session file (preserving the rendered thread)
 * and then select the afm model. If provider-afm later gains a runtime
 * re-register command, this is the one seam to swap for a no-restart path.
 */
import { getModels, restartPi, setModel } from './pi-connect';
import { usePiStore } from './pi-slice';
import { applySavedHarnessConfig } from './settings-store';

export async function activateAppleModel(): Promise<{ success: boolean; error?: string }> {
  // 1. Write the afm provider block into pi's models.json (preserves llamacpp).
  const written = await window.piDesktop.invoke('afm:set-active', undefined);
  if (!written.success) return written;

  // 2. Graceful restart preserving the current session so the chat is not
  // dead-ended; the rendered thread in the store stays put.
  const sessionFile = usePiStore.getState().session?.sessionFile;
  await restartPi(sessionFile !== undefined ? { sessionPath: sessionFile } : undefined);

  // 3. Re-point pi at the freshly-registered afm provider model.
  const models = await getModels();
  const target = models.models.find((m) => m.provider === 'afm');
  if (target === undefined) {
    return { success: false, error: 'afm model not registered after restart' };
  }
  await setModel(target.provider, target.id);

  // A fresh session drops the harness runtime config — re-apply the saved one.
  applySavedHarnessConfig();
  return { success: true };
}
