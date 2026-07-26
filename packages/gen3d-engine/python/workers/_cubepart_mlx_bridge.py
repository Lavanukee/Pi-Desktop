"""Swap CubePart's PyTorch DiT for the MLX one, leaving the pipeline intact.

Only the denoiser moves. The VAE, the text encoder, the scheduler and the
geometry extraction stay exactly as they are — they were all verified correct
and they run once, not once per step, so porting them would add risk for no
wall-clock gain. This installs a shim in the one place the sampling loop
touches: `system.diffusion_model`.

Two pieces deliberately stay in PyTorch even inside the shim, both because they
are shape/timestep-only (no weights, no per-step cost worth counting) and both
because reimplementing them is silently wrong-able:

  the rotary table    depends only on (parts, latents, text length)
  the timestep sinusoid   is conditioned by ~1e6 — see _cubepart_mlx._temb

METAL PRECISION. This machine's default MLX matmul path is ~8e-4 accurate in
float32 (measured against float64; MLX's own CPU backend is 4.7e-7, PyTorch CPU
3.8e-7). Compiling for an older GPU arch selects the precise kernel and takes
the whole 27-block forward from 1.7e-2 to 9e-6 against PyTorch — at 4.49 s vs
1.96 s per forward. Which one is correct enough is a question about the
sampler, not the kernel, so it is a flag rather than a hardcoded choice.
"""

from __future__ import annotations

import gc
import os
from pathlib import Path

import numpy as np
import torch

# MUST precede `import mlx.core` — MLX picks its Metal compile target when the
# library initialises, so setting this afterwards silently does nothing.
if os.environ.get("PI_CUBEPART_MLX_PRECISE", "1") == "1":
    os.environ.setdefault("MLX_METAL_GPU_ARCH", "applegpu_g14g")

import mlx.core as mx  # noqa: E402

from _cubepart_mlx import CubePartDiT  # noqa: E402
from _cubepart_mlx_weights import load_weights  # noqa: E402


class MlxDiT(torch.nn.Module):
    """Presents the PyTorch DiT's calling convention; computes in MLX."""

    def __init__(self, model: CubePartDiT, pos_embed, time_proj) -> None:
        super().__init__()
        self._mlx = model
        self._pos_embed = pos_embed
        self._time_proj = time_proj
        self._rope_cache: dict = {}
        # The text conditioning and the part mask are computed once per job and
        # then reused by every step, but they are the two biggest things
        # crossing into MLX (the embeddings are 18 x 192 x 2560 = 35 MB). Cache
        # them on the buffer address, holding a reference so the address cannot
        # be recycled under us while the entry is live.
        self._const_cache: dict = {}

    def _const(self, name: str, t: torch.Tensor, build):
        key = (t.data_ptr(), tuple(t.shape), str(t.dtype))
        hit = self._const_cache.get(name)
        if hit is None or hit[0] != key:
            # One entry PER NAME: keyed only by the buffer, the mask and the
            # embeddings would evict each other on every step and cache nothing.
            hit = (key, t, build(t))
            self._const_cache[name] = hit
        return hit[2]

    def _rope(self, img_shapes, txt_seq_lens):
        key = (repr(img_shapes), repr(txt_seq_lens))
        if key not in self._rope_cache:
            with torch.no_grad():
                fi, ft = self._pos_embed(img_shapes, txt_seq_lens, device="cpu")
            self._rope_cache[key] = (
                mx.array(fi.detach().cpu().numpy()),
                mx.array(ft.detach().cpu().numpy()),
            )
        return self._rope_cache[key]

    def forward(  # noqa: PLR0913 — mirrors the signature it replaces
        self,
        hidden_states,
        encoder_hidden_states=None,
        encoder_hidden_states_mask=None,
        timestep=None,
        img_shapes=None,
        txt_seq_lens=None,
        guidance=None,
        attention_kwargs=None,
        return_dict: bool = True,
    ):
        seq = hidden_states.shape[1]
        multi_freqs, txt_freqs = self._rope(img_shapes, txt_seq_lens)
        img_freqs = multi_freqs[:seq]

        with torch.no_grad():
            t_proj = self._time_proj(timestep.float().cpu()).float().numpy()

        mask = None
        if attention_kwargs and attention_kwargs.get("attention_mask") is not None:
            # Bool over KEYS (padded part slots). Additive form so MLX's SDPA
            # sees the same thing torch's does; -1e9 rather than -inf because
            # only keys are masked, never a whole query row, so there is no
            # all-masked softmax to protect and a finite value cannot produce
            # a NaN if that ever changes.
            mask = self._const(
                "mask",
                attention_kwargs["attention_mask"],
                lambda t: mx.array(
                    np.where(t.detach().cpu().numpy().astype(bool), 0.0, -1e9).astype(np.float32)
                ),
            )

        txt_mx = self._const(
            "txt",
            encoder_hidden_states, lambda t: mx.array(t.detach().float().cpu().numpy())
        )
        out = self._mlx(
            mx.array(hidden_states.float().cpu().numpy()),
            txt_mx,
            mx.array(t_proj),
            img_freqs,
            txt_freqs,
            multi_freqs,
            mask,
        )
        mx.eval(out)
        result = torch.from_numpy(np.array(out, copy=False)).to(hidden_states.device)
        if not return_dict:
            return (result,)
        return result


def install(system, checkpoint_path: str | Path) -> MlxDiT:
    """Replace `system.diffusion_model` with the MLX denoiser and free the torch one."""
    from safetensors.torch import load_file

    torch_dit = system.diffusion_model
    model = CubePartDiT(
        num_layers=len(torch_dit.transformer_blocks),
        multi_index=tuple(int(i) for i in torch_dit.multi_attention_layer_index),
    )
    load_weights(model, {k: v.float().numpy() for k, v in load_file(str(checkpoint_path)).items()})
    mx.eval(model.parameters())

    shim = MlxDiT(model, torch_dit.pos_embed, torch_dit.time_text_embed.time_proj)
    # Assigning over the attribute drops the last reference to the torch blocks
    # (pos_embed and time_proj are held by the shim and have no weights), which
    # is worth several GB on a machine already holding the VAE and text encoder.
    system.diffusion_model = shim
    del torch_dit
    gc.collect()
    return shim
