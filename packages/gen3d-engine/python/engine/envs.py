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
    elif env_kind == "meshtools":
        _provision_meshtools(registry, log)
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
        # cubepart's loose `diffusers>=0.30` resolves to 0.39+, whose
        # QwenEmbedRope.forward reordered args and breaks the QwenImage hijack
        # ("got multiple values for argument 'device'" — reproduced here).
        # 0.38.0 matches the hijack's calling convention.
        _run([uv, "pip", "install", "--python", py, "diffusers==0.38.0"], tool, log)


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
        # Not in the fork's macOS requirements but imported by its texture
        # pipeline (verified missing here): mesh processing + UV unwrap.
        _run([uv, "pip", "install", "--python", py, "pymeshlab", "xatlas"], tool, log)
    # RealESRGAN upsampler checkpoint (the fork's install-macos.sh does the
    # same curl from the official Real-ESRGAN release).
    esrgan = tool / "hy3dpaint" / "ckpt" / "RealESRGAN_x4plus.pth"
    if not esrgan.exists():
        esrgan.parent.mkdir(parents=True, exist_ok=True)
        log("Downloading RealESRGAN_x4plus.pth (67 MB)…")
        urllib.request.urlretrieve(
            "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
            esrgan,
        )


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
    make_autoremesher_headless(registry, log)
    _provision_meshtools(registry, log)


def make_autoremesher_headless(registry: Registry, log) -> None:
    """Stop AutoRemesher from bouncing into the Dock on every retopo.

    AutoRemesher is a Qt app that also accepts `--input/--output`; even on the
    headless path it constructs a QApplication. Its qmake-generated Info.plist
    declares `NSPrincipalClass=NSApplication` with `CFBundlePackageType=APPL`
    and no LSUIElement, so LaunchServices registers each run as a FOREGROUND
    application — verified with `lsappinfo info <pid>` reporting
    type="Foreground" during a real retopo.

    LSUIElement=true is the documented "agent" opt-out: same Cocoa platform
    plugin, no Dock tile and no menu bar. Editing Info.plist breaks the bundle
    seal, so we re-sign ad-hoc afterwards. Idempotent — it also repairs an
    install made before this fix existed.
    """
    app_dir = registry.bin_dir / "autoremesher.app"
    plist_path = app_dir / "Contents" / "Info.plist"
    if not plist_path.exists():
        return
    try:
        info = plistlib.loads(plist_path.read_bytes())
    except Exception as err:  # noqa: BLE001 — never block a retopo on this
        log(f"could not read autoremesher Info.plist: {err}")
        return
    if info.get("LSUIElement") is True:
        return
    info["LSUIElement"] = True
    plist_path.write_bytes(plistlib.dumps(info))
    # Re-seal: the signature covers Info.plist. An ad-hoc signature is enough —
    # the bundle is already de-quarantined, so Gatekeeper does not evaluate it.
    subprocess.run(
        ["codesign", "--force", "--sign", "-", str(app_dir)], capture_output=True
    )
    log("Patched autoremesher.app → LSUIElement (no Dock tile)")


# trimesh's repair paths (fill_holes, fix_winding, connected-component split)
# are graph-backed: without networkx they RAISE, the retopo input reaches
# AutoRemesher unhealed, and the remesh comes back full of holes. scipy backs
# the spatial queries those repairs use. Both are load-bearing, not optional.
MESHTOOLS_PACKAGES = [
    "trimesh==4.5.3",
    "numpy",
    "pillow",
    "networkx",
    "scipy",
    # Quadric decimation — the retopo stage caps input density before handing
    # the mesh to AutoRemesher (see _meshprep.decimate_to for the measurement).
    "fast-simplification",
]
MESHTOOLS_IMPORTS = ["trimesh", "numpy", "PIL", "networkx", "scipy", "fast_simplification"]


def _provision_meshtools(registry: Registry, log) -> None:
    """Tiny mesh-prep venv (weld/heal + GLB↔OBJ) for the retopo worker.

    Repairs an EXISTING venv too — an install from before networkx was required
    would otherwise silently keep producing holed retopology.
    """
    uv = registry.uv_path
    meshtools = registry.tool_dir("meshtools")
    python = registry.meshtools_python()
    if not python.exists():
        meshtools.mkdir(parents=True, exist_ok=True)
        log("Creating meshtools venv (trimesh)…")
        _run([uv, "venv", str(meshtools / ".venv"), "--python", "3.12"], meshtools, log)
    probe = subprocess.run(
        [str(python), "-c", "import " + ", ".join(MESHTOOLS_IMPORTS)],
        capture_output=True,
        text=True,
    )
    if probe.returncode == 0:
        return
    log("Installing meshtools dependencies (trimesh + repair stack)…")
    _run([uv, "pip", "install", "--python", str(python), *MESHTOOLS_PACKAGES], meshtools, log)


def write_registry_note(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2))
