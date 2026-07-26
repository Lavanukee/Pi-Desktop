# Bobble 3D studio — UI/UX parity audit + end-to-end pipeline verification

Branch `worktree-agent-a26d4672deb83c816`, based on `e7eae80` (current `main`).

Everything below was produced by **driving the built app**, not by reading code. Four
Playwright probes and one end-to-end pipeline probe generated the evidence; all five are
committed, so every claim can be re-checked.

| probe | what it produces |
|---|---|
| `apps/desktop/tests/e2e/tripo-parity-audit.mjs` | chat UI + studio screenshots in the same window, `getComputedStyle` geometry/type for equivalent controls on both sides, 3 flavors × light/dark, purple scan |
| `apps/desktop/tests/e2e/tripo-parity-audit2.mjs` | resolved focus outlines while tabbing, count of elements actually painted `--pd-accent-primary`, scroller metrics |
| `apps/desktop/tests/e2e/tripo-parity-audit3.mjs` | cropped scrollbar shots per flavor (scrollbars are `::-webkit-scrollbar` pseudo-elements, invisible to `getComputedStyle`) |
| `apps/desktop/tests/e2e/tripo-parity-audit4.mjs` | **new** — whole-tab-order focus sweep, `corner-shape` support + resolved shape per surface, Escape on every dismissable layer, reduced motion under real media emulation, WCAG contrast × 6 themes, accent density on the Image panel |
| `apps/desktop/tests/e2e/tripo-e2e-pipeline-probe.mjs` | **new** — runs EVERY pipeline stage against the REAL engines through the REAL UI, screenshots each, writes `report.json` |

```bash
pnpm --filter @pi-desktop/desktop build          # the probes load dist
export AUDIT_APP_ROOT=$PWD/apps/desktop AUDIT_OUT=/tmp/audit
node apps/desktop/tests/e2e/tripo-parity-audit.mjs
node apps/desktop/tests/e2e/tripo-parity-audit2.mjs
node apps/desktop/tests/e2e/tripo-parity-audit4.mjs
TRIPO_E2E_OUT=/tmp/pipe node apps/desktop/tests/e2e/tripo-e2e-pipeline-probe.mjs   # ~25 min
```

Screenshot filenames below (`before/…`, `after/…`, `pipeline/…`) are the probes' own outputs
under `AUDIT_OUT` / `TRIPO_E2E_OUT`. They are not committed — the commands above regenerate
them, which is the point: every claim here is a re-runnable measurement rather than an
attachment you have to take on trust.

---

## Summary

The studio is good tool design and, as of this branch, the pipeline behind it genuinely
works: **nine of ten stages ran end to end on real models with real engines.** Two things
the brief listed as known-broken turn out to be **stale** — retopology is clean, and the quad
wireframe really does draw quads.

The problems were of two kinds.

**Parity** was a structural trade stated in `primitives.tsx`: the studio hand-rolls its
primitives "so the workspace can match the reference's density/geometry exactly while still
drawing every color from the pd token set". Colors *did* flow through tokens; geometry, type,
motion and focus never did. That is the previous audit's diagnosis and it still held on
today's `main` — all of it re-measured below.

**Function** was invisible to every UI check we had. Running the pipeline for real found that
the studio's pipeline-stage state machine was never wired to the engine, that a confirmed
humanoid rig was recorded as non-humanoid, and that a purple was shipping in a place no DOM
scan can look. None of these are visible from the code alone or from a screenshot alone.

---

# PART 1 — UI/UX parity

## Method

Both surfaces are measured in the **same window**, entered through the sidebar Modalities row,
so the entry path is exercised too. Every number is `getComputedStyle` or a resolved bounding
box, not a judgement.

## Carried forward from the previous audit — all re-verified on `e7eae80` first

The previous audit ran at `ce54371` and never merged, so none of it was present on today's
`main`. I re-measured each finding on pristine `main` before carrying the fix forward. **All of
these still reproduced.** Two of its findings were stale and are not repeated (the `pnpm test`
red claim, fixed by `3b91d09`; `tripo-pipeline-probe.mjs`, which no longer exists).

