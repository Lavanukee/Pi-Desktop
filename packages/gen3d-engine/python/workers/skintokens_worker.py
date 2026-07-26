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

FLOAT32, NOT BFLOAT16 — THIS IS THE WHOLE BALL GAME ON THIS BACKEND

bfloat16 on MPS runs without complaint and produces a rig that is *structurally*
perfect and *geometrically* meaningless: valid skin, inverse bind matrices,
JOINTS_0/WEIGHTS_0, a clean bone hierarchy — and joints that have nothing to do
with the vertices they drive.

Measuring that took two attempts, and the first was wrong. Counting joints
inside the mesh's BOUNDING BOX said 40%, and a per-axis rescale
(fit_joints_to_mesh) took it to 100% — which looked like a fix and was not: a
giraffe's bounding box is mostly air. The test that means something is the
distance from each joint to the weighted centroid of the vertices it actually
drives, as a fraction of the model diagonal:

    MPS bfloat16   242s   median 36.6%   p90 60.8%    scattered noise
    CPU float32   1103s   median  2.3%   p90 12.7%    correct
    MPS float32     76s   median  2.9%   p90  6.9%    correct   ← default

So it was never the model, the frame, the beam count or the export path — it was
the dtype. fp32 on MPS is also 3x faster than the broken bf16 path and 14x
faster than CPU, because the fallbacks bf16 forces are slower than the native
fp32 kernels. Rendered side by side, bf16 gives a cloud of joints in open space
and fp32 gives a recognisable giraffe skeleton: neck chain, spine, four legs.

Requires PI_ST_AUTOCAST=off in the environment (the venv's .pth reads it at
interpreter start, because the autocast decorators bind at import time) together
with --dtype float32, which casts the model after load.

`--fit-joints` stays ON: with a correct rig it is a small tidy-up, not a crutch.

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


def bpy_alive() -> bool:
    """Is a bpy server already listening on the fixed port?"""
    try:
        import requests

        from src.server.spec import BPY_SERVER

        requests.get(f"{BPY_SERVER}/ping", timeout=1)
        return True
    except Exception:  # noqa: BLE001 — anything at all means "not usable"
        return False


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


