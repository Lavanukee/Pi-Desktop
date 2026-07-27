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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--op", required=True, choices=["tts", "sfx", "asr"])
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

    {"tts": run_tts, "sfx": run_sfx, "asr": run_asr}[args.op](args, out_dir)


if __name__ == "__main__":
    main()
