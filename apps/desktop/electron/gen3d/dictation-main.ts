/**
 * Dictation — the microphone's half of the audio stack.
 *
 * The renderer records from the mic and hands the encoded bytes here; this
 * writes them to a temp file, runs the audio worker's `asr` op, and returns the
 * transcript. Deliberately NOT routed through the gen3d sidecar's job system:
 * a job carries progress, artifacts, a plan and a cancel path, and dictation
 * has none of that — it is one short call that returns a string. Wiring it as
 * a job would mean inventing a stage for something the user experiences as a
 * button that fills in a text box.
 *
 * MEASURED: Parakeet transcribes 15s of speech in 0.26s once loaded, so the
 * cost here is dominated by the ~15s first load. The worker process is spawned
 * per call rather than kept warm — a warm interpreter would hold 2.3 GB
 * resident against a 24 GB budget the generation stages need more.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '@pi-desktop/shared';

const log = createLogger('desktop:dictation');

/** Longest a single dictation may take, including a cold model load. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

export interface TranscriptResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: string;
}

/** The `stage-done` message of the asr op IS the transcript (audio_worker.py). */
function transcriptFromNdjson(stdout: string): string | null {
  let text: string | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) continue;
    try {
      const ev = JSON.parse(trimmed) as { event?: string; message?: string };
      if (ev.event === 'stage-done' && typeof ev.message === 'string') text = ev.message;
    } catch {
      /* a worker may print non-JSON; the protocol is line-scoped */
    }
  }
  return text;
}

/**
 * Transcribe one recording.
 *
 * `audioPython` is the audio venv's interpreter and `workerPath` the worker
 * script; both are resolved by the caller so this module holds no opinion about
 * where the engine lives (and stays testable without one).
 */
export async function transcribe(
  audioPython: string,
  workerPath: string,
  bytes: Buffer,
  extension: string,
  env: NodeJS.ProcessEnv,
): Promise<TranscriptResult> {
  if (bytes.length === 0) return { ok: false, error: 'nothing was recorded' };
  const dir = mkdtempSync(path.join(tmpdir(), 'pd-dictation-'));
  const clip = path.join(dir, `clip${extension.startsWith('.') ? extension : `.${extension}`}`);
  writeFileSync(clip, bytes);

  return await new Promise<TranscriptResult>((resolve) => {
    let settled = false;
    const done = (r: TranscriptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a temp dir that will not delete must not fail a transcription */
      }
      resolve(r);
    };

    const child = spawn(
      audioPython,
      [workerPath, '--op', 'asr', '--out-dir', dir, '--audio', clip],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, error: 'transcription timed out' });
    }, TRANSCRIBE_TIMEOUT_MS);

    child.on('error', (e) => done({ ok: false, error: `could not start the recogniser: ${e.message}` }));
    child.on('close', (code) => {
      const text = transcriptFromNdjson(out);
      if (text !== null && text.trim() !== '') {
        done({ ok: true, text: text.trim() });
        return;
      }
      // A non-zero exit with no transcript is the honest failure; surface the
      // worker's own last words rather than a generic message.
      const tail = err.trim().split('\n').slice(-2).join(' ').slice(0, 300);
      log.warn('dictation failed', { code, tail });
      done({ ok: false, error: tail !== '' ? tail : `the recogniser exited with code ${code}` });
    });
  });
}
