"""flash-attn stand-in for Apple Silicon — SDPA under FlashAttention-3's name.

WHY THIS FILE EXISTS INSTEAD OF PATCHES

SkinTokens needs flash-attn, which is CUDA-only, and it reaches for it from five
places (skin_vae_model, tokenrig, skin_vae/attention_processor,
skin_vae/autoencoders/miche_transformer_blocks). Every one of them opens with

    try:
        from flash_attn_interface import flash_attn_func
    except Exception:
        ...

so a module of that name on sys.path satisfies all five and NOT ONE upstream
file has to be edited — the checkout stays a clean `git clone` that can be
pulled forward without re-applying anything.

WHAT IT COMPUTES

flash_attn_func's contract, as the callers use it: q/k/v shaped (B, S, H, D),
result (B, S, H, D), returned as a tuple whose first element is the output
(FlashAttention-3 returns (out, softmax_lse); two of the call sites unpack with
`out, _ =`). torch.nn.functional.scaled_dot_product_attention wants
(B, H, S, D), so the transposes here are the whole adapter.

Grouped-query attention is handled by repeating the K/V heads, matching what
upstream's own SDPA fallback in attention_processor.py does — that fallback is
the reference for this shim's behaviour, generalised to every call site and to
the (out, lse) tuple shape.

Exactness: SDPA computes the same function as FlashAttention — the CUDA kernel
is a tiling/IO optimisation, not a different operator — so this is a performance
substitution, not an approximation. MPS picks its own SDPA backend.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F

__all__ = ["flash_attn_func", "flash_attn_varlen_func"]


def flash_attn_func(q, k, v, *_args, causal: bool = False, softmax_scale=None, **_kwargs):
    """(B, S, H, D) in → ((B, S, H, D), None) out."""
    qt = q.transpose(1, 2)  # → (B, H, S, D)
    kt = k.transpose(1, 2)
    vt = v.transpose(1, 2)

    # GQA/MQA: fewer K/V heads than Q heads. Repeat so SDPA sees matching heads.
    if qt.shape[1] != kt.shape[1] and kt.shape[1] > 0:
        repeat = qt.shape[1] // kt.shape[1]
        if repeat > 1:
            kt = kt.repeat_interleave(repeat, dim=1)
            vt = vt.repeat_interleave(repeat, dim=1)

    # One dtype for all three — the callers mix bf16 params with fp32 activations
    # (Perceiver casts only q), which SDPA rejects.
    dtype = torch.promote_types(torch.promote_types(qt.dtype, kt.dtype), vt.dtype)
    qt, kt, vt = qt.to(dtype), kt.to(dtype), vt.to(dtype)

    out = F.scaled_dot_product_attention(qt, kt, vt, is_causal=causal, scale=softmax_scale)
    return out.transpose(1, 2), None


def flash_attn_varlen_func(*args, **kwargs):  # pragma: no cover — not on this path
    raise NotImplementedError("varlen flash-attn has no SDPA equivalent shim")
