"""Run the Python-side engine tests.

The repo's suite is vitest, which cannot see into these workers at all — a
Python scope error passes 767 TS tests and then fails a real generation. This
is a plain runner (no pytest in the provisioned venvs) so it works with any
interpreter that can import the engine.

    python tests/run.py
"""

from __future__ import annotations

import importlib
import sys
import traceback
from pathlib import Path

from _skip import Skip

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))


def main() -> int:
    failed = 0
    skipped = 0
    total = 0
    for path in sorted(HERE.glob("test_*.py")):
        mod = importlib.import_module(path.stem)
        for name in sorted(n for n in dir(mod) if n.startswith("test_")):
            total += 1
            try:
                getattr(mod, name)()
                print(f"  PASS {path.stem}::{name}")
            except Skip as why:
                skipped += 1
                print(f"  SKIP {path.stem}::{name} — {why}")
            except Exception:  # noqa: BLE001 — a runner reports, it does not judge
                failed += 1
                print(f"  FAIL {path.stem}::{name}")
                traceback.print_exc()
    tail = f", {skipped} skipped" if skipped else ""
    print(f"\n{total - failed - skipped}/{total - skipped} passed{tail}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