| # | finding, measured on `e7eae80` | after |
|---|---|---|
| 1 | **Studio drew Chromium's focus ring.** 14/14 sampled controls `outline: auto 1px rgb(153,200,255)` @0 vs the chat's `solid 2px rgb(41,151,255)` @2px | **0/40** UA rings across the whole tab order |
| 2 | **Buttons were a different product's shape.** `.tp-export-cta` / `.tp-pill-btn` / `.tp-back-btn` / `.tp-segmented` / `.tp-segment` all `border-radius: 9999px`; `.pd-btn` is **10px**. `--pd-radius-full` used **57×** | `.tp-export-cta` **10px**, `.tp-segmented` **13px**, `.tp-segment` **10px**, `.tp-back-btn` / `.tp-pill-btn` **10px** — exactly `.pd-btn` / `.pd-segmented`. `--pd-radius-full` **57 → 37** |
| 3 | **Top bar taller and lighter than the app's.** `.tp-topbar` h=**52** bg `rgb(30,30,33)` vs `.pd-topbar` h=**48** bg `rgb(21,21,23)` | h=**48**, bg `rgb(21,21,23)` — identical |
| 4 | **Switch off spec.** `.tp-toggle` h=**21**, filled `rgb(10,132,255)`, where `controls.css` specifies 36×20 and deliberately fills with `--pd-text-link` "NOT the inverted mono" | h=**20**, fill `rgb(41,151,255)` |
| 5 | **`--pd-text-link` used as decoration.** `.tp-accordion-sub` ("Face limit · topology · symmetry") stayed BLUE under claude and codex while everything else re-tinted — `before/C-studio-claude-dark.png`, `before/C-studio-codex-light.png` | `--pd-text-muted` |
| 6 | **No accent hierarchy.** elements painted `--pd-accent-primary` ≥8×8px: empty **3**, loaded **5**, and the Image panel showed **nine** accent fills at once (`pipeline/03-image-to-3d.png`) including two identical "Export" pills at 3160px² each | **2 / 2 / 2**; Image panel measured **2** (one footer CTA + the top-bar Export) |
| 7 | **Title Case marketing voice.** empty state read "Ready For A New 3D Model?" at 30px | "No model yet" at `--pd-font-size-title` |
| 8 | **Studio scrollers used the UA scrollbar** (`.tp-panel-scroll`, `scrollbar-width: auto`) | carries `.pd-scroll` |
| 9 | **Phantom token.** `var(--pd-accent-primary-fg, #fff)` — 0 occurrences in `themes.css`, so it silently always used the fallback | `--pd-text-on-accent`; 0 occurrences remain |
| 10 | **Off-token status colors + hardcoded letterbox.** `#e0705a` ×6, `#3ea55f` ×3, `#26262c` behind every motion video (a dark slab under both light modes) | status tokens; `--pd-bg-inset`. Live hex literals **25 → 20**, and every remaining one is deliberately theme-invariant: `#fff`/`#000` as `color-mix` endpoints (7), the capability-loop illustration palette (6, `.cl-img-sky` etc — it depicts a sky and a hill), and the 8 segment part colours that must match what the engine bakes into the mesh. Three more `#…` strings survive only inside explanatory comments |
| 11 | **Export dialog occluded a control it sat on.** `position: absolute; right: 22px; bottom: 66px`, no scrim, parked over the render-mode bar — Wireframe was unreachable while it was open | centered, scrimmed, `role="dialog" aria-modal`, dismisses on scrim click and Escape |
| 12 | **Wireframe lied about its affordance.** it sat in the exclusive Clay/Textured/Normal strip wearing the same `.tp-mode-btn`, advertising a fourth mode that is an independent overlay | `role="switch"` + state dot, same strip, same testid (`pipeline/06b-retopo-wireframe.png`) |
| 13 | **Storage names leaked into the UI.** motion labels rendered `angry_01`, `sad_01`, `dance_01` (`store.ts` did `name: a.id`) | humanised |
| 14 | ~1000 lines of dead clone vestige (`.tp-credits*`, `.tp-account-*`, `.tp-bell-*`, `.tp-upgrade-*`…) with zero `.tsx` references | 18 rule blocks removed |

## New this round — things passes 1–3 could not see

**15. Portaled menus kept the UA focus ring.** The focus grammar the previous audit adopted is
`.tp :where(button, input, …)`. But `MenuAnchor` and `Hint` render through a **portal into
`document.body`** (`primitives.tsx`), so every menu item in every studio dropdown and every hint
bubble sat outside the selector and kept Chromium's ring — the fix had a hole exactly where the
app escapes its own DOM. `.tp-popover-portal` joined the selector. *Fixed.*

