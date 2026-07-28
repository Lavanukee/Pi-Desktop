"""Rig worker — writes a REAL skinned GLB (joint hierarchy + per-vertex weights)
by one of two geometric methods. No learned model, nothing to download, ~1-3 s,
deterministic either way.

  --method template  fits NVIDIA ARDY's 27-joint humanoid skeleton. What it
                     guarantees is the interface ARDY expects: cskel27
                     joint-for-joint in ARDY's parent order, translation-only
                     bind pose, glTF-conformant JOINTS_0/WEIGHTS_0. See
                     _humanoid.py for the joint contract and why it is NOT the
                     Mixamo hierarchy. Right for a person, nonsense for a horse.

  --method medial    derives the skeleton from the mesh's OWN medial axis — no
                     template and no opinion about how many limbs the subject
                     has. See _medial.py. This is the default for anything that
                     does not measure as humanoid, so a creature gets a real rig
                     without the 2.5 GB SkinTokens download.

`--probe-only` measures the shape and stops, so the UI can ask the user
"humanoid?" before rigging; `--require-humanoid` refuses to fit a humanoid
skeleton to a mesh that does not measure as one.
"""

from __future__ import annotations

import argparse
import json
import sys
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

from _glbskin import write_skinned_glb  # noqa: E402
from _medial import extract as extract_medial  # noqa: E402
from _medial import skin as skin_medial  # noqa: E402
from _humanoid import (  # noqa: E402
    BONE_NAMES,
    BONE_PARENT,
    MIXAMO_ALIAS,
    SKELETON_ID,
    fit_skeleton,
    probe_humanoid,
    skin_weights,
)
from _meshprep import heal_for_native_tool, load_concatenated  # noqa: E402
from _progress import artifact, emit, error, progress, stage_done  # noqa: E402

STAGE = "rig"
TOTAL_STEPS = 5


def extract_uv_and_texture(mesh) -> tuple[np.ndarray | None, bytes | None]:
    """Carry UVs + the base-colour image through the rig when the source has
    them, so rigging a textured model does not silently strip its texture."""
    try:
        visual = getattr(mesh, "visual", None)
        uv = getattr(visual, "uv", None)
        if uv is None or len(uv) != len(mesh.vertices):
            return None, None
        image = getattr(getattr(visual, "material", None), "baseColorTexture", None)
        png: bytes | None = None
        if image is not None:
            buf = BytesIO()
            image.convert("RGBA").save(buf, format="PNG")
            png = buf.getvalue()
        return np.asarray(uv, dtype=np.float32), png
    except Exception:  # noqa: BLE001 — texture carry-through is best effort
        return None, None


