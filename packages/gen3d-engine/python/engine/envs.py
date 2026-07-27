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
import shutil
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
    elif env_kind == "skintokens":
        _provision_skintokens(registry, log)
    elif env_kind == "binary":
        _provision_autoremesher(registry, model, log)
    elif env_kind == "meshtools":
        _provision_meshtools(registry, log)
    elif env_kind == "audio":
        _provision_audio(registry, log)
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


# A .pth line beginning with "import" is EXECUTED at interpreter startup, which
# is the only hook early enough here: SkinTokens' autocast decorators bind when
# src.model is imported, and its bpy subprocess imports the same modules
# independently, so a flag parsed inside a worker would already be too late.
_SKINTOKENS_PTH = (
    "import os, sys; "
    "_r = os.path.abspath(os.path.join(sys.prefix, os.pardir)); "
    "sys.path.insert(0, _r); "
    '__import__("apple_compat")\n'
)


def _provision_skintokens(registry: Registry, log) -> None:
    """Clone SkinTokens, build its venv, and install the Apple Silicon shims.

    Upstream states "An NVIDIA GPU with at least 14 GB of memory is required"
    and installs flash-attn. None of that is load-bearing for inference: the
    CUDA dependency is in HOW attention is computed and in a capability probe,
    not in the maths. The shims live in python/shims/skintokens/ as real
    reviewable files and are COPIED in — never patched over the checkout — so
    the clone stays a clean `git clone` at a pinned commit.

    MEASURED once they are in place: a rig in 76s at fp32 on MPS, against 1103s
    on CPU. fp32 is not an optimisation but a correctness requirement — see the
    shims' README.
    """
    tool = registry.ensure_tool_clone("SkinTokens", log)
    py = registry.skintokens_python()
    if not py.exists():
        uv = registry.uv_path
        log("Creating the SkinTokens venv…")
        _run([uv, "venv", str(tool / ".venv"), "--python", "3.11"], tool, log)
        _run([uv, "pip", "install", "--python", str(py), "torch", "torchvision"], tool, log)
        _run(
            [uv, "pip", "install", "--python", str(py), "-r", str(tool / "requirements.txt")],
            tool,
            log,
        )

    # Rewritten on every provision, so a checkout pulled forward can never end
    # up running against stale shims.
    log("Installing the Apple Silicon shims…")
    shims = Path(__file__).resolve().parent.parent / "shims" / "skintokens"
    for name in ("flash_attn_interface.py", "apple_compat.py"):
        shutil.copyfile(shims / name, tool / name)
    site = next((tool / ".venv" / "lib").glob("python*/site-packages"), None)
    if site is None:
        raise RuntimeError("the SkinTokens venv has no site-packages")
    (site / "skintokens_apple_compat.pth").write_text(_SKINTOKENS_PTH)

    ckpt = (
        tool / "experiments" / "articulation_xl_quantization_256_token_4" / "grpo_1400.ckpt"
    )
    if not ckpt.exists():
        log("Downloading the SkinTokens weights…")
        _run([str(py), "download.py", "--model"], tool, log)


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


#: What the audio venv must be able to import before it counts as provisioned.
AUDIO_IMPORTS = ("parakeet_mlx", "mlx_audio", "numpy")