**16. The codex squircle skipped the studio — now VERIFIED, not guessed.** The previous audit
flagged that `base.css` scopes `corner-shape: superellipse(1.5)` to an enumerated list of `.pd-*`
primitives with no `.tp-*` class in it, then declined to act because it could not tell whether
this Chromium implements the property. **It does:** `Chrome/150.0.7871.47`,
`CSS.supports('corner-shape','superellipse(1.5)') === true`. So under codex every chat surface
had superelliptical corners and every studio surface had circular ones — while codex *also*
scales its radii ×1.25 precisely because the corners are meant to be superelliptical, which
without the corner shape just reads as bigger circles. Measured after the fix:

```
studio (codex)  tp-generate-btn superellipse(1.5)   tp-card     superellipse(1.5)
                tp-segmented    superellipse(1.5)   tp-dropzone superellipse(1.5)
                tp-rail-item    superellipse(1.5)
chat   (codex)  pd-btn          superellipse(1.5)   pd-composer superellipse(1.5)
```

*Fixed*, in `tripo.css` rather than by appending `.tp-*` to `base.css` — `packages/ui` should not
gain knowledge of the desktop app's studio classes.

**17. Escape missed a layer.** The studio's global handler peels back `openMenu` then `modal`. The
state-machine editor is neither — it is `graphOpen`, and `.tp-graph` is an opaque full-viewport
overlay at `z-index: 100`. It was the only dismissable layer in the app Escape did not reach; you
had to hunt for the ✕. Measured after: `popover ✓ exportDialog ✓ helpModal ✓`. *Fixed.* (The
state-machine case needs a rigged humanoid to reach, so `audit4` reports it as gated; the pipeline
probe covers that path.)

**18. Asset thumbnails were black slabs in light mode.** `captureThumb` renders to a target on an
`alpha: true` renderer with no clear colour — the capture is genuinely transparent — and then
encoded it with `toDataURL('image/jpeg')`. **JPEG has no alpha**, so Chromium flattened it onto
black. Every asset card was a black square: invisible in dark mode, glaring under bobble-light and
codex-light (`before/C-studio-bobble-light.png`, `before/C-studio-codex-light.png`). PNG keeps the
alpha, and `.tp-asset-card` already paints a token-derived radial gradient underneath, so
thumbnails now re-tint with the theme for free. Size is a non-issue: `viewer-io` writes
`thumb: null` to localStorage on purpose, so these are session-only. *Fixed* — compare the asset
grid in `pipeline/05-segmented.png` (before) with `pipeline-after/07-textured.png` (after).

**19. Reduced motion could not reach the videos.** The motion-library cards auto-play a clip on
hover. CSS cannot stop a `<video>`, so the media query in `tripo.css` was structurally unable to
cover them. Moved into the hover handler; under `reduce` the card holds its poster frame, which is
a mid-motion still and still says what the clip is. Measured with Playwright's real media
emulation: **0 elements still animating** under `prefers-reduced-motion: reduce`. *Fixed.*

**20. Download cards described the wrong model.** The headline blurb was keyed on **role**, so
models sharing a role shared a sentence — and three were then flatly wrong, each sitting directly
above a catalog `note` that said the opposite:

| model | headline it showed | its own note |
|---|---|---|
| Mage-Flow Edit | "Generate images from text" | "Edit a generated image from an instruction" |
| Cube 3D | "an image or a text prompt" | "Text → 3D shape directly, **no image step**" |
| SkinTokens | "Fit a **humanoid** skeleton" | "predicts a skeleton … for an **arbitrary** mesh" |

A download card is the one place a 17 GB commitment gets explained. *Fixed* with a per-model
override; the proper home is a `blurb` field on `Gen3dModelSpec`, which crosses the IPC contract.

**21. Purple — in the one place a DOM scan can never look.** See Part 2, P0-4. The hue scan
returns **0 hits across all six flavor × mode combinations**, before and after, and that was
always true and always beside the point: `cubepart_worker.py` baked `#9b59b6` (hue 283°) into the
exported mesh as part colour 4, and `DEFAULT_PARTS` has five entries, so *every* default
segmentation painted a purple part. *Fixed*, with a guard test.

## Also fixed — in the chat UI, explicitly in scope

**22. `.pd-project-chip` and `.pd-menu-trigger` drew Chromium's ring.** Verified by tabbing the
real app at `e7eae80` — of every control in the chat UI, exactly these two:

