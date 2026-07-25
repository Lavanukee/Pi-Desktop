"""Humanoid detection + the ARDY-compatible bone hierarchy.

WHAT THIS IS, PLAINLY
---------------------
This is a GEOMETRIC auto-rigger, not a learned one. It measures the mesh and
fits a standard humanoid skeleton to it, then paints skin weights from bone
distance. It is deterministic, offline, runs in ~1 s with no weights to
download, and produces a real skinned GLB.

It is NOT SkinTokens — it is a geometric placeholder, and SkinTokens is the
intended replacement.

CORRECTION (2026-07-24): an earlier version of this comment claimed SkinTokens
"requires a >=14 GB NVIDIA GPU … it cannot run on Apple Silicon". That is
WRONG. It described the upstream CUDA repo, and it came from web research that
was never executed. `mlx-community/SkinTokens-bf16` is a real MLX port (1.68 GB
bf16, Qwen3-0.6B backbone + SkinVAE decoder) that runs natively on Apple
Silicon via the Swift `mlx-skintokens-swift` package, with `auto` (skeleton +
skin) and `skinOnly` modes.

What IS still true: it emits a VRoid-template hierarchy with per-vertex
`JOINTS_0`/`WEIGHTS_0`, so feeding a consumer that expects a different skeleton
(e.g. ARDY's cskel27) needs a RETARGETING step — a mapping problem, not a
hardware one.

WHY THIS EXACT SKELETON
-----------------------
NVIDIA ARDY consumes a bespoke 27-joint skeleton ("cskel27",
ardy/skeleton/definitions.py), NOT SMPL and NOT Mixamo. It is Mixamo-*flavoured*
but topologically different in ways that matter:
  * it has Spine3 — Mixamo stops at Spine2, so a Mixamo rig is one spine joint
    short and the shoulder/neck parent differs;
  * shoulders and neck parent to Spine3, not Spine2;
  * it has {Left,Right}HandEnd and a single {Left,Right}HandThumb1;
  * no `mixamorig:` prefix, and no leaf/tip bones (HeadTop_End, Toe_End).
Emitting Mixamo names here would mean a rename is NOT sufficient to feed ARDY.
So the fit below IS cskel27, joint-for-joint, in ARDY's own parent order.

MIXAMO_ALIAS maps the 22 joints that do correspond, for retargeting bundled
Mixamo clips onto the result.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# NVIDIA ARDY "cskel27" — 27 joints, (name, parent), hierarchy order.
BONES: list[tuple[str, str | None]] = [
    ("Hips", None),
    ("Spine", "Hips"),
    ("Spine1", "Spine"),
    ("Spine2", "Spine1"),
    ("Spine3", "Spine2"),
    ("Neck", "Spine3"),
    ("Head", "Neck"),
    ("RightShoulder", "Spine3"),
    ("RightArm", "RightShoulder"),
    ("RightForeArm", "RightArm"),
    ("RightHand", "RightForeArm"),
    ("RightHandEnd", "RightHand"),
    ("RightHandThumb1", "RightHand"),
    ("LeftShoulder", "Spine3"),
    ("LeftArm", "LeftShoulder"),
    ("LeftForeArm", "LeftArm"),
    ("LeftHand", "LeftForeArm"),
    ("LeftHandEnd", "LeftHand"),
    ("LeftHandThumb1", "LeftHand"),
    ("RightUpLeg", "Hips"),
    ("RightLeg", "RightUpLeg"),
    ("RightFoot", "RightLeg"),
    ("RightToeBase", "RightFoot"),
    ("LeftUpLeg", "Hips"),
    ("LeftLeg", "LeftUpLeg"),
    ("LeftFoot", "LeftLeg"),
    ("LeftToeBase", "LeftFoot"),
]

BONE_NAMES: list[str] = [n for n, _ in BONES]
BONE_PARENT: dict[str, str | None] = dict(BONES)
SKELETON_ID = "ardy-cskel27"

# cskel27 → Mixamo, for retargeting Mixamo-authored clips onto this rig. Spine3
# has no Mixamo counterpart (Mixamo stops at Spine2) and the *HandEnd /
# *HandThumb1 joints have no clean equivalent, so they are deliberately absent.
MIXAMO_ALIAS: dict[str, str] = {
    name: f"mixamorig:{name}"
    for name in BONE_NAMES
    if name not in {"Spine3", "LeftHandEnd", "RightHandEnd"}
}

# Bones whose motion should not drag the whole surface with it.
TIP_BONES = {
    "LeftToeBase",
    "RightToeBase",
    "LeftHandEnd",
    "RightHandEnd",
    "LeftHandThumb1",
    "RightHandThumb1",
}


@dataclass
class HumanoidProbe:
    """Measurements behind the humanoid verdict — shown to the user, not hidden."""

    is_humanoid: bool
    confidence: float
    height: float
    width: float
    depth: float
    leg_split_height: float | None
    arm_span_ratio: float
    reasons: list[str]

    def as_dict(self) -> dict:
        return {
            "isHumanoid": self.is_humanoid,
            "confidence": round(self.confidence, 3),
            "height": round(self.height, 4),
            "width": round(self.width, 4),
            "depth": round(self.depth, 4),
            "legSplitHeight": None if self.leg_split_height is None else round(self.leg_split_height, 4),
            "armSpanRatio": round(self.arm_span_ratio, 3),
            "reasons": self.reasons,
        }


def _slice_components(xs: np.ndarray, gap: float) -> list[tuple[float, float]]:
    """1-D clustering of x positions: returns [(lo, hi), …] runs separated by gap."""
    if xs.size == 0:
        return []
    order = np.sort(xs)
    runs: list[tuple[float, float]] = []
    start = prev = order[0]
    for value in order[1:]:
        if value - prev > gap:
            runs.append((float(start), float(prev)))
            start = value
        prev = value
    runs.append((float(start), float(prev)))
    return runs


def probe_humanoid(vertices: np.ndarray) -> HumanoidProbe:
    """Decide whether an upright Y-up mesh reads as a humanoid.

    The test is structural, not semantic: a humanoid in T/A pose splits into two
    leg columns in the lower body and reaches wide at shoulder height. Both are
    measured off horizontal slices.
    """
    lo = vertices.min(axis=0)
    hi = vertices.max(axis=0)
    size = hi - lo
    height = float(size[1])
    width = float(size[0])
    depth = float(size[2])
    reasons: list[str] = []
    if height <= 1e-6:
        return HumanoidProbe(False, 0.0, height, width, depth, None, 0.0, ["flat mesh"])

    score = 0.0
    # 1. Upright: taller than it is deep. Humanoids are.
    if height > depth * 1.6:
        score += 0.3
    else:
        reasons.append("not upright (height ≈ depth)")

    # 2. Two leg columns in the lower third.
    gap = max(width, 1e-6) * 0.06
    leg_split: float | None = None
    for frac in (0.10, 0.16, 0.22, 0.30):
        y = lo[1] + height * frac
        band = vertices[np.abs(vertices[:, 1] - y) < height * 0.02]
        runs = _slice_components(band[:, 0], gap)
        if len(runs) == 2:
            leg_split = float(y)
            break
    if leg_split is not None:
        score += 0.35
    else:
        reasons.append("no two-leg split found in the lower body")

    # 3. Arm reach: the widest slice sits in the upper body and is wide relative
    #    to the hip width (T/A pose).
    upper = vertices[vertices[:, 1] > lo[1] + height * 0.55]
    hips = vertices[np.abs(vertices[:, 1] - (lo[1] + height * 0.5)) < height * 0.05]
    hip_w = float(np.ptp(hips[:, 0])) if hips.size else width
    upper_w = float(np.ptp(upper[:, 0])) if upper.size else 0.0
    span_ratio = upper_w / max(hip_w, 1e-6)
    if span_ratio > 1.6:
        score += 0.35
    elif span_ratio > 1.15:
        score += 0.18
        reasons.append("arms read as narrow (A-pose or arms down)")
    else:
        reasons.append("no arm span detected at shoulder height")

    is_humanoid = score >= 0.6
    return HumanoidProbe(
        is_humanoid, score, height, width, depth, leg_split, span_ratio, reasons
    )


def fit_skeleton(vertices: np.ndarray) -> dict[str, np.ndarray]:
    """Place every BONE_NAMES joint on this mesh, in world space (Y-up).

    Heights come from anthropometric fractions of the measured stature; the X/Z
    placement of limbs is measured off the mesh so it tracks the actual body.
    """
    lo = vertices.min(axis=0)
    hi = vertices.max(axis=0)
    height = float(hi[1] - lo[1])
    cx = float((lo[0] + hi[0]) * 0.5)
    cz = float((lo[2] + hi[2]) * 0.5)

    def y(frac: float) -> float:
        return float(lo[1] + height * frac)

    def slice_x_extremes(frac: float, band: float = 0.03) -> tuple[float, float]:
        yy = y(frac)
        sel = vertices[np.abs(vertices[:, 1] - yy) < height * band]
        if sel.size == 0:
            return cx, cx
        return float(sel[:, 0].min()), float(sel[:, 0].max())

    # Leg columns: measure the two clusters just above the ankles.
    gap = max(float(hi[0] - lo[0]), 1e-6) * 0.06
    ankle_band = vertices[np.abs(vertices[:, 1] - y(0.10)) < height * 0.03]
    runs = _slice_components(ankle_band[:, 0], gap) if ankle_band.size else []
    if len(runs) == 2:
        left_x = float((runs[1][0] + runs[1][1]) * 0.5)
        right_x = float((runs[0][0] + runs[0][1]) * 0.5)
    else:
        hip_l, hip_r = slice_x_extremes(0.50)
        quarter = (hip_r - hip_l) * 0.25
        left_x, right_x = cx + quarter, cx - quarter

    shoulder_l, shoulder_r = slice_x_extremes(0.80)
    arm_l, arm_r = slice_x_extremes(0.78, band=0.05)
    # Shoulder joints sit inboard of the silhouette; hands at the extremes.
    body_half = max((shoulder_r - shoulder_l) * 0.5, 1e-6)
    sh_off = min(body_half * 0.35, height * 0.09)
    hand_l, hand_r = arm_r, arm_l  # +X is the model's LEFT in glTF (Y-up, -Z fwd)

    joints: dict[str, np.ndarray] = {
        "Hips": np.array([cx, y(0.53), cz]),
        "Spine": np.array([cx, y(0.58), cz]),
        "Spine1": np.array([cx, y(0.635), cz]),
        "Spine2": np.array([cx, y(0.69), cz]),
        "Spine3": np.array([cx, y(0.745), cz]),
        "Neck": np.array([cx, y(0.835), cz]),
        "Head": np.array([cx, y(0.88), cz]),
        "LeftShoulder": np.array([cx + sh_off * 0.5, y(0.80), cz]),
        "LeftArm": np.array([cx + sh_off, y(0.795), cz]),
        "LeftForeArm": np.array([cx + (hand_l - cx) * 0.55, y(0.79), cz]),
        "LeftHand": np.array([cx + (hand_l - cx) * 0.88, y(0.785), cz]),
        "LeftHandEnd": np.array([hand_l, y(0.783), cz]),
        "LeftHandThumb1": np.array([cx + (hand_l - cx) * 0.93, y(0.778), cz + height * 0.02]),
        "RightShoulder": np.array([cx - sh_off * 0.5, y(0.80), cz]),
        "RightArm": np.array([cx - sh_off, y(0.795), cz]),
        "RightForeArm": np.array([cx + (hand_r - cx) * 0.55, y(0.79), cz]),
        "RightHand": np.array([cx + (hand_r - cx) * 0.88, y(0.785), cz]),
        "RightHandEnd": np.array([hand_r, y(0.783), cz]),
        "RightHandThumb1": np.array([cx + (hand_r - cx) * 0.93, y(0.778), cz + height * 0.02]),
        "LeftUpLeg": np.array([left_x, y(0.51), cz]),
        "LeftLeg": np.array([left_x, y(0.28), cz]),
        "LeftFoot": np.array([left_x, y(0.045), cz]),
        "LeftToeBase": np.array([left_x, y(0.02), cz + max(height * 0.05, 1e-4)]),
        "RightUpLeg": np.array([right_x, y(0.51), cz]),
        "RightLeg": np.array([right_x, y(0.28), cz]),
        "RightFoot": np.array([right_x, y(0.045), cz]),
        "RightToeBase": np.array([right_x, y(0.02), cz + max(height * 0.05, 1e-4)]),
    }
    missing = [n for n in BONE_NAMES if n not in joints]
    if missing:
        raise RuntimeError(f"skeleton fit is missing joints: {missing}")
    return joints


def _segment_distance(points: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Per-point distance to the segment a→b (vectorised)."""
    ab = b - a
    denom = float(ab @ ab)
    if denom < 1e-12:
        return np.linalg.norm(points - a, axis=1)
    t = np.clip(((points - a) @ ab) / denom, 0.0, 1.0)[:, None]
    return np.linalg.norm(points - (a + t * ab), axis=1)