def rig_from_medial_axis(out_dir: Path, healed, vertices, uv, base_png, probe) -> None:
    """Rig by the mesh's own medial axis — no template, any body plan.

    Kept beside the template fitter rather than in its own worker: same venv,
    same mesh loading, same GLB writer, and the two are chosen between per run.
    """
    progress(STAGE, "Reading the shape's medial axis…", 3, TOTAL_STEPS)
    skeleton = extract_medial(healed, lambda m: progress(STAGE, m, 3, TOTAL_STEPS))

    progress(
        STAGE,
        f"Skinning {len(vertices):,} vertices to {len(skeleton.names)} bones…",
        4,
        TOTAL_STEPS,
    )
    joint_index, joint_weight = skin_medial(vertices, skeleton)

    progress(STAGE, "Writing rigged GLB…", 5, TOTAL_STEPS)
    out_glb = out_dir / "rigged.glb"
    write_skinned_glb(
        str(out_glb),
        vertices,
        np.asarray(healed.faces, dtype=np.uint32),
        np.asarray(healed.vertex_normals, dtype=np.float32),
        skeleton.names,
        skeleton.parent,
        skeleton.position,
        joint_index,
        joint_weight,
        uv=uv,
        base_color_png=base_png,
        extras={
            "pd_rig": {
                "skeleton": "medial-axis",
                "bones": skeleton.names,
                "boneCount": len(skeleton.names),
                # ARDY drives cskel27 and nothing else. A derived skeleton has
                # the joints this shape needs, not the ones ARDY was trained on.
                "ardyCompatible": False,
                "method": "medial-axis",
                "humanoid": probe.as_dict(),
            }
        },
    )
    (out_dir / "rig-skeleton.json").write_text(json.dumps(skeleton.as_dict(), indent=2))
    artifact(STAGE, "model-glb", str(out_glb), f"Rigged · {len(skeleton.names)} bones")
    summary = (
        f"{len(skeleton.names)} bones derived from the shape, {len(vertices):,} vertices skinned"
    )
    progress(STAGE, f"Rig done — {summary}", TOTAL_STEPS, TOTAL_STEPS)
    stage_done(STAGE, summary)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mesh", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--require-humanoid", action="store_true")
    ap.add_argument("--probe-only", action="store_true")
    ap.add_argument("--method", choices=("template", "medial"), default="template")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    progress(STAGE, "Reading mesh…", 1, TOTAL_STEPS)
    source = load_concatenated(args.mesh)
    uv, base_png = extract_uv_and_texture(source)

    progress(STAGE, "Analysing shape…", 2, TOTAL_STEPS)
    # Rigging needs real adjacency for normals/orientation, but must NOT weld
    # away the UV split when we are carrying a texture through.
    if uv is None:
        healed, _prep = heal_for_native_tool(source, fill=True, min_component_faces=0)
    else:
        healed = source
    vertices = np.asarray(healed.vertices, dtype=np.float64)
    probe = probe_humanoid(vertices)

    # The probe is a first-class result: the UI asks "humanoid?" from it.
    emit(event="probe", stage=STAGE, humanoid=probe.as_dict())
    (out_dir / "rig-probe.json").write_text(json.dumps(probe.as_dict(), indent=2))

    if args.probe_only:
        progress(
            STAGE,
            f"Humanoid: {'yes' if probe.is_humanoid else 'no'} "
            f"({round(probe.confidence * 100)}% confidence)",
            TOTAL_STEPS,
            TOTAL_STEPS,
        )
        stage_done(STAGE, "Shape analysed")
        return

    if args.method == "medial":
        rig_from_medial_axis(out_dir, healed, vertices, uv, base_png, probe)
        return

    if args.require_humanoid and not probe.is_humanoid:
        error(
            "this mesh does not measure as a humanoid ("
            + "; ".join(probe.reasons or ["no humanoid structure found"])
            + ") — humanoid rigging would produce a skeleton that does not follow the body"
        )
        sys.exit(1)

    progress(STAGE, "Fitting the humanoid skeleton…", 3, TOTAL_STEPS)
    joints = fit_skeleton(vertices)

    progress(STAGE, f"Skinning {len(vertices):,} vertices to {len(BONE_NAMES)} bones…", 4, TOTAL_STEPS)
    joint_index, joint_weight = skin_weights(vertices, joints)

    progress(STAGE, "Writing rigged GLB…", 5, TOTAL_STEPS)
    normals = np.asarray(healed.vertex_normals, dtype=np.float32)
    out_glb = out_dir / "rigged.glb"
    extras = {
        "pd_rig": {
            "skeleton": SKELETON_ID,
            "bones": BONE_NAMES,
            "boneCount": len(BONE_NAMES),
            # The hierarchy IS ardy/skeleton/definitions.py's cskel27, so ARDY
            # motion retargets onto it without a bone remap.
            "ardyCompatible": True,
            "mixamoAlias": MIXAMO_ALIAS,
            "method": "geometric-fit",
            "humanoid": probe.as_dict(),
        }
    }
    write_skinned_glb(
        str(out_glb),
        vertices,
        np.asarray(healed.faces, dtype=np.uint32),
        normals,
        BONE_NAMES,
        BONE_PARENT,
        joints,
        joint_index,
        joint_weight,
        uv=uv,
        base_color_png=base_png,
        extras=extras,
    )
    (out_dir / "rig-skeleton.json").write_text(
        json.dumps(
            {
                "skeleton": SKELETON_ID,
                "bones": [
                    {"name": n, "parent": BONE_PARENT[n], "head": [float(v) for v in joints[n]]}
                    for n in BONE_NAMES
                ],
            },
            indent=2,
        )
    )
    artifact(STAGE, "model-glb", str(out_glb), f"Rigged · {len(BONE_NAMES)} bones")
    summary = f"{len(BONE_NAMES)} humanoid bones, {len(vertices):,} vertices skinned"
    progress(STAGE, f"Rig done — {summary}", TOTAL_STEPS, TOTAL_STEPS)
    stage_done(STAGE, summary)


if __name__ == "__main__":
    main()
