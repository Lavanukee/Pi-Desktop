# gen3d engine feasibility — verified on THIS machine

Machine: Apple M5 Pro, 24 GB unified memory, macOS 26.4 (Darwin 25.4), 330+ GB free.
Date: 2026-07-23. Everything below was tested here unless explicitly marked otherwise.
"Runs on MPS" means the real model, real weights, no CUDA anywhere.

## Verdict table

| Model | Repo (as downloaded) | On-disk size | MPS verdict | Verified end-to-end here |
|---|---|---|---|---|
| TRELLIS-2 (4B) | `microsoft/TRELLIS.2-4B` + aux (below) | 18.0 GB total | **YES** via [shivampkumar/trellis-mac](https://github.com/shivampkumar/trellis-mac) (Metal port of flexgemm/o-voxel/nvdiffrast; SDPA attention) | **YES** — real GLB from a real image at `512`: 3 m 15 s wall with Metal backends (99.6 s gen + 11 s bake), 7 m 40 s on the no-Metal fallback; 209 k verts / 200 k tris, PBR basecolor+MR textures, GLB validates |
| Mage-Flow Turbo | `microsoft/Mage-Flow-Turbo` | 17.5 GB | **YES** — SDPA everywhere; two clobbers had to be fixed: `VF_HF_ATTN_IMPL=sdpa` for the Qwen3-VL encoder AND `set_attn_backend('sdpa')` AFTER load (the DiT ctor re-selects flash2 from config) | **YES** — real 1024² photoreal image from a prompt in 1 m 22 s wall (17.5 GB load included), 4 steps / cfg 1.0 |
| Hunyuan Paint | `tencent/Hunyuan3D-2.1` (paintpbr subset ONLY, 6.9 GB — not the 14.9 GB repo) **+ `facebook/dinov2-giant` (4.5 GB view conditioner) + RealESRGAN_x4plus (67 MB)** | 11.5 GB total | **RISKY** — [Brainkeys/Hunyuan3D-2.1-mac](https://github.com/Brainkeys/Hunyuan3D-2.1-mac) removes the CUDA rasterizer, but community reports show heavy unified-memory pressure on 24 GB; its macOS requirements also miss pymeshlab/xatlas (provisioning adds them) | scaffolded, honest errors on failure |
| CubePart | `Roblox/cubepart` **+ `Qwen/Qwen3-VL-4B-Instruct` (8.9 GB — its prompt encoder, discovered at first run and added to the catalog)** | 18.8 GB total | pure PyTorch, encoder defaults to sdpa; one MPS float64 cast fixed in our worker | verification status in the engine report |
| AutoRemesher | huxingyi/autoremesher **1.0.0 release, native arm64** | 17 MB | **YES** (CPU tool, no GPU) | **YES** — headless CLI remesh verified (cube → 78 quads, 0.017 s; report file written) |
| Hunyuan3D-Omni | `tencent/Hunyuan3D-Omni` | 25.7 GB repo (12.2 GB fp32 model + EMA copy) | **NO on this machine** — no macOS/MPS port exists (upstream is CUDA-only, same `hunyuan3d-2` stack whose rasterizer fails to build on arm64); weights are fp32 `.bin`, and its differentiator (pose/point/voxel control signals) isn't what the studio pipeline needs | **omitted from the catalog** (decision below) |

## The true TRELLIS.2 resolution presets

Verified from `pipeline.json` + `trellis2_image_to_3d.py` in the shipped repo:

- Checkpoints: sparse-structure DiT at **64³**, shape/tex SLAT DiTs at **512** and **1024**.
- `pipeline_type` ∈ `'512' | '1024' | '1024_cascade' | '1536_cascade'` (nothing else).
- Therefore **low/medium/high = 512 / 1024 / 1536** — the believed 768 preset does not exist.
- Engine mapping: low→`512`, medium→`1024_cascade` (upstream default), high→`1536_cascade`.
- Sampler defaults: 12 steps per phase, `FlowEulerGuidanceIntervalSampler`.

## TRELLIS.2 on MPS — what actually made it work here

1. **Port**: upstream is Linux/CUDA-only (flash-attn, nvdiffrast, nvdiffrec, cumesh,
   o-voxel, flexgemm). The trellis-mac fork replaces them (mtlgemm/mtldiffrast/mtlbvh
   Metal kernels + SDPA + fast_simplification) and patches hardcoded `.cuda()` calls.
2. **Aux models**: `pipeline.json` pulls three more repos:
   `microsoft/TRELLIS-image-large` (ss decoder, 148 MB — we fetch just that file),
   `facebook/dinov3-vitl16-pretrain-lvd1689m` (image conditioner, **gated: manual**),
   `briaai/RMBG-2.0` (rembg, **gated: auto**). With no HF token on the machine the
   engine substitutes public equivalents and patches the cached pipeline configs:
   - DINOv3 → `camenduru/dinov3-vitl16-pretrain-lvd1689m` (byte-identical mirror,
     1.21 GB, same `model.safetensors` size; DINOv3 License permits redistribution).
   - rembg → `ZhengPeng7/BiRefNet` (the original BiRefNet author's repo, MIT,
     not gated). NOT a byte mirror: RMBG-2.0's remote code is stale and crashes
     under BOTH transformers 5.14.1 (`Config` lacks `model_type`) and 4.57.1
     (`Config` lacks `get_text_config`) — verified here; ZhengPeng7's maintained
     code loads cleanly. RMBG-2.0 is a BiRefNet fine-tune; for background
     removal duty the base model is equivalent in practice. Alpha-channel
     inputs skip rembg entirely (`preprocess_image` checks alpha first).
3. **Version pins that are load-bearing** (all failures reproduced here):
   - `transformers==4.57.1` — 5.14.1's conversion-mapping pass breaks remote-code
     models; 4.56+ is required for `DINOv3ViTModel`. 4.57.1 satisfies both.
   - `einops` — required by the BiRefNet remote code, not in trellis-mac's dep list.
4. **Metal toolchain**: the mtl* wheels need Apple's `metal` compiler. Command Line
   Tools alone lack it; even with Xcode 26.6 installed it is a separate component
   (`xcodebuild -downloadComponent MetalToolchain`, 688 MB — installed here). The
   engine sets `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for the
   build only (no `xcode-select` change). Without the toolchain everything still
   runs — conv falls back to `none` and baking to the pure-Python KDTree path
   (slower, slightly lower texture quality), which is how the first verified
   generation below was produced.
5. **Known MPS behaviors** (from the port, reproduced in our logs):
   `aten::segment_reduce` CPU fallback warning (harmless); the macOS GPU watchdog
   can kill long Metal kernels on big meshes → surfaced as an honest error with
   guidance (the port's watchdog signatures are detected and reported).

## Hunyuan3D-Omni decision

Omitted from the catalog rather than listed-unavailable: (a) no Metal/MPS port
exists to even scaffold against — the CUDA rasterizer/build fails on arm64 by
report and there is no community mac fork; (b) its value is *conditioned*
generation (skeleton/pose/voxel control), which the studio's pipeline doesn't
expose; TRELLIS-2 covers the geometry role strictly better on this hardware.
Revisit if a port appears.

## Which geometry model is default

**TRELLIS-2 at `1024_cascade` (medium)** is the engine default and the only
geometry path in the catalog. Hunyuan3D-2.1's DiT (the only feasible Hunyuan
geometry candidate) has mac forks, but on 24 GB the paint+shape stack is
reported OOM-prone and its geometry quality target (v2.1) is a generation
behind TRELLIS.2's; TRELLIS-2 is the one verified to produce a real textured
GLB here. (jedd's "find the one that performs best on this hardware": measured
numbers are in the engine report; TRELLIS-2 wins by default of being the only
one that completes reliably.)

## Texture chain truth

TRELLIS.2 textures **natively** (tex-SLAT → PBR bake: base color, metallic,
roughness). `generate(texture:true)` uses that native path — it is the
verified-on-Metal route. Hunyuan Paint backs the standalone *texture* stage op
for re-texturing an existing mesh. jedd believed "trellis will auto texture
with hunyuan paint" — the auto-texturing is real but it is TRELLIS.2's own;
wiring Paint into generate() would only add an unverified 6.9 GB dependency to
the happy path.

## Verified full chain (through the real sidecar, 2026-07-23)

`POST /generate {kind:"text", prompt:"a small ceramic teapot, glossy blue
glaze…", resolution:"low", texture:true}` on this machine produced, in order:
a photoreal prompt image (Mage, 4 step events) → the UNTEXTURED geometry GLB
pushed while texturing continued (1,265,748 triangles) → the Metal-baked
textured GLB (199,150 tris, basecolor+MR). 56 job events, 42 with real step
counts; both GLBs validate structurally; artifacts under
`~/.pi/desktop/sandbox/gen3d/<jobId>/`. The retopo stage op (AutoRemesher CLI)
and the download→provision flow (dmg → hdiutil → stamp → catalog-changed)
were verified through the sidecar the same way.

## Progress + previews honesty

- Per-step progress is real: every pipeline loops through tqdm (TRELLIS samplers
  label their phases via `tqdm_desc`), and the workers shim tqdm into NDJSON
  step events; Mage-Flow's DiT forward is wrapped per denoise step.
- The untextured-geometry GLB is pushed the moment `pipeline.run` returns,
  before baking starts (geometry-first).
- **No fake intermediate images**: TRELLIS latents are not cheaply decodable
  per-step (decode = the expensive part), so we do NOT stream per-step preview
  renders for geometry. Mage-Flow could decode intermediate latents but at 4
  steps total it is not worth the VAE passes; the final image is pushed as an
  artifact as soon as it exists.
