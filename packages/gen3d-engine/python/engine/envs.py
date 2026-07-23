"""Per-model runtime provisioning: tool clones (pinned), uv venvs, the
AutoRemesher release binary, and the gated-mirror pipeline.json patch.

Everything is idempotent — re-running after a partial failure resumes.
"""

from __future__ import annotations

import json
import os
import plistlib
import subprocess
import threading
import urllib.request
from pathlib import Path

from .registry import Registry


def _run(cmd: list[str], cwd: Path | None, log, env: dict | None = None) -> None:
    log("$ " + " ".join(cmd))
    merged = dict(os.environ)
    if env:
        merged.update(env)
    result = subprocess.run(
        cmd, cwd=str(cwd) if cwd else None, env=merged, capture_output=True, text=True
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise RuntimeError(f"{cmd[0]} failed ({result.returncode}): {tail}")


def _uv_env(registry: Registry) -> dict:
    """PATH with uv's directory in front (setup scripts probe `command -v uv`)."""
    uv_dir = str(Path(registry.uv_path).parent)
    return {"PATH": uv_dir + os.pathsep + os.environ.get("PATH", "")}


def provision(registry: Registry, model: dict, log, cancelled: threading.Event) -> None:
    env_kind = model["env"]
    if env_kind == "trellis":
        _provision_trellis(registry, log)
    elif env_kind == "mageflow":
        _provision_mageflow(registry, log)
    elif env_kind == "cubepart":
        _provision_cubepart(registry, log)
    elif env_kind == "paint":
        _provision_paint(registry, log)
    elif env_kind == "binary":
        _provision_autoremesher(registry, model, log)
    else:
        raise RuntimeError(f"unknown env kind: {env_kind}")


def _metal_env() -> dict:
    """The Metal wheel builds need Apple's `metal` compiler. Command Line
    Tools alone lack it; if a full Xcode is present, point DEVELOPER_DIR at it
    for the build only (no system-level xcode-select change). Verified on this
    machine: CLT-active + Xcode 26.6 in /Applications — DEVELOPER_DIR is what
    makes mtlbvh/mtldiffrast/mtlmesh/mtlgemm compile."""
    xcode = Path("/Applications/Xcode.app/Contents/Developer")
    if xcode.exists():
        probe = subprocess.run(["xcrun", "-f", "metal"], capture_output=True)
        if probe.returncode != 0:
            return {"DEVELOPER_DIR": str(xcode)}
    return {}


def _provision_trellis(registry: Registry, log) -> None:
    tool = registry.ensure_tool_clone("trellis-mac", log)
    if not registry.venv_python("trellis-mac").exists():
        log("Running trellis-mac setup.sh (venv + Metal backends + MPS patches)…")
        env = _uv_env(registry)
        env["HF_HOME"] = str(registry.hf_home)
        env.update(_metal_env())
        # MACOSX_DEPLOYMENT_TARGET is set inside setup.sh; SKIP nothing — the
        # Metal texture baker is the quality path on this hardware.
        _run(["bash", "setup.sh"], tool, log, env)
        # transformers 5.14's conversion-mapping pass breaks the remote-code
        # rembg model ('Config' has no attribute 'model_type'); 4.57.1 has
        # DINOv3ViT and predates the regression. einops is required by the
        # ZhengPeng7/BiRefNet remote code. Both verified on this machine.
        py = str(registry.venv_python("trellis-mac"))
        _run(
            [registry.uv_path, "pip", "install", "--python", py, "transformers==4.57.1", "einops"],
            tool,
            log,
        )
    patch_gated_mirrors(registry, log)


def patch_gated_mirrors(registry: Registry, log) -> None:
    """When no HF token exists, point the cached TRELLIS pipeline configs at
    the byte-identical public mirrors (camenduru dinov3 / 1038lab RMBG-2.0).

    The snapshot files are symlinks into blobs/ — we replace the SYMLINK with a
    patched regular file so the shared blob store stays pristine.
    """
    try:
        from huggingface_hub import get_token

        if get_token():
            log("HF token present — keeping official gated repos")
            return
    except ImportError:
        pass
    mirrors: dict = registry.spec.get("gatedMirrors") or {}
    if not mirrors:
        return
    repo_dir = registry.hf_home / "hub" / "models--microsoft--TRELLIS.2-4B" / "snapshots"
    if not repo_dir.is_dir():
        return
    for snapshot in repo_dir.iterdir():
        for name in ("pipeline.json", "texturing_pipeline.json"):
            cfg = snapshot / name
            if not cfg.exists():
                continue
            text = cfg.read_text()
            patched = text
            for official, mirror in mirrors.items():
                patched = patched.replace(official, mirror)
            if patched != text:
                cfg.unlink()
                cfg.write_text(patched)
                log(f"patched {name} → public mirrors (no HF token)")


def _provision_mageflow(registry: Registry, log) -> None:
    tool = registry.ensure_tool_clone("Mage", log)
    mage_flow = tool / "mage_flow"
    if not registry.venv_python("Mage").exists():
        uv = registry.uv_path
        log("Creating Mage-Flow venv (torch 2.13 + transformers 5.5, no flash-attn on MPS)…")
        _run([uv, "venv", str(tool / ".venv"), "--python", "3.11"], tool, log)
        py = str(registry.venv_python("Mage"))
        _run([uv, "pip", "install", "--python", py, "-r", str(mage_flow / "requirements.txt")], tool, log)
        _run([uv, "pip", "install", "--python", py, "-e", str(mage_flow), "--no-deps"], tool, log)


def _provision_cubepart(registry: Registry, log) -> None:
    tool = registry.ensure_tool_clone("cube", log)
    cubepart = tool / "cubepart"
    if not registry.venv_python("cube").exists():
        uv = registry.uv_path
        log("Creating CubePart venv…")
        _run([uv, "venv", str(tool / ".venv"), "--python", "3.11"], tool, log)
        py = str(registry.venv_python("cube"))
        _run([uv, "pip", "install", "--python", py, "-e", str(cubepart)], tool, log)


def _provision_paint(registry: Registry, log) -> None:
    tool = registry.ensure_tool_clone("Hunyuan3D-2.1-mac", log)
    if not registry.venv_python("Hunyuan3D-2.1-mac").exists():
        uv = registry.uv_path
        log("Creating Hunyuan Paint venv (macOS requirements)…")
        _run([uv, "venv", str(tool / ".venv"), "--python", "3.11"], tool, log)
        py = str(registry.venv_python("Hunyuan3D-2.1-mac"))
        reqs = tool / "requirements-macos.txt"
        if not reqs.exists():
            reqs = tool / "requirements.txt"
        _run([uv, "pip", "install", "--python", py, "-r", str(reqs)], tool, log)


def _provision_autoremesher(registry: Registry, model: dict, log) -> None:
    cli = registry.autoremesher_cli()
    spec = registry.spec["autoremesher"]
    if not cli.exists():
        dmg = registry.bin_dir / "autoremesher.dmg"
        if not dmg.exists() or dmg.stat().st_size != int(spec["dmgBytes"]):
            log(f"Downloading AutoRemesher 1.0.0 ({spec['dmgUrl']})…")
            urllib.request.urlretrieve(spec["dmgUrl"], dmg)
        log("Mounting dmg + installing autoremesher.app…")
        attach = subprocess.run(
            ["hdiutil", "attach", "-nobrowse", "-plist", str(dmg)],
            capture_output=True,
            check=True,
        )
        mount_point = None
        for entity in plistlib.loads(attach.stdout).get("system-entities", []):
            if entity.get("mount-point"):
                mount_point = entity["mount-point"]
        if mount_point is None:
            raise RuntimeError("hdiutil attach produced no mount point")
        try:
            _run(
                ["cp", "-R", str(Path(mount_point) / "autoremesher.app"), str(registry.bin_dir)],
                None,
                log,
            )
        finally:
            subprocess.run(["hdiutil", "detach", mount_point, "-quiet"], capture_output=True)
        subprocess.run(
            ["xattr", "-dr", "com.apple.quarantine", str(registry.bin_dir / "autoremesher.app")],
            capture_output=True,
        )
        dmg.unlink(missing_ok=True)
    # Tiny mesh-conversion venv (GLB<->OBJ for the retopo worker).
    if not registry.meshtools_python().exists():
        uv = registry.uv_path
        meshtools = registry.tool_dir("meshtools")
        meshtools.mkdir(parents=True, exist_ok=True)
        log("Creating meshtools venv (trimesh)…")
        _run([uv, "venv", str(meshtools / ".venv"), "--python", "3.12"], meshtools, log)
        _run(
            [
                registry.uv_path,
                "pip",
                "install",
                "--python",
                str(registry.meshtools_python()),
                "trimesh==4.5.3",
                "numpy",
                "pillow",
            ],
            meshtools,
            log,
        )


def write_registry_note(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2))
