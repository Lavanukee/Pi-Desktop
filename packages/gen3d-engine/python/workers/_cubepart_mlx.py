"""CubePart's part-denoiser DiT, in MLX.

WHY

Segmentation was the slowest thing in the studio by an order of magnitude:
~25 minutes on CPU, because torch-MPS cannot run this model correctly (measured
— every component matches CPU to ~1% but that error, amplified by guidance 7.5
and compounded over 30 steps, walks the sampler off-distribution until the
decoded field never crosses the iso-surface; see cubepart_worker).

MEASURED on this M5 Pro before writing a line of it, on the shapes this model
actually runs (23 blocks at batch 9 x seq 1024, 4 at seq 9216):

    torch-CPU   ~50 s/step     30 steps ~25 min
    torch-MPS   ~17.7 s/step   wrong output
    MLX          ~1.25 s/step  (2.5 with CFG)  ->  30 steps ~1.3 min

ONLY THE DENOISE IS PORTED. The VAE and the text encoder stay in PyTorch: both
were verified correct on MPS, they run once rather than thirty times, and
porting them would triple the surface area for no wall-clock gain. The boundary
is numpy — latents and text embeddings in, predicted velocity out.

The RoPE frequency table is NOT reimplemented here either. It depends only on
the shapes (parts, latents, text length), never on the weights or the step, so
the caller computes it once with the reference implementation and passes it in.
That keeps the fiddliest, most silently-wrong-able piece of a port out of the
port entirely.

SHAPE OF THE MODEL (read off the checkpoint, not assumed)
    23 x QwenImageTransformerBlock   dual-stream img+txt, dim 1536, 12 heads
                                     x 128, mod 6*1536, mlp 4*1536
     4 x QwenGatedTransformerBlock   single-stream, run over ALL parts
                                     concatenated, to_q emits 2*inner_dim: half
                                     query, half a per-head GATE applied as
                                     sigmoid(gate) after attention
    inserted at multi_attention_layer_index; the block output is averaged into
    the main stream (0.5 * (hidden + multi)), which is what lets parts see each
    other and is presumably why they come out distinct at all.
"""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn


def _modulate(x: mx.array, mod: mx.array) -> tuple[mx.array, mx.array]:
    """shift/scale/gate from a modulation vector, broadcast over the sequence."""
    shift, scale, gate = mx.split(mod, 3, axis=-1)
    return x * (1 + scale[:, None]) + shift[:, None], gate[:, None]


