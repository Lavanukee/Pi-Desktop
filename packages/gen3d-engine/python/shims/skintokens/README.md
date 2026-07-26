# SkinTokens — Apple Silicon shims

Copied into the checkout by `_provision_skintokens` (engine/envs.py) rather than
patched over it, so the clone stays a clean `git clone` at a pinned commit that
can be pulled forward without re-applying anything.

| file | why it exists |
|---|---|
| `flash_attn_interface.py` | SkinTokens needs flash-attn (CUDA-only) from five places, each opening with `try: from flash_attn_interface import flash_attn_func`. A module of that name on `sys.path` satisfies all five. SDPA computes the same function — the CUDA kernel is a tiling/IO optimisation, not a different operator. |
| `apple_compat.py` | Three blockers: the FA3 probe calls `torch.cuda.get_device_name(0)` which RAISES without CUDA (so the package cannot even import); transformers refuses a hard-coded `flash_attention_2`; and `@torch.autocast(device_type='cuda')` silently DISABLES on a Mac, leaving bf16 weights against fp32 activations until Metal aborts the process. |
| the `.pth` | Written by the provisioner into the venv's `site-packages`. A `.pth` line beginning with `import` executes at interpreter startup — the only hook early enough, because the autocast decorators bind when `src.model` is imported and the bpy subprocess imports the same modules independently. |

`PI_ST_AUTOCAST=off` plus `--dtype float32` is required for a CORRECT rig, not
just a running one: bf16 on MPS produces joints unrelated to their own skin
weights (median 36.6% of the model diagonal from the vertices they drive, versus
2.9% at fp32).