```
BUTTON  pd-project-chip                    outline=auto 1px rgb(153,200,255) off=0px
BUTTON  pd-menu-trigger pd-effort-trigger  outline=auto 1px rgb(153,200,255) off=0px
BUTTON  pd-sidebar-row                     outline=solid 2px rgb(41,151,255) off=-2px
BUTTON  pd-btn pd-btn--ghost …             outline=solid 2px rgba(0,0,0,0)   off=2px
```

`.pd-menu-trigger` is the shared Popover/DropdownMenu/Select trigger, so it went in `base.css`
beside `.pd-focusable` — one definition, not a third copy. `.pd-project-chip` already owns the
`transition` shorthand in `packages/canvas`, so bolting `.pd-focusable` on would have made two
rules fight over one property; its own rule gained the outline and extended its transition, which
keeps the hover fade *and* animates the ring. **Chat UA rings: 2 → 0.**

## Build health

**`pnpm typecheck` was RED on `main`** and nobody would have noticed, because `pnpm test` is
green:

```
packages/gen3d-engine/src/catalog.ts(208,5): error TS2322: Type '"skintokens"' is not
assignable to type '"binary" | "mageflow" | "cubepart" | "paint" | "trellis" | "meshtools"'
```

`catalog.ts:208` sets `env: 'skintokens'` on the SkinTokens model and the union it has to satisfy
never gained the member. `'skintokens'` is correct, not a typo — `python/engine/envs.py` branches
on `env_kind == "skintokens"`. *Fixed*; `pnpm typecheck` is green across all 24 packages.

`pnpm test`: **767/767 TS + 3/3 Python green on entry, 767/767 + 6/6 on exit** (three new Python
tests guard the part palette). `pnpm --filter @pi-desktop/desktop build` is green.

**`tripo-ui-probe.mjs` — the studio's slot in the `pnpm e2e` chain — was also RED on `main`,**
on four independent stale assertions, none of them mine:

| assertion | why it was stale |
|---|---|
| download panel lists `Hunyuan Paint` | removed from the catalog; the texture stage is a TRELLIS re-bake with no separate paint model |
| `tp-asset-imported-1` | asset ids became `imported-<session>-<n>` in `asset-registry.ts` |
| retopo names `AutoRemesher` | `RETOPO_MODEL` is `QuadriFlow`; AutoRemesher is the fallback and keeps only the model id |
| animate panel names `ARDY` + has ≥8 motion videos, then authors a motion and builds a state machine | all of it is now behind the rig gate jedd asked for — an unrigged model correctly offers none of it |

Fixed, including rewriting the animate block to assert **the gate** (nothing about motion is
offered before a real rig) rather than the behaviour the gate replaced. The rigged path is
covered end to end, on real engines, by the pipeline probe. `tripo-ui-probe` now passes.

`round14-composer-probe.mjs` is red for the same reason and I did **not** fix it — it waits on
`[data-testid="thread-status"]`, which `grep -rn thread-status apps/desktop/src` shows no longer
exists anywhere. That is outside the studio and outside this audit; flagging it so the `pnpm e2e`
chain does not look green-except-for-3D when it is not. `chat-ui-probe` and `settings-probe` both
pass, so the chat-side CSS changes here are clear.

---

## What still needs a design decision — NOT fixed

Ranked by what it costs the user.

**D1. Segmentation is a 13-minute operation whose progress goes silent for five of them.**
`cubepart_worker.py` emits progress through the denoise (`… (30/30)`), then runs the mesh
extraction with no emission at all. Measured: the readout sat on
`"Deciding which surface belongs to which part (30/30) · 12m 36s"` for **over five minutes** while
the worker was genuinely busy (7 GB RSS, extracting). The ticking elapsed counter is the only sign
of life. One `progress()` call before the extraction fixes it; the wording is a product call.

**D2. Type still runs below the app's floor.** `--pd-font-size-caption: 12px` is the smallest the
rest of the app renders. `tripo.css` carries **27** sub-12px declarations (down from 30): 8px ×1,
9px ×4, 9.5px ×1, 10px ×5, 10.5px ×2, 11px ×7, 11.5px ×7. Two fail WCAG AA in the contrast sweep —
the gizmo axis balls `.tp-axball-y` / `.tp-axball-z` at 8px measure **3.36:1 and 3.62:1** under
codex-light (need 4.5). Raising the floor is a density decision for a tool surface, so I measured
it rather than changing it.