def _rope(x: mx.array, freqs: mx.array) -> mx.array:
    """Rotary embedding, complex form: view x as complex pairs, multiply, back.

    Mirrors apply_rotary_emb_qwen(use_real=False). `x` is (B, S, H, D) and
    `freqs` is (S, D/2) complex — the caller supplies it already built, so the
    only thing that can go wrong here is the pairing, which is why x is split
    on the LAST axis into (..., D/2, 2) exactly as torch.view_as_complex does.
    """
    b, s, h, d = x.shape
    xr = x.astype(mx.float32).reshape(b, s, h, d // 2, 2)
    xc_r, xc_i = xr[..., 0], xr[..., 1]
    # freqs: (S, D/2) complex -> broadcast over batch and heads
    f_r = freqs.real[None, :, None, :]
    f_i = freqs.imag[None, :, None, :]
    out_r = xc_r * f_r - xc_i * f_i
    out_i = xc_r * f_i + xc_i * f_r
    return mx.stack([out_r, out_i], axis=-1).reshape(b, s, h, d).astype(x.dtype)


class _RMSNorm(nn.Module):
    """RMSNorm over the head dimension (diffusers' qk_norm='rms_norm')."""

    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.weight = mx.ones((dim,))
        self.eps = eps

    def __call__(self, x: mx.array) -> mx.array:
        f = x.astype(mx.float32)
        n = f * mx.rsqrt(mx.mean(f * f, axis=-1, keepdims=True) + self.eps)
        return (n * self.weight).astype(x.dtype)


class _FeedForward(nn.Module):
    """diffusers FeedForward with activation_fn='gelu-approximate'."""

    def __init__(self, dim: int, mult: int = 4):
        super().__init__()
        self.proj = nn.Linear(dim, dim * mult)
        self.out = nn.Linear(dim * mult, dim)

    def __call__(self, x: mx.array) -> mx.array:
        return self.out(nn.gelu_approx(self.proj(x)))


class JointBlock(nn.Module):
    """QwenImageTransformerBlock: img and txt attend jointly, gated per stream."""

    def __init__(self, dim: int = 1536, heads: int = 12, head_dim: int = 128):
        super().__init__()
        self.heads, self.head_dim, self.dim = heads, head_dim, dim
        inner = heads * head_dim
        self.img_mod = nn.Linear(dim, 6 * dim)
        self.txt_mod = nn.Linear(dim, 6 * dim)
        self.to_q, self.to_k, self.to_v = (nn.Linear(dim, inner) for _ in range(3))
        self.add_q_proj, self.add_k_proj, self.add_v_proj = (
            nn.Linear(dim, inner) for _ in range(3)
        )
        self.norm_q, self.norm_k = _RMSNorm(head_dim), _RMSNorm(head_dim)
        self.norm_added_q, self.norm_added_k = _RMSNorm(head_dim), _RMSNorm(head_dim)
        self.to_out = nn.Linear(inner, dim)
        self.to_add_out = nn.Linear(inner, dim)
        self.img_mlp = _FeedForward(dim)
        self.txt_mlp = _FeedForward(dim)

    def _heads(self, x: mx.array) -> mx.array:
        b, s, _ = x.shape
        return x.reshape(b, s, self.heads, self.head_dim)

    def __call__(self, img, txt, temb, img_freqs, txt_freqs):
        img_mod1, img_mod2 = mx.split(self.img_mod(nn.silu(temb)), 2, axis=-1)
        txt_mod1, txt_mod2 = mx.split(self.txt_mod(nn.silu(temb)), 2, axis=-1)

        img_n = mx.fast.layer_norm(img, None, None, 1e-6)
        img_m, img_g1 = _modulate(img_n, img_mod1)
        txt_n = mx.fast.layer_norm(txt, None, None, 1e-6)
        txt_m, txt_g1 = _modulate(txt_n, txt_mod1)

        iq = _rope(self.norm_q(self._heads(self.to_q(img_m))), img_freqs)
        ik = _rope(self.norm_k(self._heads(self.to_k(img_m))), img_freqs)
        iv = self._heads(self.to_v(img_m))
        tq = _rope(self.norm_added_q(self._heads(self.add_q_proj(txt_m))), txt_freqs)
        tk = _rope(self.norm_added_k(self._heads(self.add_k_proj(txt_m))), txt_freqs)
        tv = self._heads(self.add_v_proj(txt_m))

        # Joint attention, text first — the split below relies on that order.
        seq_txt = txt.shape[1]
        q = mx.concatenate([tq, iq], axis=1).transpose(0, 2, 1, 3)
        k = mx.concatenate([tk, ik], axis=1).transpose(0, 2, 1, 3)
        v = mx.concatenate([tv, iv], axis=1).transpose(0, 2, 1, 3)
        a = mx.fast.scaled_dot_product_attention(q, k, v, scale=self.head_dim**-0.5)
        a = a.transpose(0, 2, 1, 3).reshape(q.shape[0], -1, self.heads * self.head_dim)

        img = img + img_g1 * self.to_out(a[:, seq_txt:])
        txt = txt + txt_g1 * self.to_add_out(a[:, :seq_txt])

        img_m2, img_g2 = _modulate(mx.fast.layer_norm(img, None, None, 1e-6), img_mod2)
        img = img + img_g2 * self.img_mlp(img_m2)
        txt_m2, txt_g2 = _modulate(mx.fast.layer_norm(txt, None, None, 1e-6), txt_mod2)
        txt = txt + txt_g2 * self.txt_mlp(txt_m2)
        return img, txt


class GatedBlock(nn.Module):
    """QwenGatedTransformerBlock — runs across ALL parts at once.

    to_q emits 2*inner_dim: the first half is the query, the second is a
    per-head gate applied as sigmoid(gate) to the attention output. That gate is
    the mechanism by which a part can suppress what it takes from the others.
    """

    def __init__(self, dim: int = 1536, heads: int = 12, head_dim: int = 128):
        super().__init__()
        self.heads, self.head_dim, self.dim = heads, head_dim, dim
        inner = heads * head_dim
        self.img_mod = nn.Linear(dim, 6 * dim)
        self.to_q = nn.Linear(dim, inner * 2)
        self.to_k, self.to_v = nn.Linear(dim, inner), nn.Linear(dim, inner)
        self.norm_q, self.norm_k = _RMSNorm(head_dim), _RMSNorm(head_dim)
        self.to_out = nn.Linear(inner, dim)
        self.img_mlp = _FeedForward(dim)

    def __call__(self, img, temb, freqs, mask=None):
        mod1, mod2 = mx.split(self.img_mod(nn.silu(temb)), 2, axis=-1)
        x, g1 = _modulate(mx.fast.layer_norm(img, None, None, 1e-6), mod1)

        b, s, _ = x.shape
        qg = self.to_q(x)
        q_raw, gate = mx.split(qg, 2, axis=-1)
        q = self.norm_q(q_raw.reshape(b, s, self.heads, self.head_dim))
        k = self.norm_k(self.to_k(x).reshape(b, s, self.heads, self.head_dim))
        v = self.to_v(x).reshape(b, s, self.heads, self.head_dim)
        gate = gate.reshape(b, s, self.heads, self.head_dim)
        q, k = _rope(q, freqs), _rope(k, freqs)

        a = mx.fast.scaled_dot_product_attention(
            q.transpose(0, 2, 1, 3),
            k.transpose(0, 2, 1, 3),
            v.transpose(0, 2, 1, 3),
            scale=self.head_dim**-0.5,
            mask=mask,
        ).transpose(0, 2, 1, 3)
        a = (a * mx.sigmoid(gate)).reshape(b, s, self.heads * self.head_dim)

        img = img + g1 * self.to_out(a)
        x2, g2 = _modulate(mx.fast.layer_norm(img, None, None, 1e-6), mod2)
        return img + g2 * self.img_mlp(x2)


class CubePartDiT(nn.Module):
    """The whole denoiser: 23 joint blocks with 4 gated cross-part blocks woven in."""

    def __init__(
        self,
        num_layers: int = 23,
        multi_index: tuple[int, ...] = (),
        dim: int = 1536,
        heads: int = 12,
        head_dim: int = 128,
        in_channels: int = 64,
        cond_dim: int = 2560,
    ):
        super().__init__()
        self.multi_index = tuple(multi_index)
        self.img_in = nn.Linear(in_channels, dim)
        self.txt_norm = _RMSNorm(cond_dim)
        self.txt_in = nn.Linear(cond_dim, dim)
        self.t_linear_1 = nn.Linear(256, dim)
        self.t_linear_2 = nn.Linear(dim, dim)
        self.blocks = [JointBlock(dim, heads, head_dim) for _ in range(num_layers)]
        self.multi_blocks = [GatedBlock(dim, heads, head_dim) for _ in self.multi_index]
        self.norm_out_linear = nn.Linear(dim, 2 * dim)
        self.proj_out = nn.Linear(dim, in_channels)

    def _temb(self, t_proj: mx.array) -> mx.array:
        """The timestep MLP: sinusoid (256) -> linear -> SiLU -> linear.

        The SINUSOID ITSELF IS NOT COMPUTED HERE, for the same reason RoPE is
        not: it depends only on the timestep, and it is violently
        ill-conditioned. Timesteps(scale=1000) makes the sinusoid argument
        999 * 1000 = 999000, so a one-ulp difference in the frequency table --
        a different-but-equally-correct float32 exp() -- moves the phase by
        ~0.06 rad and changes cos by ~6e-2.

        MEASURED, computing it here: temb was off by 4.1e-3 while img_in was
        bit-exact, and that single wrong input put a ~1e-3 error into all 27
        blocks (they take temb as modulation), which the residual stack
        amplified to 1.2e-2 at the output. Feeding torch's temb instead, every
        block matched to ~1e-7, worst 2.7e-6. So the caller computes it once
        with diffusers' get_timestep_embedding and passes it in.
        """
        return self.t_linear_2(nn.silu(self.t_linear_1(t_proj)))

    def __call__(self, latents, txt, t_proj, img_freqs, txt_freqs, multi_freqs, mask=None):
        """latents (P, L, C) — one row per part. Returns the same shape.

        `t_proj` is (P, 256) from Timesteps(256, flip_sin_to_cos=True,
        downscale_freq_shift=0, scale=1000) — see _temb for why it's an input.
        """
        parts, seq = latents.shape[0], latents.shape[1]
        # Rows are groups of `num_multi` slots. Classifier-free guidance stacks
        # the conditional and unconditional batches, so `parts` is 2*num_multi
        # in a real run and num_multi only in a single-batch probe — deriving it
        # from the rotary table instead of assuming one group is what makes the
        # two agree.
        num_multi = multi_freqs.shape[0] // seq
        groups = parts // num_multi

        img = self.img_in(latents)
        txt = self.txt_in(self.txt_norm(txt))
        temb = self._temb(t_proj)
        # The gated blocks see a whole group's latents as ONE sequence; the joint
        # blocks see each slot separately, so theirs is the per-slot row.
        multi_temb = temb.reshape(groups, num_multi, -1)[:, 0]

        m = 0
        for i, block in enumerate(self.blocks):
            multi_out = None
            if i in self.multi_index:
                flat = img.reshape(groups, num_multi * seq, -1)
                multi_out = self.multi_blocks[m](flat, multi_temb, multi_freqs, mask)
                multi_out = multi_out.reshape(parts, seq, -1)
                m += 1
            img, txt = block(img, txt, temb, img_freqs, txt_freqs)
            if multi_out is not None:
                img = 0.5 * (img + multi_out)

        # SCALE FIRST, then shift — diffusers' AdaLayerNormContinuous chunks in
        # that order (normalization.py: `scale, shift = torch.chunk(emb, 2)`),
        # which is the opposite of the shift/scale order used by the per-block
        # modulation above. Getting this backwards is silent: the shapes agree
        # and the output is merely wrong.
        scale, shift = mx.split(self.norm_out_linear(nn.silu(temb)), 2, axis=-1)
        out = mx.fast.layer_norm(img, None, None, 1e-6) * (1 + scale[:, None]) + shift[:, None]
        return self.proj_out(out)
