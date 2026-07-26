"""Map CubePart's checkpoint onto the MLX DiT in _cubepart_mlx.

Kept separate from the model so the mapping can be read as a table. Every entry
here is a claim about what a tensor MEANS, and a wrong one is silent — the
shapes still line up and the output is merely wrong — so the companion probe
compares a full forward against PyTorch CPU before any of this is trusted.

MLX's nn.Linear stores weight as (out, in), the same layout torch uses, so the
tensors copy across without transposing.
"""

from __future__ import annotations

import mlx.core as mx

PREFIX = "diffusion_model."

# checkpoint suffix -> attribute path on the MLX module
_JOINT = {
    "img_mod.1": "img_mod",
    "txt_mod.1": "txt_mod",
    "attn.to_q": "to_q",
    "attn.to_k": "to_k",
    "attn.to_v": "to_v",
    "attn.add_q_proj": "add_q_proj",
    "attn.add_k_proj": "add_k_proj",
    "attn.add_v_proj": "add_v_proj",
    "attn.to_out.0": "to_out",
    "attn.to_add_out": "to_add_out",
    "img_mlp.net.0.proj": "img_mlp.proj",
    "img_mlp.net.2": "img_mlp.out",
    "txt_mlp.net.0.proj": "txt_mlp.proj",
    "txt_mlp.net.2": "txt_mlp.out",
}
_JOINT_NORMS = {
    "attn.norm_q": "norm_q",
    "attn.norm_k": "norm_k",
    "attn.norm_added_q": "norm_added_q",
    "attn.norm_added_k": "norm_added_k",
}
_GATED = {
    "img_mod.1": "img_mod",
    "attn.to_q": "to_q",
    "attn.to_k": "to_k",
    "attn.to_v": "to_v",
    "attn.to_out.0": "to_out",
    "img_mlp.net.0.proj": "img_mlp.proj",
    "img_mlp.net.2": "img_mlp.out",
}
_GATED_NORMS = {"attn.norm_q": "norm_q", "attn.norm_k": "norm_k"}
_TOP = {
    "img_in": "img_in",
    "txt_in": "txt_in",
    "time_text_embed.timestep_embedder.linear_1": "t_linear_1",
    "time_text_embed.timestep_embedder.linear_2": "t_linear_2",
    "norm_out.linear": "norm_out_linear",
    "proj_out": "proj_out",
}


def _assign(root, path: str, field: str, value: mx.array) -> None:
    obj = root
    for part in path.split("."):
        obj = obj[int(part)] if part.isdigit() else getattr(obj, part)
    setattr(obj, field, value)


def load_weights(model, tensors: dict, dtype=mx.float32) -> list[str]:
    """Copy `tensors` (name -> numpy array) into `model`. Returns unused keys."""
    used: set[str] = set()

    def put(key: str, path: str, field: str) -> None:
        if key in tensors:
            _assign(model, path, field, mx.array(tensors[key]).astype(dtype))
            used.add(key)

    for suffix, attr in _TOP.items():
        for field in ("weight", "bias"):
            put(f"{PREFIX}{suffix}.{field}", attr, field)
    put(f"{PREFIX}txt_norm.weight", "txt_norm", "weight")

    for i in range(len(model.blocks)):
        base = f"{PREFIX}transformer_blocks.{i}."
        for suffix, attr in _JOINT.items():
            for field in ("weight", "bias"):
                put(f"{base}{suffix}.{field}", f"blocks.{i}.{attr}", field)
        for suffix, attr in _JOINT_NORMS.items():
            put(f"{base}{suffix}.weight", f"blocks.{i}.{attr}", "weight")

    for i in range(len(model.multi_blocks)):
        base = f"{PREFIX}multi_transformer_blocks.{i}."
        for suffix, attr in _GATED.items():
            for field in ("weight", "bias"):
                put(f"{base}{suffix}.{field}", f"multi_blocks.{i}.{attr}", field)
        for suffix, attr in _GATED_NORMS.items():
            put(f"{base}{suffix}.weight", f"multi_blocks.{i}.{attr}", "weight")

    return sorted(set(tensors) - used)