**D3. `.tp-workspace-label` "3D Workspace" is redundant and fails contrast.** It sits immediately
right of "Bobble 3D" and adds nothing; it measures **3.33:1** under bobble-light (needs 4.5).
Deleting it fixes both. It carries a testid, so it is someone's assertion.

**D4. Two accent CTAs on the Image panel.** "Generate Image" (footer) and "Make 3D" (inline) are
both accent-filled. They are genuinely different commitments, so which is primary is a product
call, not a token fix.

**D5. Download-panel hierarchy is inverted.** Each card carries its own accent Download button and
the foot carries "Download all · 83.9 GB" as the largest, loudest control on screen — the
by-far-most-expensive action is the most prominent one
(`before/B03-studio-download-panel-dark.png`).

**D6. Capability-loop thumbnails read as broken images.** The TRELLIS card's loop is a near-empty
dark rectangle with one dot; Mage-Flow's is a small grey square (same screenshot). They convey
nothing at card size.

**D7. `Segmented` uses `role="tablist"` / `role="tab"` with no tabpanels.** Resolution, Topology,
Symmetry, Texture size and Shape model are radio groups. A screen reader announces "tab 1 of 3"
and users expect arrow keys to move into a panel. `radiogroup` / `radio` / `aria-checked` is
correct, but doing it properly means roving tabindex — a behaviour change I did not want to make
in a visual pass.

**D8. Menu and row density diverge from the app.** `.tp-menu-item` is h=36 / 12px text against the
app's `--pd-row-height: 32px` / 14px body. Defensible for a tool surface; noted, not "fixed".

**D9. Static info rendered as interactive-looking cards.** "Model / CubePart", "Target / geometry"
sit in bordered cards identical to the genuinely clickable "Geometry" and "AI Model" cards.

**D10. Viewport float-toolbar grouping is arbitrary.** Three buttons in one pill, then two more in
separate solo pills, with no rule distinguishing them.

**D11. Class names are semantically wrong.** "Analyse shape & rig" uses `.tp-retry-btn`, "Add
parameter" uses `.tp-upload-btn`, "Open State Machine" uses `.tp-generate-btn`. A rename is a
refactor, not a visual pass.

**D12. `data.ts` contradicts itself about the rig engine.** Its header says rigging is "NOT
SkinTokens: SkinTokens needs a ≥14 GB NVIDIA GPU … cannot run on Apple Silicon at all", while
`RIG_MODEL = 'SkinTokens'` two screens down, `catalog.ts` says it "runs here in fp32 on MPS in
~76s", and the pipeline run measured SkinTokens rigging a real mesh in **73s**. The comment is the
stale one, but which engine the UI should *name* is jedd's call.

## Unresolved measurement

`audit4`'s contrast sweep reports `.tp-segment` ("512") at **1.00:1** under both codex modes.
`after/S1-codex-studio.png` shows the label plainly legible, and `.tp-segment` has no `::before`
fill layer that would explain a walker miss. I could not reconcile the two, so I am recording it
as an unexplained probe result rather than claiming either a bug or a clean bill.

---

# PART 2 — end-to-end pipeline verification

Every stage below was run against the **real engines** through the **real UI** on this machine
(M5 Pro, 24 GB). Heavy work is serialised by construction: the engine runs one job subprocess at a
time, and the probe never dispatches a second before the first reports `end`.

**Two runs are reported.** Run A is `main`'s behaviour (`e7eae80` + the parity fixes, before the
functional fixes). Run B re-runs on this branch, with texturing moved ahead of segment/retopo so
it bakes from the generation's own output.

## Status per stage

