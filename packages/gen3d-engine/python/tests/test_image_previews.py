"""The image worker's live-denoise preview path, with no model involved.

The watcher is a polling loop over a directory another process writes into, and
every interesting failure is a timing one that a real generation would surface
only as "the card never animated": a frame caught mid-write, a retry reusing the
same filenames, a step number parsed wrong. Those are cheap to provoke here by
writing the files ourselves, and expensive to provoke any other way — a real run
costs ~14 s of GPU and only produces the happy path.

Run: python tests/run.py   (from packages/gen3d-engine/python)
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

from _skip import Skip

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / "workers"))

try:
    from PIL import Image as PILImage
except ImportError as err:  # noqa: F841
    raise Skip("Pillow is not installed in this interpreter") from None

import mlx_image_worker as worker  # noqa: E402


def _write_png(path: Path, size: tuple[int, int] = (64, 48)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = PILImage.new("RGB", size)
    # Not a flat fill: a flat image JPEGs to a handful of bytes and would hide a
    # regression that dropped the pixels.
    for x in range(size[0]):
        for y in range(size[1]):
            img.putpixel((x, y), ((x * 7) % 256, (y * 11) % 256, ((x + y) * 3) % 256))
    img.save(path)


def _emitted(monkeyed: list) -> list[dict]:
    return [m for m in monkeyed if m.get("event") == "preview"]


class _Capture:
    """Swap the worker's stdout for a buffer and read back the NDJSON."""

    def __enter__(self) -> _Capture:
        self._real = sys.stdout
        self.buf = io.StringIO()
        sys.stdout = self.buf
        return self

    def __exit__(self, *_exc) -> None:
        sys.stdout = self._real

    @property
    def events(self) -> list[dict]:
        out = []
        for line in self.buf.getvalue().splitlines():
            if line.strip():
                out.append(json.loads(line))
        return out


def test_preview_frame_is_small_and_carries_full_res_dimensions(tmp=None) -> None:
    import tempfile

    d = Path(tempfile.mkdtemp())
    png = d / "seed_42_step2of4.png"
    # 1024x768 so the aspect ratio the UI grows into is NOT square, and the
    # thumbnail's own size can't be mistaken for it.
    _write_png(png, (1024, 768))
    with _Capture() as cap:
        assert worker._emit_preview(png, 2, 4) is True
    events = _emitted(cap.events)
    assert len(events) == 1, events
    ev = events[0]
    assert ev["step"] == 2 and ev["totalSteps"] == 4
    # FULL resolution, not the thumbnail's — the card is sized from this.
    assert ev["width"] == 1024 and ev["height"] == 768
    assert ev["dataUri"].startswith("data:image/jpeg;base64,")
    # The whole reason for downscaling: the full-res PNG of one step measured
    # 1.4-2.1 MB. Anything near that here means the resize stopped happening.
    assert len(ev["dataUri"]) < 60_000, len(ev["dataUri"])
    # And it must still be a real, decodable picture at the promised size.
    import base64

    raw = base64.b64decode(ev["dataUri"].split(",", 1)[1])
    thumb = PILImage.open(io.BytesIO(raw))
    assert max(thumb.size) <= worker.PREVIEW_MAX_PX, thumb.size


def test_half_written_frame_is_retried_not_reported() -> None:
    """mflux's write is not atomic; a truncated file must not become an error."""
    import tempfile

    d = Path(tempfile.mkdtemp())
    png = d / "seed_42_step1of4.png"
    _write_png(png)
    png.write_bytes(png.read_bytes()[:120])  # truncate mid-file
    with _Capture() as cap:
        assert worker._emit_preview(png, 1, 4) is False
    assert _emitted(cap.events) == []


def test_watcher_publishes_each_step_once_and_cleans_up() -> None:
    import tempfile

    root = Path(tempfile.mkdtemp())
    w = worker._PreviewWatcher(root / "attempt1")
    w.dir.mkdir(parents=True, exist_ok=True)
    for step in range(3):
        _write_png(w.dir / f"seed_42_step{step}of4.png")
    # mflux also writes a growing composite strip; it is not a frame.
    _write_png(w.dir / "seed_42_composite.png")
    with _Capture() as cap:
        w._sweep()
        w._sweep()  # a second pass must publish nothing new
    events = _emitted(cap.events)
    assert [e["step"] for e in events] == [0, 1, 2], events
    # Published frames are dropped so the temp dir cannot hold five 2 MB PNGs.
    assert sorted(p.name for p in w.dir.glob("*.png")) == ["seed_42_composite.png"]


def test_a_retry_gets_its_own_directory_so_its_frames_are_not_skipped() -> None:
    """The blank-render retry reuses the seed, so it reuses mflux's filenames.

    Sharing one watch directory would make every frame of the retry look like
    one already seen, and the card would sit on the failed attempt's noise for
    the whole second run.
    """
    import tempfile

    root = Path(tempfile.mkdtemp())
    first = worker._PreviewWatcher(root / "attempt1")
    second = worker._PreviewWatcher(root / "attempt2")
    for w in (first, second):
        w.dir.mkdir(parents=True, exist_ok=True)
        _write_png(w.dir / "seed_42_step0of4.png")
    with _Capture() as cap:
        first._sweep()
        second._sweep()
    assert [e["step"] for e in _emitted(cap.events)] == [0, 0]


def test_step_filename_parsing_ignores_everything_else() -> None:
    assert worker._STEP_RE.search("seed_42_step12of30.png").groups() == ("12", "30")
    assert worker._STEP_RE.search("seed_42_composite.png") is None
    assert worker._STEP_RE.search("prompt-image.png") is None
