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
 *
 * `DictationSession` below is the live-transcript path and DOES hold the
 * process, for as long as one recording lasts plus an idle grace period.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
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

    child.on('error', (e) =>
      done({ ok: false, error: `could not start the recogniser: ${e.message}` }),
    );
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

/* ------------------------------------------------------------------ live -- */

/** Model load + first session. Generous: an unprovisioned venv fails fast. */
const READY_TIMEOUT_MS = 180_000;
/** How long the loaded model is kept after a recording ends. */
const IDLE_SHUTDOWN_MS = 90_000;
/** The final full-context pass is ~0.4s for 16s of audio; this is slack. */
const FINAL_TIMEOUT_MS = 60_000;

/**
 * A warm recogniser that turns speech into text WHILE you are still talking.
 *
 * One `audio_worker.py --op serve` process, held across recordings. That is the
 * whole point: a cold spawn costs a model load, and a live transcript that
 * starts appearing after you have stopped speaking is not a live transcript.
 * MEASURED — 0.9s to become ready, then 16.5s of speech consumed in 4.4s, so it
 * keeps up with real time with room to spare.
 *
 * The 2.3 GB it holds is why it does not live forever: IDLE_SHUTDOWN_MS after
 * the last recording it exits, and the next dictation pays the load again. A
 * user who dictates twice in a minute gets a warm process; one who dictates
 * once a day does not keep 2.3 GB from the generation stages all day.
 *
 * WHY THE PARTIALS ARE NOT THE ANSWER. The streaming decoder sees only a small
 * lookahead and audibly guesses; the worker re-transcribes the whole recording
 * with full context on stop, and THAT is what `stop()` resolves with. Partials
 * are for the eyes, the final pass is for the composer.
 */
export class DictationSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buffer = '';
  private sessionId: string | null = null;
  private seq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onFinal: ((r: TranscriptResult) => void) | null = null;
  private onReady: (() => void) | null = null;
  private onFail: ((e: Error) => void) | null = null;

  constructor(
    private readonly audioPython: string,
    private readonly workerPath: string,
    private readonly env: NodeJS.ProcessEnv,
    /** Partials go here as they arrive; the caller forwards them to the UI. */
    private readonly emit: (sessionId: string, partial: string) => void,
  ) {}

  /** Begin recording. Resolves with the id once the model can hear audio. */
  async start(): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      await this.ensureReady();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.seq += 1;
    this.sessionId = `dictation-${this.seq}`;
    this.send({ cmd: 'start' });
    return { ok: true, sessionId: this.sessionId };
  }

  /** Feed samples. Silently ignored for a stale id — a chunk in flight when the
   * user hits cancel must not resurrect the session or crash the send. */
  chunk(sessionId: string, pcmBase64: string): void {
    if (this.sessionId !== sessionId || pcmBase64 === '') return;
    this.send({ cmd: 'audio', pcm: pcmBase64 });
  }

  /** End it and wait for the full-context transcript. */
  async stop(sessionId: string): Promise<TranscriptResult> {
    if (this.sessionId !== sessionId || this.child === null) {
      return { ok: false, error: 'that dictation is no longer running' };
    }
    this.sessionId = null;
    const result = await new Promise<TranscriptResult>((resolve) => {
      const timer = setTimeout(() => {
        this.onFinal = null;
        resolve({ ok: false, error: 'the recogniser did not answer in time' });
      }, FINAL_TIMEOUT_MS);
      this.onFinal = (r) => {
        clearTimeout(timer);
        this.onFinal = null;
        resolve(r);
      };
      this.send({ cmd: 'stop' });
    });
    this.scheduleIdleShutdown();
    return result;
  }

  /** Throw the recording away. The process stays warm for the next one. */
  cancel(sessionId: string): void {
    if (this.sessionId !== sessionId) return;
    this.sessionId = null;
    this.onFinal = null;
    // Still `stop` the worker's stream so its next `start` is a clean context;
    // the transcript it emits is dropped on the floor by the null onFinal.
    this.send({ cmd: 'stop' });
    this.scheduleIdleShutdown();
  }

  /** Shut down now (app quit). */
  dispose(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.sessionId = null;
    this.onFinal = null;
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child === null) return;
    this.safeWrite(child, { cmd: 'quit' });
    // A recogniser mid-inference will not read stdin promptly; give it a beat
    // to leave on its own before insisting.
    const kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.once('close', () => clearTimeout(kill));
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.info('dictation idle, releasing the recogniser');
      this.dispose();
    }, IDLE_SHUTDOWN_MS);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.child !== null) this.safeWrite(this.child, msg);
  }

  private safeWrite(child: ChildProcessWithoutNullStreams, msg: Record<string, unknown>): void {
    try {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      /* the worker died; the close handler already reported it */
    }
  }

  private ensureReady(): Promise<void> {
    if (this.ready !== null) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.audioPython,
        [this.workerPath, '--op', 'serve', '--out-dir', tmpdir()],
        { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] },
      ) as ChildProcessWithoutNullStreams;
      this.child = child;
      this.buffer = '';
      let stderr = '';

      const timer = setTimeout(
        () => this.fail(new Error('the recogniser did not start in time')),
        READY_TIMEOUT_MS,
      );
      this.onReady = () => {
        clearTimeout(timer);
        this.onReady = null;
        this.onFail = null;
        resolve();
      };
      this.onFail = (e) => {
        clearTimeout(timer);
        this.onReady = null;
        this.onFail = null;
        this.child = null;
        this.ready = null;
        reject(e);
      };

      child.stdout.on('data', (d: Buffer) => this.consume(d.toString()));
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-2000);
      });
      child.on('error', (e) =>
        this.fail(new Error(`could not start the recogniser: ${e.message}`)),
      );
      child.on('close', (code) => {
        if (this.child === child) {
          this.child = null;
          this.ready = null;
          this.sessionId = null;
        }
        const tail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
        const err = new Error(tail !== '' ? tail : `the recogniser exited with code ${code}`);
        // A death mid-recording has to reach whoever is waiting, or the UI sits
        // on "Listening" forever.
        this.onFinal?.({ ok: false, error: err.message });
        this.onFinal = null;
        this.fail(err);
      });
    });
    return this.ready;
  }

  private fail(err: Error): void {
    const cb = this.onFail;
    if (cb !== null) cb(err);
  }

  /** NDJSON, line-scoped: `progress` = a partial, `stage-done` = ready/final. */
  private consume(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || !trimmed.startsWith('{')) continue;
      let ev: { event?: string; message?: string };
      try {
        ev = JSON.parse(trimmed) as { event?: string; message?: string };
      } catch {
        continue;
      }
      const message = typeof ev.message === 'string' ? ev.message : '';
      if (ev.event === 'stage-done' && message === 'ready' && this.onReady !== null) {
        this.onReady();
      } else if (ev.event === 'stage-done') {
        const cb = this.onFinal;
        this.onFinal = null;
        cb?.(
          message.trim() === ''
            ? { ok: false, error: 'no speech was recognised' }
            : { ok: true, text: message.trim() },
        );
      } else if (ev.event === 'progress' && this.sessionId !== null) {
        this.emit(this.sessionId, message);
      }
    }
  }
}
