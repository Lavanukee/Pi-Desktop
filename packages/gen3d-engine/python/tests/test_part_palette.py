"""The segment palette is UI, so the no-purple brief applies to it.

CubePart bakes its part colours into the exported GLB's face colours, which is
what the user then looks at in the viewport. That makes the palette part of the
interface — but it is invisible to every UI check we have, because those walk
the DOM and this colour lives in vertex data. A full parity audit that scanned
every element's colour/background/border/fill/stroke across three flavors x
light/dark reported ZERO purple hits while the studio was, in fact, painting
one part of every default segmentation #9b59b6 (hue 283deg).

DEFAULT_PARTS is five entries long and the offending colour was index 4, so it
was the default path, not a corner.

Run: python tests/run.py   (from packages/gen3d-engine/python)
"""

from __future__ import annotations

import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / "workers"))

# Importing the worker module executes its tqdm patch, which is harmless, but it
# also imports torch/trimesh at module scope in the provisioned venv. Read the
# literals out of the source instead so this test runs on a bare interpreter.
_SRC = (ENGINE / "workers" / "cubepart_worker.py").read_text(encoding="utf-8")


def _palette() -> list[tuple[int, int, int]]:
    """PART_PALETTE's RGB triples, parsed from the worker source."""
    start = _SRC.index("PART_PALETTE = [")
    end = _SRC.index("]", start)
    body = _SRC[start:end]
    out: list[tuple[int, int, int]] = []
    for line in body.splitlines():
        head = line.split("#")[0].strip().strip(",")
        if not head.startswith("("):
            continue
        parts = [int(p.strip()) for p in head.strip("()").split(",") if p.strip()]
        if len(parts) == 3:
            out.append((parts[0], parts[1], parts[2]))
    return out


def _default_part_count() -> int:
    start = _SRC.index("DEFAULT_PARTS = [")
    end = _SRC.index("]", start)
    return _SRC[start:end].count('"') // 2


def _hue(rgb: tuple[int, int, int]) -> float | None:
    r, g, b = rgb
    mx, mn = max(r, g, b), min(r, g, b)
    if mx == mn:
        return None
    if mx == r:
        h = ((g - b) / (mx - mn)) % 6
    elif mx == g:
        h = (b - r) / (mx - mn) + 2
    else:
        h = (r - g) / (mx - mn) + 4
    return (h * 60) % 360


def test_no_purple_parts() -> None:
    """No part colour lands in the purple band (jedd's standing brief)."""
    offenders = []
    for i, rgb in enumerate(_palette()):
        h = _hue(rgb)
        if h is not None and 255 <= h <= 320:
            offenders.append(f"part {i} = rgb{rgb} (hue {h:.0f}deg)")
    assert not offenders, "purple part colours: " + "; ".join(offenders)


def test_palette_covers_the_default_parts() -> None:
    """Every default part has its own colour — no wrap-around repeats."""
    palette = _palette()
    parts = _default_part_count()
    assert parts > 0, "could not parse DEFAULT_PARTS"
    assert len(palette) >= parts, f"palette has {len(palette)} colours for {parts} default parts"


def test_palette_matches_the_panel_legend() -> None:
    """tripo.css's .tp-part-swatch rules ARE the legend for these colours.

    They drifted into a different palette entirely once already, which made the
    Parts list describe the model wrongly, so the two are pinned together here.
    """
    css = (
        ENGINE.parents[2]
        / "apps"
        / "desktop"
        / "src"
        / "tripo"
        / "tripo.css"
    ).read_text(encoding="utf-8")
    for i, rgb in enumerate(_palette()):
        hexed = "#{:02x}{:02x}{:02x}".format(*rgb)
        marker = f'.tp-part-swatch[data-part="{i}"]'
        assert marker in css, f"no swatch rule for part {i}"
        block = css[css.index(marker) : css.index(marker) + 120]
        assert hexed in block, f"swatch {i} is not {hexed} (worker) — legend disagrees with mesh"