def fit_joints_to_mesh(asset) -> None:
    """Map the predicted joints out of the unit cube and onto the mesh.

    MEASURED on the giraffe, straight off the model (asset level, before any
    export):

        vertices   X ±0.170   Y ±0.786   Z ±1.000     (uniformly normalised —
                                                       longest axis hits 1)
        joints     X ±~0.86   Y ±~0.82   Z ±~0.78     (near-isotropic)

    The mesh is very anisotropic and the joints are not, because the joints come
    back in a cube normalised PER AXIS. Rescaling each axis by the mesh's own
    half-extent puts 100% of the joints inside the mesh's bounding box, against
    40% left alone.

    That is worth doing but it is NOT a fix, and the bounding-box number should
    not be read as one: a giraffe's box is mostly air. Measured against the
    vertices each joint actually drives, the rescale changes nothing (36.6% →
    39.9% of the model diagonal, where a usable rig is a few percent). See the
    module docstring — the rig itself is wrong, and this only tidies where it
    sits.

    Joints live in `matrix_local[:, :3, 3]` (Asset.joints is a read-only view of
    it), so the translation columns are what get rewritten. This is a rigid
    per-axis scale: it moves joints, never the mesh, and leaves the skinning
    weights — which are per-vertex-per-joint and frame-independent — untouched.
    """
    import numpy as np

    if asset.matrix_local is None or asset.vertices is None:
        return
    v = np.asarray(asset.vertices)
    lo, hi = v.min(axis=0), v.max(axis=0)
    half = (hi - lo) / 2.0
    centre = (hi + lo) / 2.0
    for axis in range(3):
        asset.matrix_local[:, axis, 3] = asset.matrix_local[:, axis, 3] * half[axis] + centre[axis]


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
    if args.dtype == "float32":
        # bfloat16 on MPS produces a rig whose joints do not match its own skin
        # weights — see the module docstring for the measurement.
        model = model.float()
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

        # RETRY: the decoder SAMPLES (do_sample=True), so the token sequence
        # differs every run and occasionally decodes to something the tokenizer
        # rejects — a bare `assert` or "unexpected token found: 23508". Observed
        # on a mesh that then rigged cleanly on the very next attempt with no
        # change but the draw, so this is the sampler's variance and not the
        # mesh. Re-roll rather than failing the stage.
        asset = None
        last_err: Exception | None = None
        for attempt in range(args.attempts):
            if attempt > 0:
                torch.manual_seed(args.seed + attempt)
                progress(
                    STAGE,
                    f"That sample did not decode — re-rolling "
                    f"({attempt + 1} of {args.attempts})…",
                    5,
                    10,
                )
            try:
                preds = model.predict_step(
                    batch, skeleton_tokens=None, make_asset=True
                )["results"]
                asset = preds[0].asset
                if asset is not None:
                    break
            except (AssertionError, ValueError, IndexError, KeyError) as err:
                last_err = err
        if asset is None:
            detail = f" ({type(last_err).__name__}: {last_err})".rstrip(" ()") if last_err else ""
            msg = f"the model produced no rig for this mesh after {args.attempts} attempts{detail}"
            emit(event="error", message=msg)
            raise RigFailure(msg)
        progress(
            STAGE,
            f"Rig predicted in {time.time() - t1:.0f}s — "
            f"{len(asset.joints)} joints over {len(asset.vertices):,} vertices",
            9,
            10,
        )

        if args.fit_joints:
            fit_joints_to_mesh(asset)

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
    # fp32 by DEFAULT on this backend: bf16 is what breaks the rig (see the
    # module docstring). PI_ST_AUTOCAST=off must be exported by the launcher so
    # the venv's .pth sees it — autocast decorators bind at import time.
    ap.add_argument("--dtype", default="float32", choices=["float32", "bfloat16"])
    # The upstream default of 10 beams is what makes a run take minutes.
    ap.add_argument("--beams", type=int, default=10)
    ap.add_argument("--seed", type=int, default=0)
    # The decoder samples; a bad draw is retryable (see the loop).
    ap.add_argument("--attempts", type=int, default=3)
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--top-p", type=float, default=0.95)
    ap.add_argument("--temperature", type=float, default=1.0)
    ap.add_argument("--repetition-penalty", type=float, default=2.0)
    # Map the rig back onto the source mesh (see the export block).
    ap.add_argument("--transfer", action="store_true",
                    help="map the rig onto the SOURCE file instead of exporting the asset")
    ap.add_argument("--no-fit-joints", dest="fit_joints", action="store_false")
    ap.set_defaults(transfer=False, fit_joints=True)
    ap.add_argument("--bpy-timeout", type=float, default=180.0)
    args = ap.parse_args()

    root = Path(args.root).resolve()
    sys.path.insert(0, str(root))
    os.chdir(root)  # the checkpoint paths in CKPT are relative to the checkout

    server = None
    try:
        # Only spawn if nothing is already answering. The port is FIXED, so a
        # server left over from an earlier job would still be listening: the new
        # one would fail to bind, requests would go to the stale process, and
        # this job's cleanup would then kill it mid-request — which surfaced as
        # `ChunkedEncodingError: Connection broken` right at the export, after a
        # successful 6-minute prediction. Reusing a live server also skips its
        # ~15s Blender start-up.
        if not bpy_alive():
            server = start_bpy_server(root, sys.executable)
            wait_for_bpy(args.bpy_timeout)
        run(args)
    except RigFailure:
        sys.exit(2)  # already reported
    except Exception as err:  # noqa: BLE001
        # Some upstream errors carry no message at all (a bare assert), so a
        # plain str(err) reports nothing and the failure looks like a silent
        # one. Always name the type, and put the traceback on stderr.
        import traceback

        traceback.print_exc(file=sys.stderr)
        emit(event="error", message=f"{type(err).__name__}: {err}".strip().rstrip(":"))
        sys.exit(2)
    finally:
        stop_bpy_server(server)


if __name__ == "__main__":
    main()
