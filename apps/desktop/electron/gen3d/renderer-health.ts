/**
 * Renderer-death diagnostics.
 *
 * A blocked renderer eventually repaints; a DEAD one shows a blank solid colour,
 * ignores Cmd+R, and has to be force-quit — which is what the user reported
 * during generation. Those are different failures and only the main process can
 * tell them apart, so this module records exactly how the renderer went away:
 *
 *   render-process-gone → reason (crashed | oom | killed | launch-failed | …)
 *                         and exitCode. This is THE signal.
 *   child-process-gone  → the GPU / utility processes, which take the window
 *                         down with them in a different way.
 *
 * It also samples renderer memory during long jobs, because "oom" is only
 * meaningful next to the heap curve that led to it. Diagnostics only: recovery
 * (reloading a dead renderer) belongs to the app shell, not here.
 *
 * Everything is also written to a JSONL file under the app's logs so a crash
 * that kills the window still leaves evidence behind.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@pi-desktop/shared';
import { app, BrowserWindow, type WebContents } from 'electron';

const log = createLogger('desktop:renderer-health');

/** Where the crash/memory trace lands (survives the window dying). */
function tracePath(): string {
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return path.join(dir, 'renderer-health.jsonl');
}

function record(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  try {
    appendFileSync(tracePath(), `${line}\n`);
  } catch {
    /* never let diagnostics break the app */
  }
}

let sampling: NodeJS.Timeout | null = null;

/**
 * Sample renderer + main memory while something heavy is running. `label` marks
 * the phase so a heap curve can be read against the pipeline.
 */
export function startMemorySampling(label: string, intervalMs = 5000): void {
  stopMemorySampling();
  sampling = setInterval(() => {
    void (async () => {
      try {
        const metrics = app.getAppMetrics();
        const renderers = metrics
          .filter((m) => m.type === 'Tab')
          .map((m) => ({
            pid: m.pid,
            workingSetKb: m.memory?.workingSetSize ?? 0,
            peakKb: m.memory?.peakWorkingSetSize ?? 0,
          }));
        const gpu = metrics.find((m) => m.type === 'GPU');
        record({
          event: 'memory',
          label,
          renderers,
          gpuWorkingSetKb: gpu?.memory?.workingSetSize ?? 0,
        });
      } catch (err) {
        record({ event: 'memory-error', error: String(err) });
      }
    })();
  }, intervalMs);
  // Never hold the app open just to sample.
  sampling.unref?.();
}

export function stopMemorySampling(): void {
  if (sampling !== null) clearInterval(sampling);
  sampling = null;
}

const watched = new WeakSet<WebContents>();

function watchContents(contents: WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  contents.on('render-process-gone', (_event, details) => {
    // reason: 'clean-exit' | 'abnormal-exit' | 'killed' | 'crashed' |
    //         'oom' | 'launch-failed' | 'integrity-failure'
    const entry = {
      event: 'render-process-gone',
      reason: details.reason,
      exitCode: details.exitCode,
    };
    record(entry);
    log.error('RENDERER GONE', entry);
  });
  contents.on('unresponsive', () => {
    record({ event: 'unresponsive' });
    log.warn('renderer unresponsive');
  });
  contents.on('responsive', () => {
    record({ event: 'responsive' });
  });
}

let installed = false;

/** Attach the watchers. Idempotent; safe to call from anywhere at startup. */
export function installRendererHealth(): void {
  if (installed) return;
  installed = true;
  record({ event: 'install' });

  for (const win of BrowserWindow.getAllWindows()) watchContents(win.webContents);
  app.on('browser-window-created', (_e, win) => watchContents(win.webContents));

  app.on('child-process-gone', (_event, details) => {
    const entry = {
      event: 'child-process-gone',
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
    };
    record(entry);
    log.error('CHILD PROCESS GONE', entry);
  });
}

/** Where the trace is, so a probe can read it back. */
export function rendererHealthTracePath(): string {
  return tracePath();
}
