"""The cleanup guard: what may replace a transcript, and what may not.

These run without the model. That is deliberate — the guard is the part that
decides whether a user sees words they never said, so it has to be verifiable
on a machine that has not downloaded 3.58 GB, and the thresholds have to be
tunable against real examples rather than vibes.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers"))

from _asr_cleanup import is_safe  # noqa: E402


def test_accepts_the_corrections_this_exists_for():
    """The MEASURED failures from the dictation probe: jargon and a homophone."""
    raw = (
        "Um so I was thinking we should probably uh refactor the Retapa worker "
        "because the voxel thing returns grid coordinates, and that's why it was "
        "384 times too big. Can you also check weather cube part is still using MLX?"
    )
    fixed = raw.replace("Retapa", "retopo").replace("weather cube part", "whether CubePart")
    ok, why = is_safe(raw, fixed)
    assert ok, f"the whole point was rejected: {why}"


def test_rejects_an_answer_to_the_transcript():
    """A model that answers the question instead of correcting it."""
    raw = "Can you also check whether cube part is still using MLX?"
    ok, _ = is_safe(raw, "Yes, CubePart still uses MLX for its diffusion transformer.")
    assert not ok


def test_rejects_a_summary():
    raw = (
        "Um so I was thinking we should probably uh refactor the retopo worker "
        "because the voxel thing returns grid coordinates and that is why it was "
        "384 times too big"
    )
    ok, _ = is_safe(raw, "The user wants to refactor the retopo worker.")
    assert not ok


def test_rejects_a_continuation():
    """Length drift catches the model carrying on past the transcript."""
    raw = "Can you check whether CubePart is still using MLX?"
    ok, _ = is_safe(raw, f"{raw} I think it is, but you should verify by reading the worker source.")
    assert not ok


def test_rejects_a_preamble_even_when_the_text_survives():
    raw = "refactor the retopo worker because the voxel thing returns grid coordinates"
    ok, why = is_safe(raw, f"Here is the corrected transcript: {raw}")
    assert not ok, why


def test_rejects_empty_and_keeps_identity():
    assert not is_safe("some words here", "")[0]
    assert is_safe("some words here", "some words here")[0]


def test_punctuation_only_changes_are_still_accepted():
    """Not what it is FOR, but a model that also fixes a comma has not lied."""
    raw = "so I was thinking we should refactor the retopo worker"
    ok, _ = is_safe(raw, "So, I was thinking we should refactor the retopo worker.")
    assert ok


def test_a_wholesale_replacement_is_rejected():
    raw = "the voxel thing returns grid coordinates and that is why it was 384 times too big"
    ok, _ = is_safe(raw, "the mesh data uses world space so the scale factor was already correct")
    assert not ok
