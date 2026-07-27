"""Audio worker — speech in, speech out, and sound effects.

Three ops behind one worker because they share ONE provisioned venv (see
envs.py `audio`), and because a machine with 24 GB should never hold two of
these at once:

  tts   text  -> speech   Qwen3-TTS 12Hz 0.6B via mlx-audio (MLX, Apple Silicon)
  sfx   text  -> sound    Dasheng-AudioGen via thinksound.cpp (GGML, Metal)
  asr   audio -> text     Parakeet TDT 0.6B v3 via parakeet-mlx (MLX)

MEASURED on an M5 Pro, all local, all offline once downloaded:

  asr   0.26 s for 15 s of speech (~55x real time), 2.3 GB
  tts   5.8 s of speech in 32 s cold / ~6 s warm, 2.5 GB
  sfx   ~11 s per clip, 10 GB

WHY PARAKEET AND NOT WHISPER. jedd asked for "FluidVoice"; FluidVoice is a
macOS APP (GPLv3) that wraps other engines, not a model — vendoring it would
put a copyleft licence on this codebase. Parakeet is what it runs underneath,
it has a first-class MLX port, and it is small enough to load on demand.

WHAT PARAKEET ALREADY DOES, so nothing downstream repeats it: punctuation,
capitalisation, sentence segmentation and number formatting are already
correct — MEASURED on unpunctuated dictation, "three hundred and eighty four"
came back as "384". What it gets wrong is homophones ("weather"/"whether") and
domain jargon ("Retapo" for "retopo"), which is a different and much narrower
job than "clean up ASR output".

SFX DURATION IS NOT A REQUEST. Dasheng predicts its own clip length from a
content-adapter head; `--duration` exists in its CLI for API compatibility and
does not change the output, which is why every clip comes back ~10 s. Not
exposed here rather than exposed and ignored.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import artifact, progress, stage_done  # noqa: E402

STAGE = "audio"

TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"
ASR_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
SFX_REPO = "ilintar/Dasheng-AudioGen-GGUF"


def _wav_stats(path: Path) -> tuple[float, float]:
    """(seconds, rms). An empty or silent file is a FAILED generation, not a
    quiet one — every caller here checks rather than trusting an exit code."""
    import numpy as np

    with wave.open(str(path)) as w:
        frames, rate = w.getnframes(), w.getframerate()
        raw = w.readframes(frames)
    if frames == 0 or rate == 0:
        return 0.0, 0.0
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    return frames / rate, float((a**2).mean() ** 0.5)


def run_tts(args: argparse.Namespace, out_dir: Path) -> None:
    progress(STAGE, "Loading the speech model…")
    from mlx_audio.tts.generate import generate_audio

    t0 = time.time()
    progress(STAGE, "Speaking…")
    generate_audio(
        text=args.text,
        model=TTS_MODEL,
        output_path=str(out_dir),
        file_prefix="speech",
        audio_format="wav",
        join_audio=True,
        verbose=False,
    )
    produced = sorted(out_dir.glob("speech*.wav"))
    if not produced:
        raise RuntimeError("the speech model produced no audio file")
    path = produced[0]
    secs, rms = _wav_stats(path)
    if rms <= 1.0:
        raise RuntimeError(f"the speech model produced silence ({secs:.2f}s, rms={rms:.1f})")
    progress(STAGE, f"Spoke {secs:.1f}s in {time.time() - t0:.0f}s")
    artifact(STAGE, "audio", str(path), "Speech")
    stage_done(STAGE, f"Generated {secs:.1f}s of speech")


def run_sfx(args: argparse.Namespace, out_dir: Path) -> None:
    from huggingface_hub import snapshot_download

    progress(STAGE, "Locating the sound model…")
    gguf_dir = snapshot_download(SFX_REPO, allow_patterns=["*.gguf"], local_files_only=True)
    cli = Path(args.thinksound_cli)
    if not cli.exists():
        raise RuntimeError(f"thinksound CLI not built at {cli}")

    # `<|caption|>` is the only required view tag; the model also understands
    # <|sfx|>, <|music|>, <|env|>, <|speech|>, <|asr|>.
    caption = args.text if args.text.lstrip().startswith("<|") else f"<|caption|> {args.text}"
    out = out_dir / "sound.wav"
    progress(STAGE, "Generating the sound…")
    t0 = time.time()
    proc = subprocess.run(
        [
            str(cli), "--caption", caption, "--dir", gguf_dir,
            "--steps", str(args.steps), "--cfg", str(args.cfg), "-o", str(out),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if not out.exists():
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
        raise RuntimeError("the sound model produced no file: " + " / ".join(tail))
    secs, rms = _wav_stats(out)
    if rms <= 1.0:
        raise RuntimeError(f"the sound model produced silence ({secs:.2f}s)")
    progress(STAGE, f"Made {secs:.1f}s of audio in {time.time() - t0:.0f}s")
    artifact(STAGE, "audio", str(out), "Sound effect")
    stage_done(STAGE, f"Generated {secs:.1f}s of audio")


def run_asr(args: argparse.Namespace, _out_dir: Path) -> None:
    progress(STAGE, "Loading the speech recogniser…")
    from parakeet_mlx import from_pretrained

    model = from_pretrained(ASR_MODEL)
    progress(STAGE, "Transcribing…")
    t0 = time.time()
    result = model.transcribe(args.audio)
    text = (result.text or "").strip()
    took = time.time() - t0
    if not text:
        raise RuntimeError("no speech was recognised in that audio")
    # The transcript IS the result, so it rides the stage-done message rather
    # than a file: callers read it from the event stream.
    progress(STAGE, f"Transcribed in {took:.2f}s")
    stage_done(STAGE, text)


def _warm_cleanup(cleanup) -> None:
    """Load the corrector; never let it take the worker down.

    Runs on the corrector's OWN thread — see where the pool is created for why
    that is not optional.
    """
    try:
        cleanup.load()
    except Exception:  # noqa: BLE001
        # Not installed is the common case and is not an error: dictation works
        # without it, just with "Retapa" in it.
        pass


# A correction is MEASURED at 0.25-0.76s warm. Ten seconds means something is
# wrong, and a user staring at a finished sentence should get their raw text
# rather than a spinner.
CLEANUP_TIMEOUT_S = 10.0


def _corrected(pool, cleanup, text: str) -> str:
    """Correct on the corrector's thread, or hand back exactly what was heard."""
    try:
        return pool.submit(cleanup.clean, text, lambda m: progress(STAGE, m)).result(
            timeout=CLEANUP_TIMEOUT_S
        )
    except Exception:  # noqa: BLE001
        progress(STAGE, "correction skipped, keeping the raw transcript")
        return text