| stage | engine | verdict | evidence |
|---|---|---|---|
| Image generation | Mage-Flow Turbo | **WORKS** — 23s / 26s | `01-image-generated.png` — a real product photo of a toy robot, from the prompt |
| Image EDIT before 3D | Mage-Flow-Edit | **WORKS** — 20s / 32s | `02-image-edited.png` — "make the robot bright orange" applied; lands as a second version with a Previous/Next stepper, original preserved |
| Image → 3D | TRELLIS-2 | **WORKS** — 104s / 98s at 512 | `03-image-to-3d.png` — 300,000 faces / 267,610 verts, recognisably the robot, arms/legs/head/antennae intact |
| Text → 3D | Cube3D | **WORKS** — 95s | `04-text-to-3d.png` — "a simple wooden stool with three legs" → 314,048 faces, a correct three-legged stool |
| Texturing | TRELLIS-2 re-bake | **WORKS on the generation's own mesh** — 26s. **FAILS after a retopo** | `pipeline-after/07-textured.png` — full PBR orange robot. See P1-1 |
| Segmentation | CubePart | **ENGINE WORKS** (808s, five named part meshes) — **UI SHOWED NOTHING** on `main`; fixed here | see P0-1 |
| Retopology | QuadriFlow | **WORKS** — 17s, 300,000 tris → 27,724 quads. **The "melted blob" does NOT reproduce** | `06-retopo.png`, `06b-retopo-wireframe.png` |
| Skeleton overlay | — | **WORKS** | `10-skeleton-overlay.png` |
| Rigging | SkinTokens | **WORKS** — 73s / 76s, 14 joints over 265,779 vertices, shape probe humanoid=true. The result was recorded as NON-humanoid on `main`; fixed | `09-rigged.png`, P0-3 |
| Animation | ARDY | **PARTIAL, honestly** — 16 bundled clips, state machine builds and exports; **no motion is generated locally** | `11-animate-panel.png`, `12-state-machine.png`, P1-2 |

## The two "known broken" items are STALE

**(a) "Retopology destroys the model — QuadriFlow returns a melted blob with holes."**
**Does not reproduce.** 300,000 triangles → **27,724 quads in 17 seconds**, and `06-retopo.png`
shows a clean, well-formed remesh with the silhouette, limbs, head and antennae all intact. The
melted-blob behaviour belonged to **AutoRemesher**, which `retopo_worker.py`'s own header still
describes as returning "a mesh full of holes"; QuadriFlow is now the primary path
(`~/.cache/pi-desktop/gen3d/bin/quadriflow`, present on this machine) and AutoRemesher is the
fallback.

**(b) "The viewport says Topology: Quad while the wireframe draws triangles, which is inherent to
glTF storing only triangles."** **Does not reproduce — the premise has been engineered around.**
`retopo_worker.py` writes the real polygon edge list into `meshes[].extras.pd_topology.wireEdges`
(glTF can only *store* triangles, but `extras` is a side channel), and `Viewer3D.readPdTopology`
reads it, so `buildWireOverlay` draws those polygon edges instead of `WireframeGeometry`.
`06b-retopo-wireframe.png` shows an unmistakable quad grid beside a stats panel reading
`Topology: Quad · Faces 27,724 · Vertices 27,803`. The two agree.

## P0 — functional defects the run exposed, all fixed on this branch

*Verification status is stated per item. P0-3 and P0-4 are confirmed by a re-run on the fixed
build; P0-1 and P0-2 are fixed and typecheck/build/test-green, and the re-run that confirms them
is noted where it stands.*

**P0-1. The pipeline-stage state machine was never connected to the engine.**
`useTripoStore.runStage` is the only writer of `pipelineStage`, of the History list, and of the
texture stage's switch to Textured mode — and **nothing called it**.
`grep -rn runStage apps/desktop/src` finds only the gen3d *engine* dispatch that shares the name.
So `pipelineStage` never left `'mesh'`, every `stage === 'segment' | 'retopo' | 'rig'` branch in
`Viewer3D` was dead on the real engine path, and the History tab stayed empty after five real
jobs.

What that cost: a **13.5-minute** CubePart run finished successfully, wrote five named part meshes
with per-part colours, and **changed nothing on screen**. Probe line:
`segmentation (CubePart) — 0 part(s) listed in the panel (808s)`; `05-segmented.png` is the same
white model it started with, next to an empty Parts list.

**P0-2. The segment view would have painted over the real answer.** With P0-1 fixed, the segment
branch would have run its bundled-sample path — three height bands and a hardcoded
`['Top','Middle','Base']` — on top of a genuine five-part result. A real `parts.glb` is one named
mesh per part carrying its own `COLOR_0` (verified on the run's output: nodes `part_00_main_body`
… `part_04_right_part`, every primitive `[POSITION, COLOR_0]`, no materials), so the viewer now
uses the engine's own colours and names and keeps the demo path only for the bundled sample. The
part-list comparison also moved from length to value — the old check could not see one 3-part list
replaced by another.

**P0-3. A confirmed humanoid rig was recorded as non-humanoid.** One run produced both of these:

