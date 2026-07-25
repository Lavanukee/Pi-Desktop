"""FLUX.2 Klein image worker — MLX-native text→image, the fast image path.

MEASURED against the Mage-Flow-Turbo worker on the same prompt/size/steps
(1024px, 4 steps, M5 Pro 24 GB):

    Mage-Flow-Turbo (PyTorch MPS)   71 s
    FLUX.2 Klein 4B (MLX, q4)       13 s   ← 5.5x faster

The gap is the backend, not the model size: MLX targets the M5's GPU neural
accelerators, which PyTorch's MPS backend largely does not.

Runs `mflux-generate-flux2` (mflux, MIT) out of its own venv rather than
importing it — mflux is a CLI-first project and shelling out keeps its heavy
deps out of every other worker's environment. Emits the same NDJSON contract as
the other workers so jobs.py needs no special case.

MEMORY: the 4B at 1024² peaks at ~17.9 GB of a 24 GB machine. That fits, but it
is why this worker pins the 4B and not the 9B — the larger variant does not fit
at this resolution, and an OOM mid-generation is worse than a slower model.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import artifact, emit, progress, stage_done  # noqa: E402

STAGE = "image"

# The 9B variant does not fit alongside 1024² activations in 24 GB (see above).
KLEIN_MODEL = "flux2-klein-4b"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cli", required=True, help="path to mflux-generate-flux2")
    ap.add_argument("--model", default=KLEIN_MODEL)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--quantize", type=int, default=4)
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
