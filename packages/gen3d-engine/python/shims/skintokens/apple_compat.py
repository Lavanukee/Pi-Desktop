"""Make SkinTokens importable on a Mac. Import this BEFORE any `src.*` module.

SkinTokens decides at IMPORT TIME whether it can use FlashAttention-3:

    # src/model/michelangelo/utils/misc.py
    def get_device_type():  return torch.cuda.get_device_name(0)
    class FLASH3:          self.available = "H100" in get_device_type()
    use_flash3 = FLASH3()          # ← runs on import

On a machine without CUDA that call does not return a falsy string, it raises
`AssertionError: Torch not compiled with CUDA enabled`, so the package cannot be
imported at all — the failure is in the capability PROBE, not in any maths.

Rather than edit upstream (the checkout stays a clean clone — see
flash_attn_interface.py for the same reasoning), give the probe an honest answer:
this is not an H100, so `use_flash3` resolves to False, which is exactly the
branch we want. `torch.cuda.synchronize` gets the same treatment because misc.py
calls it around timing blocks.

Both patches apply ONLY when CUDA is genuinely unavailable, so this file is inert
on a real CUDA box.
"""

from __future__ import annotations

import os

import torch


def apply() -> None:
    if torch.cuda.is_available():
        return

    def _device_name(_device=None) -> str:
        # Truthful, and free of "H100" — so the FLASH3 probe answers False.
        return "Apple Silicon (MPS)"

    def _synchronize(_device=None) -> None:
        if torch.backends.mps.is_available():
            torch.mps.synchronize()

    torch.cuda.get_device_name = _device_name  # type: ignore[assignment]
    torch.cuda.synchronize = _synchronize  # type: ignore[assignment]

    _redirect_autocast()
    _redirect_flash_attention()


def _redirect_autocast() -> None:
    """Point `@torch.autocast(device_type='cuda')` at MPS.

    SkinTokens wraps its forward passes in autocast for the DEVICE IT WAS
    WRITTEN FOR:

        @torch.autocast(device_type='cuda', dtype=torch.bfloat16)

    On a Mac torch does not error on that — it warns "CUDA is not available …
    Disabling autocast" and carries on with autocast OFF. The model's weights
    are bfloat16 while its activations stay float32, and the first mixed matmul
    dies inside Metal itself:

        MPSNDArrayMatrixMultiplication.mm:5813: failed assertion `Destination
        NDArray and Accumulator NDArray cannot have different datatype'

    which is a process-level abort, not a Python exception. Autocast is exactly
    the mechanism that reconciles those dtypes on CUDA, so the fix is to let it
    do its job here: rewrite the device_type at construction. Decorator use is
    preserved because torch.autocast instances are their own decorators, and
    subclassing keeps that.

    The decorators run at class-definition time, i.e. when `src.model.*` is
    imported — which is why this module has to be loaded first (the venv's
    .pth does that for every process, including bpy_server.py).
    """
    original = torch.autocast

    # Autocast's device_type has to match where the TENSORS actually are, so a
    # CPU run needs 'cpu' and not 'mps' — forcing MPS there leaves the same
    # mixed dtypes autocast exists to fix ("mat1 and mat2 must have the same
    # dtype, but got Float and BFloat16"). PI_ST_AUTOCAST lets the caller say
    # which; it has to be an env var because this module is loaded by the venv's
    # .pth at interpreter startup, before any worker code runs.
    target = os.environ.get("PI_ST_AUTOCAST")
    if target not in ("mps", "cpu", "off"):
        target = "mps" if torch.backends.mps.is_available() else "cpu"

    class _RedirectedAutocast(original):  # type: ignore[misc,valid-type]
        def __init__(self, device_type: str, *args, **kwargs):
            if target == "off":
                # Everything stays in the model's own dtype — for running the
                # whole thing in fp32, where bf16 on this backend is the problem
                # rather than the fix. See PI_ST_AUTOCAST=off in the worker.
                kwargs["enabled"] = False
            elif device_type == "cuda":
                device_type = target
            super().__init__(device_type, *args, **kwargs)

    torch.autocast = _RedirectedAutocast  # type: ignore[assignment]


def _redirect_flash_attention() -> None:
    """Ask transformers for SDPA wherever SkinTokens hard-codes flash-attn.

    TokenRig builds its Qwen3-0.6B with

        AutoModelForCausalLM.from_config(config, attn_implementation="flash_attention_2")

    and transformers refuses outright when the flash-attn package is absent
    ("FlashAttention2 has been toggled on, but it cannot be used"). The string is
    a literal in upstream's constructor, so there is nothing to configure —
    rewrite the request at the factory instead. SDPA computes the same attention;
    on Qwen3 it is a first-class supported implementation, not a fallback.

    Same reasoning as flash_attn_interface.py: the checkout stays a clean clone.
    """
    try:
        import transformers
    except ImportError:  # pragma: no cover — transformers is a hard dependency
        return

    def _swap(kwargs: dict) -> dict:
        impl = kwargs.get("attn_implementation")
        if isinstance(impl, str) and impl.startswith("flash_attention"):
            kwargs = {**kwargs, "attn_implementation": "sdpa"}
        if kwargs.get("_attn_implementation", "").startswith("flash_attention"):
            kwargs = {**kwargs, "_attn_implementation": "sdpa"}
        return kwargs

    for factory in ("AutoModelForCausalLM", "AutoModel"):
        cls = getattr(transformers, factory, None)
        if cls is None:
            continue
        for method in ("from_config", "from_pretrained"):
            original = getattr(cls, method, None)
            if original is None:
                continue

            def wrapper(*args, __orig=original, **kwargs):
                return __orig(*args, **_swap(kwargs))

            setattr(cls, method, wrapper)


apply()
