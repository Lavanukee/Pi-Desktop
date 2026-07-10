/**
 * Main-process host for the Apple Foundation Models (on-device) provider.
 *
 * Three jobs:
 *   1. Resolve the bundled `pi-afm` Swift helper binary and export it via the
 *      `PI_AFM_HELPER_PATH` env so BOTH this process (the `--check` gate) and the
 *      spawned pi child (provider-afm's `streamAfm`) find + spawn the same binary.
 *   2. `afm:check` — a cached capability gate (darwin/arm64 + `pi-afm --check`);
 *      off-platform or unavailable resolves `available:false` so AFM stays hidden.
 *   3. `afm:set-active` — write the `afm` provider block into pi's models.json
 *      (preserving other providers) so a pi restart + set-model routes the
 *      on-device model through provider-afm's `afm-stream` streamSimple handler.
 *
 * @pi-desktop/afm stays electron-free; this module is the seam where Electron
 * specifics (bundle path, packaged asar) are injected as `helperPath`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { type AfmAvailability, checkAvailability } from '@pi-desktop/afm';
import { createLogger, type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import { app, type IpcMain } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';
import type { AfmAvailabilityInfo, AfmInvokeMap } from './afm-contract';

const log = createLogger('desktop:afm');

const MODELS_JSON = path.join(homedir(), '.pi', 'agent', 'models.json');
const PROVIDER_NAME = 'afm';
const MODEL_ID = 'apple-on-device';
const MODEL_DISPLAY_NAME = 'Apple Intelligence';
/** Dummy baseUrl: pi requires a non-empty baseUrl + apiKey "when defining
 * models", but our streamSimple owns generation and never dials it. */
const DUMMY_BASE_URL = 'afm://local';

/**
 * Resolve the packaged `pi-afm` binary to a REAL on-disk path. The helper is a
 * mach-o that must be spawned, so it is asarUnpack'd (electron-builder.yml); the
 * resolver points inside app.asar, which we rewrite to app.asar.unpacked so the
 * path exists for `spawn`/`execve` (the fs shim covers reads, not exec). In dev
 * the resolver already yields the SwiftPM build output.
 */
function resolveAfmHelperPath(): string {
  const resolved = resolveBundledPackageAsset('afm', 'swift/.build/release/pi-afm');
  if (!app.isPackaged) return resolved;
  return resolved.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
}

const HELPER_PATH = resolveAfmHelperPath();

/** The on-device model is Apple-silicon-only; skip the helper spawn elsewhere. */
function isSupportedPlatform(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

function toInfo(a: AfmAvailability): AfmAvailabilityInfo {
  return {
    available: a.available,
    reason: a.reason,
    contextWindow: a.contextWindow,
    model: a.model.length > 0 ? a.model : MODEL_ID,
  };
}

/** Cache the check: the helper spawn is at most once per app run. */
let availabilityPromise: Promise<AfmAvailabilityInfo> | null = null;

function checkAfm(): Promise<AfmAvailabilityInfo> {
  if (availabilityPromise !== null) return availabilityPromise;
  availabilityPromise = (async () => {
    if (!isSupportedPlatform()) {
      return { available: false, reason: 'unsupportedOS', contextWindow: 4096, model: MODEL_ID };
    }
    const result = await checkAvailability({ helperPath: HELPER_PATH });
    log.info('afm availability', { reason: result.reason, available: result.available });
    return toInfo(result);
  })();
  return availabilityPromise;
}

// --- models.json writer (electron-free inference package is off-limits; this is
// a minimal read-merge-write that never clobbers other providers) -------------

interface ModelsJsonShape {
  providers?: Record<string, unknown>;
}

async function readModelsJson(): Promise<ModelsJsonShape> {
  try {
    const raw = await readFile(MODELS_JSON, 'utf8');
    const parsed = JSON.parse(raw) as ModelsJsonShape;
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    // Missing/corrupt — start fresh.
  }
  return { providers: {} };
}

function afmProviderBlock(contextWindow: number): Record<string, unknown> {
  const window = contextWindow > 0 ? contextWindow : 4096;
  return {
    baseUrl: DUMMY_BASE_URL,
    api: 'afm-stream',
    apiKey: 'none',
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
    },
    models: [
      {
        id: MODEL_ID,
        name: MODEL_DISPLAY_NAME,
        input: ['text'],
        contextWindow: window,
        maxTokens: Math.min(1024, Math.max(256, Math.floor(window / 4))),
      },
    ],
  };
}

async function setActive(): Promise<{ success: boolean; error?: string }> {
  try {
    const info = await checkAfm();
    if (!info.available)
      return { success: false, error: `Apple model unavailable (${info.reason})` };
    const existing = await readModelsJson();
    const providers = { ...(existing.providers ?? {}) };
    providers[PROVIDER_NAME] = afmProviderBlock(info.contextWindow);
    const merged = { ...existing, providers };
    await mkdir(path.dirname(MODELS_JSON), { recursive: true });
    await writeFile(MODELS_JSON, `${JSON.stringify(merged, null, 2)}\n`);
    log.info('afm provider block written to models.json');
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error instanceof Error ? error.message : error) };
  }
}

const handlers: IpcHandlers<AfmInvokeMap> = {
  'afm:check': () => checkAfm(),
  'afm:set-active': () => setActive(),
};

/**
 * Register the afm invoke channels AND publish the resolved helper path onto the
 * env so the pi child (provider-afm) resolves the same binary. Called from
 * main.ts's registerAppIpc, which runs on app-ready before the first pi spawn.
 */
export function registerAfmIpc(ipcMain: IpcMain, allowSender: (event: unknown) => boolean): void {
  process.env.PI_AFM_HELPER_PATH = HELPER_PATH;
  registerIpcHandlers<AfmInvokeMap>(ipcMain, handlers, { allowSender });
  // Kick the check off now so `afm:check` resolves instantly when the renderer
  // asks (and so any helper spawn cost is paid before the user opens Models).
  void checkAfm();
}
