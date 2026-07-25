"""MLX image worker — Mage-Flow-Turbo on MLX, the fast image path.

MEASURED on the same prompt/size/steps (1024px, 4 steps, M5 Pro 24 GB), each
output inspected VISUALLY rather than trusted from a timing:

    Mage-Flow-Turbo (PyTorch MPS)   71 s   coherent
    FLUX.2 Klein 4B (MLX, q4)       13 s   coherent, 17.94 GB peak
    Mage-Flow-Turbo (MLX, q8)       11 s   coherent, 14.69 GB peak   ← chosen
    Mage-Flow-Turbo (MLX, q4)       11 s   *** BROKEN *** — blue noise, no subject

So Mage-Flow wins on all three axes (speed, memory, image quality) — but ONLY
at 8-bit. The 4-bit path on the current mflux Mage-Flow branch produces pure
noise while reporting a perfectly normal run, which is exactly why DEFAULT_QUANT
is 8 and why a quantization change here must be re-checked by eye, not by
whether the process exited 0.

Mage-Flow is a 4B NR-MMDiT (rectified flow, Qwen3-VL text encoder, Mage-VAE),
MIT, and scores GenEval 0.90 vs FLUX.2-dev's 0.87 at 1/8 the parameters — which
is why it is the target rather than a FLUX variant.

Runs the mflux CLI (MIT) from its own venv: mflux is CLI-first, and shelling out
keeps its deps out of every other worker's environment. Emits the standard
NDJSON contract so jobs.py needs no special case.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import artifact, emit, progress, stage_done  # noqa: E402

STAGE = "image"

DEFAULT_MODEL = "mage-flow-turbo"
# 8, NOT 4 — see the module docstring: 4-bit Mage-Flow renders noise.
DEFAULT_QUANT = 8


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cli", required=True, help="path to the mflux entrypoint")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--quantize", type=int, default=DEFAULT_QUANT)
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    progress(STAGE, f"Generating image with {args.model} ({args.steps} steps)…", 1, 2)
    cmd = [
        args.cli,
        "--model", args.model,
        "-q", str(args.quantize),
        "--steps", str(args.steps),
        "--seed", str(args.seed),
        "--height", str(args.size),
        "--width", str(args.size),
        "--prompt", args.prompt,
        "--output", str(out),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=args.timeout)
    except subprocess.TimeoutExpired:
        emit(event="error", message=f"image generation exceeded {args.timeout}s")
        sys.exit(1)

    if proc.returncode != 0 or not out.exists():
        # Keep the reason short — mflux prints a progress bar, not a stack trace.
        tail = [ln.strip() for ln in (proc.stderr or "").splitlines() if ln.strip()]
        reason = tail[-1][:200] if tail else f"exit {proc.returncode}"
        emit(event="error", message=f"image generation failed — {reason}")
        sys.exit(1)

    artifact(STAGE, "image", str(out), "Prompt image")
    stage_done(STAGE, "Image generated")


if __name__ == "__main__":
    main()