```
rigging (SkinTokens) — rig status shown, shape probe said humanoid=true (73s)
animation            — motion library hidden: the rig did not read as humanoid
```

The shape probe (`rig_worker --probe-only`) measures humanoid-ness; the rig that follows is a
**different job**, and when SkinTokens is installed `jobs.py` routes it to `skintokens_worker` —
which emits this:

```python
emit(event="probe", stage=STAGE, humanoid={
    # SkinTokens predicts an arbitrary skeleton rather than fitting a
    # humanoid template, so there is no humanoid/non-humanoid verdict
    # to make — report what it actually produced.
    "isHumanoid": False, "confidence": 1.0,
    "reasons": [f"{len(asset.joints)} joints predicted by SkinTokens"], })
```

A **non-answer shaped like an answer**, arriving on the same channel as the real measurement — so
it silently overwrote what the probe measured and the user confirmed. The produced version
recorded `humanoid: false`, and the panel replied *"Animation presets are hidden, this model isn't
humanoid"* to a user who had just pressed **"Rig as humanoid"** on a high-confidence reading. That
hid the **entire motion half of the studio** behind a rig that had succeeded.

Worth noting how this was found: my first fix carried the confirmed verdict into the rig job, and
the re-run **still failed** — which is what pointed at the overwrite rather than at an absence.
A confirmed verdict now lives in its own map that the engine's emission cannot touch (UI-side
only; stripped before the IPC call, since `gen3d:stage`'s contract has no such field). Verified by
re-running: `animation — 16 bundled sample clips, state machine built 2 node(s)`.

**P0-4. Purple, where no DOM scan could see it.** CubePart bakes per-part colours into the exported
GLB, so the palette **is** interface. Entry 4 was `(155, 89, 182)` = `#9b59b6`, **hue 283°**.
`DEFAULT_PARTS` has five entries, so every default segmentation painted a purple part. The palette
also shared nothing with `.tp-part-swatch` — its own legend — so the Parts row for a part the
viewport drew red showed an orange dot, and there was no rule at all past part 3, leaving the fifth
swatch blank. One palette now, no hue in 255–320°, guarded by
`packages/gen3d-engine/python/tests/test_part_palette.py` (no purple / covers `DEFAULT_PARTS` /
matches the CSS legend).

## P1 — found, not fixed

**P1-1. Texturing works on a generated mesh but fails after a retopo.**

```
Run A (texture last, after segment + retopo):
  FAIL — "This model has no colour data to texture from — the Texture stage re-bakes
          models generated here, and this one was imported."
Run B (texture on the generation's own output):
  PASS — textured version produced (26s)
```

The mesh was generated by TRELLIS, not imported, so the message is wrong on its face. The engine
looks for `voxels.npz` beside the mesh **or** beside `sourcePath` (the asset's root version) — and
the root's directory **does** contain `voxels.npz` (verified on disk:
`~/.pi/desktop/sandbox/gen3d/<job>/{geometry.glb,voxels.npz}`). So `sourcePath` is being lost
somewhere between `GenPanel` and `_find_voxels`. I isolated *when* it happens but not *where*, so I
am not claiming a root cause. Re-runnable:
`TRIPO_E2E_STAGES=image,img3d,retopo,texture node apps/desktop/tests/e2e/tripo-e2e-pipeline-probe.mjs`

**P1-3. The app died mid-segmentation, once.** Run B's renderer went away ~8m47s into a CubePart
segmentation (`Target page, context or browser has been closed`); Run A completed the same stage
at 808s. Most likely memory: `cubepart_worker.py`'s own comment records the extraction grid as the
peak ("fp16 finished all 30 steps at 25.4 GiB and then asked for another 6.10 GiB to decode"), and
this box has 24 GB with another Bobble instance and a browser resident. I saw it once out of two
attempts and did not reproduce it deliberately, so I am reporting it as an observation, not a
diagnosis. The probe now survives a dead window rather than discarding the verdicts it had already
earned.

**P1-2. Animation is honestly unavailable, and the panel says so.** `tp-generate-motion` is
permanently disabled and reads *"Generate Motion — ARDY unavailable locally"*, beside a notice
explaining ARDY is Linux + NVIDIA only. The motion library is **bundled sample clips**, labelled as
such. So: rigging is real, the state machine is real and exports real JSON, and **no motion is
generated on this machine.** That is a wiring gap rather than a defect — but "animation works"
would be the wrong thing to tell anyone.
