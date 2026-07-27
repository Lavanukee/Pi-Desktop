/**
 * Dictation: hold the mic, watch the waveform, get text in the composer.
 *
 * The whole recording lives in the renderer (getUserMedia + MediaRecorder) and
 * only the finished clip crosses to main, where the audio worker's `asr` op
 * turns it into text. Nothing is streamed: Parakeet transcribes 15s of speech
 * in 0.26s, so chunked streaming would add plumbing and latency to save nothing
 * a user could perceive.
 *
 * THE LEVELS ARE READ FROM AN AnalyserNode, NOT FROM THE ENCODED DATA. A
 * MediaRecorder's `dataavailable` gives compressed bytes on a timer, which is
 * both too coarse and the wrong shape for a waveform. The analyser taps the
 * live stream, so the bar moves with the voice rather than with the encoder.
 *
 * The stream is torn down on every exit path — stop, cancel, error, unmount.
 * A live getUserMedia track keeps the OS microphone indicator lit, and an app
 * that leaves that on after you stop dictating looks like it is listening.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type DictationPhase = 'idle' | 'recording' | 'transcribing' | 'error';

/** How many bars the waveform keeps. ~3s of history at the sample rate below. */
const LEVEL_HISTORY = 48;
const LEVEL_INTERVAL_MS = 60;

export interface DictationState {
  readonly phase: DictationPhase;
  /** Newest-last RMS levels in 0..1, for the waveform. */
  readonly levels: readonly number[];
  readonly error: string | null;
  readonly start: () => void;
  /** Stop and transcribe. */
  readonly stop: () => void;
  /** Stop and throw the recording away. */
  readonly cancel: () => void;
}

function pickMimeType(): { mime: string; ext: string } {
  // Chromium in Electron records webm/opus; ffmpeg (already required by the
  // ASR worker) reads it. Ask for what we can actually get rather than assuming.
  for (const [mime, ext] of [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/webm', 'webm'],
    ['audio/mp4', 'mp4'],
  ] as const) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return { mime, ext };
    }
  }
  return { mime: '', ext: 'webm' };
}

export function useDictation(onText: (text: string) => void): DictationState {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const keepRef = useRef(true);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const teardown = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // Order matters: stop the tracks before closing the context, or Chromium
    // can leave the capture device open and the OS mic indicator lit.
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {
      /* closing a context twice is not an error worth surfacing */
    });
    audioCtxRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback((): void => {
    if (phase === 'recording' || phase === 'transcribing') return;
    setError(null);
    setLevels([]);
    keepRef.current = true;
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // The recogniser wants speech, not a good recording: these three
          // help it far more than fidelity does.
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        setPhase('error');
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Microphone access was denied — allow it in System Settings › Privacy.'
            : 'No microphone available.',
        );
        return;
      }
      streamRef.current = stream;

      // Live levels for the waveform.
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      timerRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const c = (v - 128) / 128;
          sum += c * c;
        }
        // sqrt of mean square, then a gentle curve: speech sits low in a linear
        // scale and the bar would barely move without it.
        const rms = Math.sqrt(sum / buf.length);
        const level = Math.min(1, rms ** 0.6 * 2.2);
        setLevels((prev) => [...prev, level].slice(-LEVEL_HISTORY));
      }, LEVEL_INTERVAL_MS);

      const { mime, ext } = pickMimeType();
      const recorder = new MediaRecorder(stream, mime === '' ? undefined : { mimeType: mime });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const keep = keepRef.current;
        teardown();
        if (!keep) {
          setPhase('idle');
          setLevels([]);
          return;
        }
        const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
        chunksRef.current = [];
        if (blob.size === 0) {
          setPhase('idle');
          return;
        }
        setPhase('transcribing');
        void (async () => {
          const b64 = btoa(
            String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())),
          );
          const res = await window.piDesktop
            .invoke('audio:transcribe', { audioBase64: b64, extension: ext })
            .catch(() => null);
          if (res === null || !res.ok || res.text === undefined || res.text.trim() === '') {
            setPhase('error');
            setError(res?.error ?? 'Could not transcribe that.');
            return;
          }
          onTextRef.current(res.text.trim());
          setPhase('idle');
          setLevels([]);
        })();
      };
      recorder.start();
      setPhase('recording');
    })();
  }, [phase, teardown]);

  const stop = useCallback((): void => {
    keepRef.current = true;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const cancel = useCallback((): void => {
    keepRef.current = false;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    else {
      teardown();
      setPhase('idle');
      setLevels([]);
    }
  }, [teardown]);

  return { phase, levels, error, start, stop, cancel };
}