def run_serve(args: argparse.Namespace, _out_dir: Path) -> None:
    """Warm streaming recogniser: PCM in on stdin, partial transcripts out.

    Dictation cannot be real-time on a cold spawn — the model costs ~15s to
    load, which is longer than most of what anyone dictates. So this process is
    started once, holds the model, and answers a session at a time.

    PROTOCOL, one JSON object per line on stdin:
        {"cmd":"start"}                  begin a session (resets the context)
        {"cmd":"audio","pcm":"<b64>"}    float32 mono 16 kHz, little-endian
        {"cmd":"stop"}                   end the session, emit the final text
    and NDJSON out: a `progress` per partial (the transcript so far) and a
    `stage-done` carrying the final text.

    RAW PCM, NOT AN ENCODED CLIP. The renderer sends float32 samples straight
    from an AudioWorklet, which means nothing has to decode them here — that is
    what removes the ffmpeg dependency that broke dictation for jedd in the
    packaged app (a GUI process has no /opt/homebrew/bin on its PATH).
    """
    import base64
    from concurrent.futures import ThreadPoolExecutor

    import mlx.core as mx
    import numpy as np
    from parakeet_mlx import from_pretrained

    import _asr_cleanup

    progress(STAGE, "Loading the recogniser…")
    model = from_pretrained(ASR_MODEL)
    # Ready BEFORE any audio arrives: the caller waits for this line, so the
    # ~15s load is paid while the user is still reaching for the button rather
    # than after they have finished speaking.
    stage_done(STAGE, "ready")

    # Warm the corrector WHILE the user is still speaking. It costs 2.7s to
    # load and ~0.3s to run, and the moment it is needed — right after `stop` —
    # is the one moment a user is waiting on a finished sentence. Loading it
    # then would put the whole 2.7s in front of them; loading it now spends a
    # window that is otherwise just recording. Failure is silent by design:
    # `clean` falls back to the raw transcript, so a machine that cannot load it
    # dictates exactly as it did before.
    #
    # ONE WORKER, AND IT MATTERS. MLX binds arrays to the thread that made them:
    # loading on a background thread and generating on the main one fails with
    # "There is no Stream(gpu, 3) in current thread" — MEASURED, and it failed
    # silently into the raw-transcript fallback, which is the kind of bug that
    # ships. A single-worker pool guarantees the load and every later generate
    # happen on the same thread. Parakeet keeps the main thread, so the two
    # models never share one.
    cleanup_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cleanup")
    cleanup_pool.submit(_warm_cleanup, _asr_cleanup)

    stream = None
    # Every sample of the session, kept for the final pass (see the `stop`
    # branch for why the streaming text is not good enough to insert).
    captured: list[np.ndarray] = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        cmd = msg.get("cmd")
        if cmd == "start":
            # context_size is (left, right) in encoder frames. A right context
            # of 0 would be ideal — a partial that never waits on audio the user
            # has not spoken yet — but the local-attention kernel REJECTS it
            # ("Context size ... must be > 0"). 32 is the smallest lookahead
            # that still runs: ~0.3s of latency against the library's default
            # 256, which would be ~2.5s and would not read as real time.
            stream = model.transcribe_stream(context_size=(256, 32)).__enter__()
            captured = []
            progress(STAGE, "")
        elif cmd == "audio" and stream is not None:
            pcm = np.frombuffer(base64.b64decode(msg.get("pcm", "")), dtype=np.float32)
            if pcm.size == 0:
                continue
            captured.append(pcm)
            stream.add_audio(mx.array(pcm))
            progress(STAGE, (stream.result.text or "").strip())
        elif cmd == "stop":
            partial = "" if stream is None else (stream.result.text or "").strip()
            if stream is not None:
                stream.__exit__(None, None, None)
                stream = None
            # RE-TRANSCRIBE THE WHOLE THING. Streaming has to decide with a
            # 32-frame lookahead, and it shows — MEASURED on the same 16.5s
            # clip, streaming gave "we should crack the every factor the retapa
            # worker ... three hundred and eighty four pimes, two beg" where a
            # full pass gave "we should probably uh refactor the Retapo worker
            # ... 384 times too big". The partials are for the live feel; the
            # text a user actually keeps comes from the full-context pass.
            #
            # Fed as samples rather than a file: model.transcribe() would call
            # load_audio(), which shells out to ffmpeg. Going straight to the
            # log-mel keeps dictation working on a machine that has no ffmpeg
            # and in a GUI process that cannot see it on PATH.
            final = partial
            if captured:
                try:
                    from parakeet_mlx.audio import get_logmel

                    samples = mx.array(np.concatenate(captured))
                    mel = get_logmel(samples, model.preprocessor_config)
                    result = model.generate(mel)
                    whole = (result[0].text if isinstance(result, list) else result.text) or ""
                    if whole.strip():
                        final = whole.strip()
                except Exception as err:  # noqa: BLE001
                    # A failed second pass must never lose what streaming heard.
                    progress(STAGE, f"(kept the streaming transcript: {err})")
            captured = []
            stage_done(STAGE, _corrected(cleanup_pool, _asr_cleanup, final))
        elif cmd == "quit":
            return


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--op", required=True, choices=["tts", "sfx", "asr", "serve"])
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--text", default="")
    ap.add_argument("--audio", default="")
    ap.add_argument("--steps", type=int, default=25)
    ap.add_argument("--cfg", type=float, default=5.0)
    ap.add_argument("--thinksound-cli", default="")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(Path.home() / ".cache" / "pi-desktop" / "gen3d" / "hf"))

    if args.op in ("tts", "sfx") and not args.text.strip():
        raise SystemExit("--text is required for tts and sfx")
    if args.op == "asr" and not Path(args.audio).exists():
        raise SystemExit(f"--audio not found: {args.audio}")

    {"tts": run_tts, "sfx": run_sfx, "asr": run_asr, "serve": run_serve}[args.op](args, out_dir)


if __name__ == "__main__":
    main()
