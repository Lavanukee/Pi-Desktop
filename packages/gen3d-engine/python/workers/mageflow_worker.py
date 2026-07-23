"""Mage-Flow Turbo worker — text → image on MPS (the first hop of text → 3D).

Runs inside the Mage venv (torch 2.13 / transformers 5.5 / diffusers 0.38,
NO flash-attn). mage_flow ships a first-class SDPA fallback
(models/modules/_attn_backend.set_attn_backend('sdpa')) and its pipeline uses
torch.autocast(device_type=<device>), so MPS is a supported path.

Per-step progress: the Turbo transformer runs once per denoise step (cfg=1.0
fuses branches), so wrapping the DiT's forward gives exact step counts without
touching upstream code.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import artifact, progress, stage_done  # noqa: E402

STAGE = "image"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="microsoft/Mage-Flow-Turbo")
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--cfg", type=float, default=1.0)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    progress(STAGE, "Loading Mage-Flow Turbo (17.5 GB, bf16)…")
    import torch

    from mage_flow import MageFlowPipeline
    from mage_flow.models.modules._attn_backend import set_attn_backend

    set_attn_backend("sdpa")
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = MageFlowPipeline.from_pretrained(args.model, device=device)
    progress(STAGE, "Model loaded — generating…")

    # Exact step progress: the DiT forward runs once per denoise step (cfg 1).
    transformer = getattr(pipe, "transformer", None) or getattr(pipe, "model", None)
    if transformer is not None:
        real_forward = transformer.forward
        state = {"step": 0}

        def counting_forward(*fargs, **fkwargs):
            state["step"] += 1
            step = min(state["step"], args.steps)
            progress(STAGE, f"Denoising (step {step}/{args.steps})", step, args.steps)
            return real_forward(*fargs, **fkwargs)

        transformer.forward = counting_forward

    images = pipe.generate(
        [args.prompt],
        steps=args.steps,
        cfg=args.cfg,
        heights=[args.size],
        widths=[args.size],
        seeds=[args.seed],
    )
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(str(out_path))
    artifact(STAGE, "image", str(out_path), "Prompt image")
    stage_done(STAGE, "Image generated")


if __name__ == "__main__":
    main()
