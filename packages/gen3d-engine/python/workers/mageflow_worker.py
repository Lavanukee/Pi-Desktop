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
import os
import sys
from pathlib import Path

# BEFORE mage_flow imports: the Qwen3-VL text encoder defaults to
# flash_attention_2; VF_HF_ATTN_IMPL is mage_flow's own env override for
# machines without flash-attn (models/modules/text_encoder.py).
os.environ.setdefault("VF_HF_ATTN_IMPL", "sdpa")

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

    # Step progress: wrap the DiT forward at CLASS level (one forward per
    # denoise step with cfg=1; cond/uncond are fused). Class-level because the
    # pipeline hands the module around internally.
    from mage_flow.models.mage_flow import MageFlow

    real_forward = MageFlow.forward
    state = {"step": 0}

    def counting_forward(self, *fargs, **fkwargs):
        state["step"] += 1
        step = min(state["step"], args.steps)
        progress(STAGE, f"Denoising (step {step}/{args.steps})", step, args.steps)
        return real_forward(self, *fargs, **fkwargs)

    MageFlow.forward = counting_forward

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = MageFlowPipeline.from_pretrained(args.model, device=device)
    # MageFlow.__init__ re-selects the backend from its config's attn_type
    # (default "flash2" — models/mage_flow.py:160), clobbering the call above;
    # force sdpa again AFTER load. Without this the first denoise step dies
    # with ModuleNotFoundError: flash_attn (verified here).
    set_attn_backend("sdpa")
    progress(STAGE, "Model loaded — generating…")

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
