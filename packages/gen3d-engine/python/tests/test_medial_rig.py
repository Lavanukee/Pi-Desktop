"""The medial-axis rigger must derive the skeleton the SHAPE has.

jedd asked for this as the first choice for anything that is not humanoid, so
that a creature gets a real rig without the 2.5 GB SkinTokens download. The
things that can quietly go wrong are structural, and none of them show up in a
joint count:

  - the branches are the limbs, or they are not (a quadruped that rigs as a
    single spine is useless, and that is exactly what the first version did:
    the pruner absorbed a joint whose other stubs had already gone and orphaned
    the live limb hanging off it);
  - the ROOT is the body, not a fingertip. The extraction starts at an extremity
    by construction, so a rig left rooted there animates from the wrong end;
  - the skin follows the nearest BONE and no other, or two limbs drag each other.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

WORKERS = Path(__file__).resolve().parents[1] / "workers"


def _needs(*modules: str):
    for name in modules:
        try:
            __import__(name)
        except ModuleNotFoundError as err:
            from _skip import Skip

            raise Skip(f"needs {name} — run from the meshtools venv") from err


def _limb(trimesh, a, b, radius):
    """A capsule spanning a to b. `creation.capsule` is CENTRED on the origin."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    direction = b - a
    length = float(np.linalg.norm(direction))
    cap = trimesh.creation.capsule(height=length, radius=radius)
    cap.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], direction / length))
    cap.apply_translation((a + b) / 2)
    return cap


def _quadruped(trimesh):
    """A trunk with four legs, a neck+head and a tail: six branches, no symmetry
    a humanoid template could exploit."""
    parts = [trimesh.creation.box(extents=(1.2, 0.42, 0.42))]
    for x in (-0.42, 0.42):
        for z in (-0.13, 0.13):
            parts.append(_limb(trimesh, (x, 0.0, z), (x, -0.72, z), 0.07))
    parts.append(_limb(trimesh, (0.5, 0.05, 0), (0.85, 0.3, 0), 0.1))
    head = trimesh.creation.icosphere(subdivisions=2, radius=0.2)
    head.apply_translation((0.9, 0.34, 0))
    parts.append(head)
    parts.append(_limb(trimesh, (-0.5, 0.05, 0), (-1.0, 0.22, 0), 0.045))
    return trimesh.util.concatenate(parts)


def _skeleton_of(mesh):
    sys.path.insert(0, str(WORKERS))
    from _medial import extract

    return extract(mesh)


def test_a_quadruped_gets_a_branch_per_limb() -> None:
    _needs("trimesh", "scipy")
    import trimesh

    mesh = _quadruped(trimesh)
    sk = _skeleton_of(mesh)

    kids: dict[str, list[str]] = {n: [] for n in sk.names}
    for n in sk.names:
        if sk.parent[n] is not None:
            kids[sk.parent[n]].append(n)
    leaves = [n for n in sk.names if not kids[n]]
    # Four legs, a head and a tail. Fewer means limbs were lost; a lot more
    # means the pruner is leaving noise stubs that cost real influence slots.
    assert 6 <= len(leaves) <= 9, f"{len(leaves)} branch tips: {leaves}"

    # Four of them must be DOWN in leg territory, and one at each end.
    tips = np.stack([sk.position[n] for n in leaves])
    assert int((tips[:, 1] < -0.3).sum()) == 4, f"legs: {tips[:, 1].round(2).tolist()}"
    assert tips[:, 0].max() > 0.6, "no head"
    assert tips[:, 0].min() < -0.6, "no tail"


def test_the_root_is_the_body_not_an_extremity() -> None:
    """The sweep this is built on STARTS at an extremity, so an unrooted result
    hangs the whole animal off a toe."""
    _needs("trimesh", "scipy")
    import trimesh

    mesh = _quadruped(trimesh)
    sk = _skeleton_of(mesh)
    root = sk.position[sk.root]
    centre = mesh.bounds.mean(axis=0)
    extent = float(max(mesh.extents))
    assert float(np.linalg.norm(root - centre)) < extent * 0.25, (
        f"root {root.round(2).tolist()} is not near the body centre {centre.round(2).tolist()}"
    )
    # And it must be a single, real root.
    assert sum(1 for n in sk.names if sk.parent[n] is None) == 1


def test_every_joint_has_a_parent_that_still_exists() -> None:
    """The pruner used to absorb a joint whose OTHER stubs had already been
    pruned, leaving a live limb hanging off a name that no longer existed. On a
    real generated mesh that was a KeyError; on a simpler one it would have been
    a silently broken hierarchy."""
    _needs("trimesh", "scipy")
    import trimesh

    for mesh in (_quadruped(trimesh), trimesh.creation.icosphere(subdivisions=3, radius=0.5)):
        sk = _skeleton_of(mesh)
        names = set(sk.names)
        for n in sk.names:
            p = sk.parent[n]
            assert p is None or p in names, f"{n} hangs off missing joint {p}"
            assert n in sk.position and n in sk.radius


def test_skin_weights_stay_on_the_nearest_bone() -> None:
    """Where two limbs run alongside each other, a gentle falloff bleeds each
    limb's surface onto the other's bone and the two move together."""
    _needs("trimesh", "scipy")
    import trimesh

    sys.path.insert(0, str(WORKERS))
    from _medial import skin

    mesh = _quadruped(trimesh)
    sk = _skeleton_of(mesh)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    index, weight = skin(vertices, sk)

    assert index.shape == (len(vertices), 4)
    assert np.allclose(weight.sum(axis=1), 1.0, atol=1e-5), "weights must sum to 1 per vertex"
    assert weight.min() >= 0.0
    assert index.max() < len(sk.names)

    extent = float(max(mesh.extents))
    for parent, child in sk.bones():
        slot = sk.names.index(child)
        w = np.where(index == slot, weight, 0.0).sum(axis=1)
        a, b = sk.position[parent], sk.position[child]
        ab = b - a
        t = np.clip(((vertices - a) @ ab) / max(float(ab @ ab), 1e-12), 0.0, 1.0)
        distance = np.linalg.norm(vertices - (a + t[:, None] * ab), axis=1)
        far = distance > extent * 0.25
        if far.any():
            assert float(w[far].max()) < 1e-6, (
                f"bone {child} moves vertices a quarter of the model away"
            )
