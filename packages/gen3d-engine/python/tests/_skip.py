"""The Skip exception, in its own module so there is exactly ONE of it.

run.py is executed as a script, so it is `__main__`. A test doing
`from run import Skip` imports run.py a SECOND time under the name `run`,
producing a different class object — and `except Skip` in the runner then does
not catch it. The test looked like it was failing for its own reasons.
"""

from __future__ import annotations


class Skip(Exception):
    """Raised by a test that cannot run HERE — not one that failed.

    The workers live in several provisioned venvs with different dependencies
    (trimesh is in meshtools/cube, not in the system interpreter `pnpm test`
    happens to use). Reporting "trimesh is not installed" as a failure trains
    people to ignore a red suite, which is worse than not running it.
    """