def _provision_audio(registry: Registry, log) -> None:
    """One venv for all three audio ops, plus the thinksound.cpp build for SFX.

    ONE venv on purpose: text→speech, speech→text and text→sound share MLX and
    numpy, and a 24 GB machine should never hold two of these at once anyway
    (jobs.py runs a single worker at a time for exactly this reason).

    The SFX side is a native build rather than a wheel — thinksound.cpp is GGML
    with a Metal backend, so it is compiled here the same way AutoRemesher and
    QuadriFlow are. Two upstream fixes are needed on macOS and are applied to
    the checkout after clone (see _patch_thinksound_for_macos).
    """
    uv = registry.uv_path
    audio = registry.tool_dir("audio")
    python = audio / ".venv" / "bin" / "python"
    if not python.exists():
        audio.mkdir(parents=True, exist_ok=True)
        log("Creating the audio venv…")
        _run([uv, "venv", str(audio / ".venv"), "--python", "3.12"], audio, log)
    probe = subprocess.run(
        [str(python), "-c", "import " + ", ".join(AUDIO_IMPORTS)],
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        log("Installing the audio stack (parakeet-mlx + mlx-audio)…")
        _run([uv, "pip", "install", "--python", str(python), "parakeet-mlx", "mlx-audio"], audio, log)

    # SFX: clone + build thinksound.cpp. Skipped entirely if it is already built,
    # since this is a multi-minute compile.
    tool = registry.ensure_tool_clone("thinksound.cpp", log)
    cli = tool / "build" / "ts-dasheng_generate"
    if cli.exists():
        return
    _patch_thinksound_for_macos(tool, log)
    log("Building thinksound.cpp (GGML + Metal)…")
    _run(["cmake", "-S", str(tool), "-B", str(tool / "build"), "-DCMAKE_BUILD_TYPE=Release"], tool, log)
    _run(["cmake", "--build", str(tool / "build"), "-j", "8"], tool, log)


def _patch_thinksound_for_macos(tool: Path, log) -> None:
    """Two upstream bugs that make thinksound.cpp unusable on a Mac.

    BOTH were hit on a real run, and neither is subtle once seen:

    1. `ts_resolve_gguf_dir` finds its own executable with
       `read_symlink("/proc/self/exe")`. That path is Linux-only; on macOS the
       throw escapes `main()` before any argument is parsed, so even `--help`
       died with an uncaught filesystem_error. Darwin's answer is
       _NSGetExecutablePath.

    2. `ts-dasheng_generate` wrote a perfectly good wav and then aborted with
       SIGABRT (exit 134) inside a STATIC destructor: ggml keeps its Metal
       devices in a function-local static whose destructor asserts the
       residency-set collection is empty, and something in the model wrappers
       has not freed a buffer. A caller reading the exit status sees a failure
       that did not happen. Leaving via _Exit after the file is closed skips
       static teardown; the kernel reclaims the memory. This does NOT fix the
       leak — that is worth reporting upstream — it stops the leak from being
       reported as a failed generation.

    Both are applied idempotently, so a re-provision over a patched checkout is
    a no-op rather than a double edit.
    """
    utils = tool / "src" / "common" / "ts_utils.cpp"
    if utils.exists():
        text = utils.read_text()
        if "_NSGetExecutablePath" not in text:
            log("Patching thinksound: /proc/self/exe is Linux-only")
            text = text.replace(
                'fs::path exe = fs::read_symlink("/proc/self/exe");',
                "fs::path exe;\n"
                "#if defined(__APPLE__)\n"
                "    { char buf[4096]; uint32_t sz = sizeof(buf);\n"
                "      if (_NSGetExecutablePath(buf, &sz) == 0) {\n"
                "          std::error_code ec; fs::path c = fs::canonical(fs::path(buf), ec);\n"
                "          exe = ec ? fs::path(buf) : c; } }\n"
                "#else\n"
                "    { std::error_code ec; exe = fs::read_symlink(\"/proc/self/exe\", ec);\n"
                "      if (ec) exe.clear(); }\n"
                "#endif",
            )
            if "#include <mach-o/dyld.h>" not in text:
                i = text.index("#include")
                text = text[:i] + "#if defined(__APPLE__)\n#include <mach-o/dyld.h>\n#endif\n" + text[i:]
            utils.write_text(text)

    gen = tool / "src" / "tools" / "dasheng_generate.cpp"
    if gen.exists():
        text = gen.read_text()
        if "std::_Exit(0)" not in text:
            log("Patching thinksound: skip static teardown after writing the wav")
            text = text.replace(
                "    return 0;\n}",
                "    // ggml's static Metal-device destructor asserts its residency set is\n"
                "    // empty and it is not, aborting AFTER a good wav is written. Leave\n"
                "    // before static teardown; the kernel reclaims the rest.\n"
                "    fflush(nullptr);\n"
                "    std::_Exit(0);\n}",
            )
            if "#include <cstdlib>" not in text:
                i = text.index("#include")
                text = text[:i] + "#include <cstdlib>\n" + text[i:]
            gen.write_text(text)
