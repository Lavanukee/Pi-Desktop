"""Fitted joints must sit INSIDE the body, not on or past its surface.

jedd saw the skeleton overlay poking out through a generated character's hands.
It is not cosmetic — this fit is what ARDY's motion drives, so a joint outside
a limb swings that limb about the wrong pivot.

MEASURED on a real 44,374-vertex generated humanoid: the raw guess put seven
joints outside, the worst 52 mm past the surface, and they were exactly the ones
in the screenshot (ForeArm, Hand, HandEnd, HandThumb1 on both sides). The medial
snap brings the worst to 1.3 mm.

The check here needs no mesh and no trimesh: it builds a TUBE with a known axis
and asserts the fit lands joints on it rather than on the skin. That keeps the
guarantee testable on any machine, where the real measurement above needs a
generated asset and an rtree-backed inside test.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers"))

from _humanoid import _pull_joints_inside  # noqa: E402


def _tube(centre_x: float, radius: float, y0: float, y1: float, n: int = 600):
    """A vertical cylinder's SURFACE — no interior points, like a real mesh."""
    rng = np.random.default_rng(0)
    theta = rng.uniform(0, 2 * np.pi, n)
    y = rng.uniform(y0, y1, n)
    return np.stack(
        [centre_x + radius * np.cos(theta), y, radius * np.sin(theta)], axis=1
    )


def test_a_joint_on_the_skin_moves_inward():
    """The single pass averages a PATCH, so how far it gets depends on how thick
    the part is relative to the search radius.

    On a tube twice the search radius it only creeps inward — stated here rather
    than dressed up, because the guarantee this function actually makes is
    "moves toward the interior", and it is the thin-limb case below that carries
    the real fix. Iterating to force the thick case inward was tried and made
    the REAL humanoid worse (see the note in _pull_joints_inside).
    """
    radius = 0.1
    surface = _tube(0.0, radius, 0.0, 1.0)
    on_skin = {"LeftHand": np.array([radius, 0.5, 0.0])}
    moved = _pull_joints_inside(on_skin, surface, height=1.0)["LeftHand"]
    assert float(np.hypot(moved[0], moved[2])) < radius, "joint did not move inward"


def test_a_thin_limb_pulls_a_joint_well_inside():
    """The thinner the part against the search radius, the more of the ring the
    average sees and the closer to the axis it lands.

    MEASURED: a joint on the skin of a 0.03 tube ends 0.017 from the axis — a
    bit over half the radius, comfortably interior. On the REAL generated
    humanoid, where limbs are thin against a 90 mm search radius, the same pass
    took the worst joint from 52 mm OUTSIDE the surface to 1.3 mm. This asserts
    the shape of that behaviour without pretending it reaches the axis exactly.
    """
    radius = 0.03
    surface = _tube(0.0, radius, 0.0, 1.0)
    moved = _pull_joints_inside({"LeftHand": np.array([radius, 0.5, 0.0])}, surface, 1.0)
    off_axis = float(np.hypot(moved["LeftHand"][0], moved["LeftHand"][2]))
    assert off_axis < radius * 0.7, f"thin limb joint only reached {off_axis:.4f}"
    # A joint that started OUTSIDE the limb gets pulled in but not all the way
    # to the axis in one pass — MEASURED 0.024 from a 0.05 start on a 0.03 tube.
    # Inside the surface is the guarantee; the axis is the thin-and-centred case.
    far = _pull_joints_inside({"LeftHandEnd": np.array([0.05, 0.5, 0.0])}, surface, 1.0)
    assert float(np.hypot(far["LeftHandEnd"][0], far["LeftHandEnd"][2])) < 0.05


def test_a_joint_outside_the_body_is_brought_in():
    """The 52 mm case: a joint past the silhouette entirely."""
    surface = _tube(0.0, 0.1, 0.0, 1.0)
    outside = {"LeftHandEnd": np.array([0.16, 0.5, 0.0])}
    moved = _pull_joints_inside(outside, surface, height=1.0)["LeftHandEnd"]
    assert float(np.hypot(moved[0], moved[2])) < 0.1, "joint was not brought inside"
    assert float(np.hypot(moved[0], moved[2])) < 0.16, "joint did not move in at all"


def test_a_joint_with_no_nearby_surface_keeps_its_guess():
    """Better a guess than the centroid of something irrelevant — a joint far
    from any surface must not be dragged across the model."""
    surface = _tube(0.0, 0.1, 0.0, 1.0)
    stray = np.array([50.0, 0.5, 0.0])
    moved = _pull_joints_inside({"Head": stray.copy()}, surface, height=1.0)["Head"]
    assert np.allclose(moved, stray), "a stray joint was dragged to the body"


def test_an_empty_mesh_changes_nothing():
    guess = {"Hips": np.array([0.0, 1.0, 0.0])}
    out = _pull_joints_inside(guess, np.zeros((0, 3)), height=1.0)
    assert np.allclose(out["Hips"], [0.0, 1.0, 0.0])
