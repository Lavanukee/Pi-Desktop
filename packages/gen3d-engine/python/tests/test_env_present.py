"""Every env in the catalog must be answerable by env_present.

THE CLASS OF BUG, not just its instance. `ardy` was added to the catalog and
never to `env_present`, whose final `return False` swallowed it — so ardy-motion
reported "isn't downloaded yet" with the model complete on disk, and no amount
of pressing the download button could ever have changed that. `audio` had the
same hole. A missing case must fail loudly here rather than silently in a panel.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))

from engine.registry import Registry  # noqa: E402


def _catalog_envs() -> set[str]:
    """The envs the SHIPPED catalog actually uses (registry.json is written from
    catalog.ts, so this tracks the real product rather than a copy)."""
    path = Path.home() / ".cache" / "pi-desktop" / "gen3d" / "registry.json"
    if not path.exists():
        return set()
    return {m["env"] for m in json.loads(path.read_text())["models"]}


def test_env_present_covers_every_env():
    envs = _catalog_envs()
    if not envs:
        return  # no catalog on this machine; nothing to check
    r = Registry.__new__(Registry)
    # Every path answers False — the point is that none of them RAISES.
    for name in (
        "venv_python",
        "meshtools_python",
        "autoremesher_cli",
        "has_skintokens",
    ):
        setattr(r, name, MagicMock(return_value=MagicMock(exists=lambda: False)))
    r.has_skintokens = MagicMock(return_value=False)
    r.model = lambda model_id: {"env": model_id}

    missing = []
    for env in sorted(envs):
        try:
            r.env_present(env)
        except ValueError:
            missing.append(env)
    assert not missing, (
        f"env_present has no case for {missing} — any model using those envs "
        "reports 'not downloaded' forever, whatever the user does"
    )