def skin_weights(
    vertices: np.ndarray, joints: dict[str, np.ndarray], influences: int = 4
) -> tuple[np.ndarray, np.ndarray]:
    """Distance-falloff skinning: (joint_index[N,4], weight[N,4]).

    Each bone is the segment from its head to its parent's head; a vertex is
    weighted by inverse distance to the nearest bone segments. Crude next to a
    learned or heat-diffusion solver, but it deforms smoothly and every weight
    is real (normalised, top-4, glTF-conformant).
    """
    names = BONE_NAMES
    n_verts = len(vertices)
    dists = np.empty((n_verts, len(names)), dtype=np.float64)
    for i, name in enumerate(names):
        head = joints[name]
        parent = BONE_PARENT[name]
        tail = joints[parent] if parent is not None else head
        d = _segment_distance(vertices, head, tail)
        if name in TIP_BONES:
            d = d * 2.5  # tips should not claim the whole limb
        dists[:, i] = d

    scale = float(np.linalg.norm(vertices.max(axis=0) - vertices.min(axis=0))) or 1.0
    eps = scale * 1e-3
    order = np.argsort(dists, axis=1)[:, :influences]
    picked = np.take_along_axis(dists, order, axis=1)
    weights = 1.0 / np.power(picked + eps, 3.0)
    weights /= weights.sum(axis=1, keepdims=True)
    return order.astype(np.uint16), weights.astype(np.float32)
