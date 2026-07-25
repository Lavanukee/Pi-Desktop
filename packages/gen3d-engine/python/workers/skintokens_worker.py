"""SkinTokens rigging worker — a real learned rig, on Apple Silicon.

WHAT THIS REPLACES

The Animate stage's `rig_worker.py` fits a fixed 27-joint skeleton by MEASURING
the mesh (heights, widths, arm-span ratios). That is geometry, not a model: it
only knows humanoids, and it cannot skin anything it was not hand-tuned for.
SkinTokens (VAST-AI-Research) predicts the skeleton AND the skinning weights for
an ARBITRARY mesh as one autoregressive token sequence — a Qwen3-0.6B transformer
over discrete "skin tokens" produced by an FSQ-CVAE.

RUNNING IT HERE

Upstream states "An NVIDIA GPU with at least 14 GB of memory is required" and
installs flash-attn. None of that is load-bearing for inference — the CUDA
dependency is entirely in HOW attention is computed and in a capability probe,
not in the maths. Three shims in the checkout (never edits to it, so it stays a
clean clone that can be pulled forward):

  flash_attn_interface.py  SDPA behind FlashAttention-3's name, satisfying all
                           five `from flash_attn_interface import …` sites
  apple_compat.py          the H100 probe (`torch.cuda.get_device_name(0)`,
                           which RAISES rather than returning falsy without
                           CUDA), transformers' hard-coded flash_attention_2,
                           and `@torch.autocast(device_type='cuda')` — the last
                           one matters most: on a Mac it silently disables
                           instead of erroring, leaving bf16 weights against
                           fp32 activations, and the first mixed matmul aborts
                           the process inside Metal
  a .pth in the venv       loads apple_compat before anything else, in EVERY
                           process — including the bpy subprocess, which imports
                           the same modules

MEASURED on this M5 Pro, giraffe.glb: pipeline load 12.6s, then generate 16s at
1 beam / 242s at the upstream default of 10 — which is why `--beams` is exposed.
Output is a structurally complete rig: a skin with inverseBindMatrices, the mesh
carrying JOINTS_0 + WEIGHTS_0, and a real bone hierarchy (85 joints at 10 beams
over 14,807 vertices).

*** NOT WIRED INTO THE STUDIO YET — ONE OPEN BUG. ***

The predicted skeleton does not line up with the exported mesh. The predictions
themselves are GOOD: the joints come out in a per-axis normalised frame (each
axis independently scaled to [-1, 1]) and scaling them back by the mesh's
per-axis half-extents puts **100% of them inside the mesh**, versus 40% as
written. So this is a coordinate-frame bug in the hand-off, not a bad model and
not MPS numerics — worth stating plainly, because "the rig looks wrong" would
otherwise read as the port having failed when the hard part demonstrably works.

Upstream's `transfer` endpoint (map the rig back onto the source file) does not
reconcile it either — it fixes the MESH's frame, not the joints'. The remaining
work is to find where the model's normalisation is meant to be inverted and
apply it to the joints before export. Until then this worker is reachable only
from the command line.

Mesh I/O goes through upstream's own bpy server (Blender as a Python module),
spawned here and shut down with the job. It takes no dock tile (verified via
lsappinfo: StatusLabel NULL).
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import artifact, emit, progress, stage_done  # noqa: E402

STAGE = "rig"
CKPT = "experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt"


class RigFailure(Exception):
    """Failure whose `error` event has already been emitted."""


def start_bpy_server(root: Path, python: str):
    """Upstream's Blender-backed mesh loader, in its own process group.

    Its own group so it can be killed as a unit — bpy spawns helpers, and a bare
    terminate() on the parent leaves them behind (the same orphaning that left an
    AutoRemesher at 99% CPU for two hours; see retopo_worker).
    """
    proc = subprocess.Popen(
        [python, "bpy_server.py"],
        cwd=str(root),
        stdout=open(os.environ.get('PI_BPY_LOG', os.devnull), 'w'),
        stderr=subprocess.STDOUT,
        preexec_fn=os.setsid,
    )
    return proc


def stop_bpy_server(proc) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.terminate()
        except OSError:
            pass


def wait_for_bpy(timeout: float) -> None:
    import requests

    from src.server.spec import BPY_SERVER

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            requests.get(f"{BPY_SERVER}/ping", timeout=1)
            return
        except Exception:  # noqa: BLE001 — still starting
            time.sleep(0.5)
    msg = "the Blender mesh loader did not start"
    emit(event="error", message=msg)
    raise RigFailure(msg)


def run(args) -> None:
    import torch
    from torch import Tensor

    from src.data.dataset import DatasetConfig, RigDatasetModule
    from src.data.transform import Transform
    from src.server.spec import get_model, object_to_bytes, bytes_to_object, BPY_SERVER
    from src.tokenizer.parse import get_tokenizer

    device = args.device
    if device == "mps" and not torch.backends.mps.is_available():
        device = "cpu"

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    progress(STAGE, "Loading the rigging model…", 1, 10)
    t0 = time.time()
    model = get_model(CKPT, hf_path=None, device=device)
    tokenizer = get_tokenizer(**model.tokenizer_config)
    transform = Transform.parse(**model.transform_config["predict_transform"])
    progress(STAGE, f"Model loaded in {time.time() - t0:.0f}s", 2, 10)

    cfg = DatasetConfig.parse(
        shuffle=False,
        batch_size=1,
        # IN-PROCESS. A DataLoader worker has to pickle its tensors to the child,
        # and an MPS storage cannot be shared that way ("_share_filename_: only
        # available on CPU"). One mesh per job — there is nothing to parallelise.
        num_workers=0,
        pin_memory=False,
        persistent_workers=False,
        datapath={
            "data_name": None,
            "loader": "bpy_server",
            "filepaths": {"articulation": [str(Path(args.mesh).resolve())]},
        },
    ).split_by_cls()
    module = RigDatasetModule(
        predict_dataset_config=cfg,
        predict_transform=transform,
        tokenizer=tokenizer,
        process_fn=model._process_fn,
    )

    progress(STAGE, "Reading the mesh…", 3, 10)
    loader = module.predict_dataloader()["articulation"]

    for batch in loader:
        batch = {k: (v.to(device) if isinstance(v, Tensor) else v) for k, v in batch.items()}
        batch.pop("skeleton_tokens", None)
        batch.pop("skeleton_mask", None)
        batch["generate_kwargs"] = dict(
            max_length=2048,
            top_k=args.top_k,
            top_p=args.top_p,
            temperature=args.temperature,
            repetition_penalty=args.repetition_penalty,
            num_return_sequences=1,
            num_beams=args.beams,
            do_sample=True,
        )
        progress(STAGE, f"Predicting the skeleton and skin weights ({args.beams} beams)…", 4, 10)
        t1 = time.time()
        preds = model.predict_step(batch, skeleton_tokens=None, make_asset=True)["results"]
        asset = preds[0].asset
        if asset is None:
            msg = "the model produced no rig for this mesh"
            emit(event="error", message=msg)
            raise RigFailure(msg)
        progress(
            STAGE,
            f"Rig predicted in {time.time() - t1:.0f}s — "
            f"{len(asset.joints)} joints over {len(asset.vertices):,} vertices",
            9,
            10,
        )

        out_path = out_dir / "rigged.glb"
        import requests

        # TRANSFER, not export.
        #
        # The model predicts joints in a per-axis normalised frame — each axis
        # independently scaled to [-1, 1] — while a plain `export` writes the
        # mesh in its own aspect-preserving frame. The rig is CORRECT in that
        # frame and lands wrong in this one: MEASURED on the giraffe, exporting
        # directly put only 34 of 85 joints inside the mesh at all, while
        # denormalising per axis puts 100% of them inside. So the skeleton was
        # never the problem — the two halves of the file were in different
        # spaces.
        #
        # `transfer` is upstream's own answer: it maps the predicted rig back
        # onto the ORIGINAL mesh file, so the frame comes from the source rather
        # than from anything reconstructed here.
        endpoint, payload = "export", dict(
            asset=asset, filepath=str(out_path), group_per_vertex=4
        )
        if args.transfer:
            endpoint = "transfer"
            payload = dict(
                source_asset=asset,
                target_path=asset.path,
                export_path=str(out_path),
                group_per_vertex=4,
            )
        res = requests.post(f"{BPY_SERVER}/{endpoint}", data=object_to_bytes(payload))
        res.raise_for_status()
        result = bytes_to_object(res.content)
        if isinstance(result, dict) and result.get("error") is not None:
            result = result.get("traceback") or result["error"]
        if result != "ok":
            msg = f"writing the rigged model failed — {result}"
            emit(event="error", message=msg)
            raise RigFailure(msg)

        emit(
            event="probe",
            stage=STAGE,
            humanoid={
                # SkinTokens predicts an arbitrary skeleton rather than fitting a
                # humanoid template, so there is no humanoid/non-humanoid verdict
                # to make — report what it actually produced.
                "isHumanoid": False,
                "confidence": 1.0,
                "height": 0.0,
                "width": 0.0,
                "depth": 0.0,
                "armSpanRatio": 0.0,
                "reasons": [f"{len(asset.joints)} joints predicted by SkinTokens"],
            },
        )
        artifact(STAGE, "model-glb", str(out_path), "Rigged model")
        stage_done(STAGE, f"Rigged — {len(asset.joints)} joints, skinned per vertex")
        return

    msg = "the mesh could not be read"
    emit(event="error", message=msg)
    raise RigFailure(msg)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mesh", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--root", required=True, help="the SkinTokens checkout")
    ap.add_argument("--device", default="mps")
    # The upstream default of 10 beams is what makes a run take minutes.
    ap.add_argument("--beams", type=int, default=10)
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--top-p", type=float, default=0.95)
    ap.add_argument("--temperature", type=float, default=1.0)
    ap.add_argument("--repetition-penalty", type=float, default=2.0)
    # Map the rig back onto the source mesh (see the export block).
    ap.add_argument("--no-transfer", dest="transfer", action="store_false")
    ap.set_defaults(transfer=True)
    ap.add_argument("--bpy-timeout", type=float, default=180.0)
    args = ap.parse_args()

    root = Path(args.root).resolve()
    sys.path.insert(0, str(root))
    os.chdir(root)  # the checkpoint paths in CKPT are relative to the checkout

    server = None
    try:
        server = start_bpy_server(root, sys.executable)
        wait_for_bpy(args.bpy_timeout)
        run(args)
    except RigFailure:
        sys.exit(2)  # already reported
    except Exception as err:  # noqa: BLE001
        emit(event="error", message=str(err))
        sys.exit(2)
    finally:
        stop_bpy_server(server)


if __name__ == "__main__":
    main()
