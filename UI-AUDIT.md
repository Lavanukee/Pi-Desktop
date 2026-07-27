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

## The opinionated version, ranked by impact

If I were choosing what to spend the next day on, in this order:

1. **Make long stages account for themselves.** The single worst moment in the product is
   watching a 13-minute segmentation sit on the same sentence for five of them. Everything else
   here is a papercut by comparison, and it is one `progress()` call plus a decision about what
   to say (D1). The same instinct covers the ~90-second silent stretches inside TRELLIS.
2. **Decide what the studio is allowed to shout.** Accent density is fixed by measurement now
   (2 per panel), but the *rule* is mine, not the product's. The download panel still makes an
   84 GB action the loudest thing on screen (D5), and the Image panel has two primaries (D4).
   Write the rule down once and the rest follows.
3. **Raise the type floor or say why not.** 27 declarations below the app's 12px caption, two of
   them failing WCAG AA (D2). A tool surface can justify density — but "we chose 10px here" and
   "nobody noticed this drifted" look identical in the CSS, and only one of them is a decision.
4. **Let the studio show what it just did.** With the stage machine reconnected, the panels can
   finally reflect real results. That opens obvious follow-ups nobody could take before: switch
   to a render mode that shows the part colours after a segment, put the real quad/tri split in
   the History row, show the rig's joint count next to the skeleton toggle.
5. **Delete the vestigial chrome.** "3D Workspace" beside "Bobble 3D" (D3), the capability-loop
   thumbnails that read as broken images (D6), the info-as-clickable-cards (D9). Small, and each
   one is a thing a new user has to work out and then ignore.

What I would *not* change: the density of the menus and rails (D8), the split of the workspace
into rail / panel / viewport / assets, and the honesty of the engine-download flow. Those are the
parts that read as a real tool, and the temptation to "make them match chat" would cost more than
it returns.

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
| Segmentation | CubePart | **WORKS** — 807s. The engine always did; on `main` the **UI showed nothing at all**. Fixed and re-verified: 5 named parts listed and painted | `05-segmented.png` (before: same file, run A) |
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

*All four are fixed AND confirmed by re-running the real pipeline on the fixed build:*

| | verified by |
|---|---|
| P0-1 pipeline stage never connected | `segmentation (CubePart) — 5 part(s) listed in the panel (807s)`, against `0 part(s) (808s)` before |
| P0-2 segment view painted over the real answer | the same run's `05-segmented.png`: five rows reading **Main body / Top part / Bottom part / Left part / Right part** — the engine's own names, not `Top/Middle/Base` — with swatches matching a mesh painted in the engine's own per-part colours |
| P0-3 humanoid verdict overwritten | failed, re-diagnosed, re-fixed, re-ran: `animation — 16 bundled sample clips, state machine built 2 node(s)` |
| P0-4 purple in the baked palette | 3 guard tests (`6/6 passed`), and the segmented mesh above shows no purple part |

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

Same probe, same model, on the fixed build: `segmentation (CubePart) — 5 part(s) listed in the
panel (807s)`. Identical engine time; the difference is entirely that the result now arrives on
screen.

**P0-2. The segment view would have painted over the real answer.** With P0-1 fixed, the segment
branch would have run its bundled-sample path — three height bands and a hardcoded
`['Top','Middle','Base']` — on top of a genuine five-part result. A real `parts.glb` is one named
mesh per part carrying its own `COLOR_0` (verified on the run's output: nodes `part_00_main_body`
… `part_04_right_part`, every primitive `[POSITION, COLOR_0]`, no materials), so the viewer now
uses the engine's own colours and names and keeps the demo path only for the bundled sample. The
part-list comparison also moved from length to value — the old check could not see one 3-part list
replaced by another.

Re-verified on a fresh CubePart run: the Parts list reads **Main body · Top part · Bottom part ·
Left part · Right part** — CubePart's own `DEFAULT_PARTS`, not the demo's `Top/Middle/Base` — with
each swatch matching the colour that part is actually painted in the viewport. Three things that
disagreed now agree: the mesh, the legend, and the engine.

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

## P1 — found by the run

*P1-1 was left un-root-caused by the audit and has since been fixed; P1-2 and P1-3 still stand.*

**P1-1. Texturing works on a generated mesh but fails after a retopo. — ROOT-CAUSED AND FIXED.**

```
Run A (texture last, after segment + retopo):
  FAIL — "This model has no colour data to texture from — the Texture stage re-bakes
          models generated here, and this one was imported."
Run B (texture on the generation's own output):
  PASS — textured version produced (26s)
```

The above was the symptom. `sourcePath` was indeed lost — **not** at a TypeScript boundary, and not
in the sidecar's HTTP hop. Every one of those carried it correctly: `GenPanel` sets
`sourcePath: loaded.versions[0]?.diskPath`, `runStage` spreads it into the `gen3d:stage` payload,
`gen3d-main.ts` POSTs the request object wholesale, and `server.py` hands the parsed body to
`start_stage` intact.

It was dropped by **one line inside `start_stage`** (`packages/gen3d-engine/python/engine/jobs.py`),
which filtered the request through a hardcoded key list before handing it to `_run_stage`:

```python
options = {k: body[k] for k in ("targetQuads", "adaptivity", "probeOnly", "requireHumanoid") ...}
```

`sourcePath` was never added to that tuple. So `options.get("sourcePath")` in `_run_stage` was
**always `None`**, `_find_voxels` only ever checked beside the mesh, `--voxels` was never passed,
and the worker fell back to looking for `voxels.npz` beside the retopo output — where it has no
reason to be.

This is the SAME defect class as the `face_budget` bug this audit's `test_generate_args.py` was
written for: a value read in one method and used in another across a `threading.Thread` boundary,
with nothing but an easily-forgotten list connecting them. The difference is that `face_budget`
raised `NameError`; this one silently substituted `None` and produced a **confident wrong
explanation** instead of a crash — which is why it survived a full audit. The key list is now the
named `STAGE_OPTION_KEYS`, and `tests/test_stage_args.py` asserts by introspection that it covers
every key `_run_stage` reads, so the next option cannot be dropped the same way. (`faceBudget` was
missing from it too, and is now listed — the stage path still does not *send* one, so re-baking
continues to use the worker's own default density.)

**The message also lied.** It asserted provenance the worker cannot observe — it knows only that a
file is absent. It now names the directory it searched and stops guessing:

> No colour data to texture from — the Texture stage re-bakes from the voxel colour field the
> generation saved, and there is none in `<dir>`. A model imported from a file never has one; for a
> generated model the colours stay in the job folder that produced it.

**The probe could not reproduce this, and that is fixed too.** The command recorded above ran the
stages in the order they appear in `tripo-e2e-pipeline-probe.mjs`, not the order given —
`TRIPO_E2E_STAGES=…,retopo,texture` therefore ran *texture first*, which is Run B, the case that
always passed. The probe now runs the caller's order, so the failing chain is genuinely re-runnable:

```bash
TRIPO_E2E_STAGES=image,img3d,retopo,texture node apps/desktop/tests/e2e/tripo-e2e-pipeline-probe.mjs
```

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

---

# PART 3 — Decisions implemented (D1–D12)

The twelve open calls above are decided and built. jedd delegated the calls; every one below is
followed by the measurement that closed it.

**The evidence is a new probe, not this table.** `apps/desktop/tests/e2e/tripo-decisions-probe.mjs`
drives the built app and reports PASS/FAIL with a number per decision, writing `decisions.json` so a
before/after diff is one `diff` away. It is now the last link in `pnpm e2e`, so these decisions
cannot silently rot.

```bash
pnpm --filter @pi-desktop/desktop build     # the probe loads dist
DECISIONS_OUT=/tmp/dec-after node apps/desktop/tests/e2e/tripo-decisions-probe.mjs
# and for the "before" column, from the parent commit:
DECISIONS_BASELINE=1 DECISIONS_OUT=/tmp/dec-before node apps/desktop/tests/e2e/tripo-decisions-probe.mjs
```

Baseline run: **11 of 11 DOM-visible decisions FAIL**. After: **11 of 11 PASS.**
D1 and D12 have no DOM surface and are covered by
`packages/gen3d-engine/python/tests/test_cubepart_progress.py` (4 new tests) and by `data.ts`'s
header respectively.

| # | decision | before → after (measured) |
|---|---|---|
| D1 | Segmentation reports its extraction | **silent** → phase label + one named event per part |
| D2 | Type floor = 11px; the two AA failures fixed | **14 sub-11px declarations** (7.5–10.5px) → **0**; axis balls **8px, 3.36:1 / 3.62:1** → **11px, worst 4.94:1 across 6 flavors** |
| D3 | "3D Workspace" deleted | 1 node, 3.33:1 → **0 nodes** |
| D4 | One accent CTA on the Image panel | **2 accent fills** (Generate Image 12,558px² + Make 3D 4,932px²) → **1** |
| D5 | "Download all" demoted | accent-filled **46px / 14px / 12,558px²** → quiet **32px / 12px / 5,871px²** |
| D6 | No capability loops on download cards | **8 loops across 8 cards** → **0** (kept in the "Runs on <model>" hero) |
| D7 | `Segmented` is a real radiogroup | `tablist`/`tab`, `tabindex=0,0,0`, arrows dead → `radiogroup`/`radio`/`aria-checked`, `tabindex=-1,0,-1`, arrows/Home/End move and select |
| D8 | Menus at the app's density | **35px rows @ 12px** → **32px @ 14px** (= `--pd-row-height` / `--pd-font-size-body`) |
| D9 | Static rows are not cards | `1px border + rgb(18,18,20) fill + 10px radius` — identical to the clickable card → `0px border, transparent, 0px radius` |
| D10 | Float toolbar grouped by function | **1 group + 2 orphan pills** → **2 groups, 0 orphans** |
| D11 | Semantic class names | `tp-generate-btn` ×6 / `tp-upload-btn` ×5 / `tp-retry-btn` → **0**; `tp-btn-primary` / `tp-btn-tonal` / `tp-btn-quiet` |
| D12 | `data.ts` corrected about the rig engine | comment claimed SkinTokens "cannot run on Apple Silicon at all" → corrected; `RIG_MODEL = 'SkinTokens'` unchanged |

## The ones with something to say

**D1 — segmentation stops going silent.** `input_to_part_shape()` runs the denoise *and* the mesh
extraction in one call and only the denoise is a tqdm loop, which is why the readout froze on
`"Deciding which surface belongs to which part (30/30)"` for five-plus minutes. The fix wraps the
two seams the pipeline already passes through, so the pipeline call itself is untouched:
`pipe.decode_shape` (an instance attribute shadowing the bound method — this fires the moment the
denoise ends) and `ImplicitFieldCoarseToFineEvaluator.evaluate`, whose per-part "fine" callback
yields exactly one event per part, named:

```
Building part meshes (5 parts)…
Building part meshes — main body (1/5)
Building part meshes — top part (2/5)     … etc
Extracting surfaces from 5 parts…
Writing 5 part meshes…
```

**No percentage, deliberately.** The coarse field pass is one shot over the whole batch and the fine
pass's cost per part is not known until the part has been evaluated, so any denominator would be
invented. One of the four new tests asserts precisely this — that nothing emitted from the
extraction carries `step`/`totalSteps`, and that `(30/30)` never reappears. The failure mode here is
silence, and silence is what a smoke test cannot see, so the tests drive the real wrappers with
fakes (no torch, no weights, no 25-minute run).

**D2 — the floor is a token, not a habit.** `--tp-font-size-min: 11px` on `:root` (not `.tp`:
`MenuAnchor`/`Hint` portal into `document.body`, so anything scoped to `.tp` is invisible to menu
contents). 11px rather than chat's 14px is the density decision the audit asked someone to actually
make; the point of the token is that the next 10px is now a visible choice rather than a drift.
`grep -n 'font-size: [0-9]' tripo.css` is the audit and it returns nothing.

For the axis balls, mixing 24% of `--pd-text-primary` into each status hue pushes the ball *away*
from `--pd-bg-base` in whichever direction the theme needs — darker under light, lighter under dark
— so one rule covers all six flavors rather than six overrides. Lines, balls and negative-axis rings
all draw from `--tp-axis-{x,y,z}` so the gizmo stays one object, and the ball grew 16→18px (centre
held at 38,38, which is all the viewer's per-frame `transform` assumes) to give 11px room.

| flavor | before x / y / z | after |
|---|---|---|
| codex-light | 4.57 / **3.36** / **3.62** | 6.53 / **4.94** / 5.26 |
| claude-dark | 5.67 / 4.52 / 6.06 | 6.89 / 5.62 / 7.27 |
| bobble-light | 5.43 / 4.95 / 6.38 | 6.99 / 6.34 / 7.83 |

**D5 — colour was only half of it.** Demoting the tier is not enough on its own: a full-width footer
button stays the largest control on screen whatever colour it is. `Download all` is shrink-to-fit
and centred now, so the claim is literally true — 46px tall / 14px / accent-filled became 32px /
12px / neutral. Its raw area (5,871px²) is still a hair over a per-card Download (5,757px²) purely
because "Download all · 65.9 GB" is a longer string than "Download · 17.5 GB", which is why the
probe asserts tier, height and type size rather than area: an area assertion would be measuring the
copy, not the hierarchy.

**D7 — this is a behaviour change, and it is the correct one.** `radiogroup`/`radio`/`aria-checked`
plus a roving tabindex: the group is ONE tab stop (checked option `0`, the rest `-1`), Left/Up and
Right/Down move and wrap, Home/End jump, and selection follows focus — these are cheap, instantly
reversible UI choices, so there is nothing to protect the user from. Every `data-testid` and every
class is unchanged; the probe records the control's geometry (width, height, radius, item height,
item font) alongside the keyboard walk to show the visual result did not move. Measured walk from
the checked option: `start@1 → R2 → R0 → L2 → Home@0 → End@2 → Down@0`.

**D8 — menus only.** `.tp-menu-item` now runs `min-height: var(--pd-row-height)` / `padding: 4px
10px` / `gap: 8px` / `font-size: var(--pd-font-size-body)`, matching `.pd-menu-item`; `min-height`
rather than `height` so a label+hint row still grows (56px → 49px). `.tp-menu-item-hint` dropped
from footnote to caption, because it had been *larger* than the label it subtitled. Panels, rails
and inspectors keep their tighter density — that part is a real tool-surface decision; a dropdown
is not.

**D11 — the rename is the point, not the names.** These three classes never described buttons, they
described whichever button came first. They describe the TIER now — `.tp-btn-primary` (accent-
filled, one per panel), `.tp-btn-tonal` (accent-tinted step actions), `.tp-btn-quiet` (neutral
surface) — plus `.tp-btn-inline` as a pure size modifier that works on any tier. Every
`data-testid` is untouched; `tripo-parity-audit4.mjs` was the only probe that reached for a class
name and it was updated.

## Two things found while verifying, both reported rather than quietly fixed

**1. The audit's own "Unresolved measurement" is a probe bug, and it is fixed.** `.tp-segment`
("512") reported **1.00:1** under both codex modes while the screenshot showed it plainly legible.
Cause: under codex `.tp-segmented` carries `rgba(26, 28, 31, 0.02)` — a 2%-alpha tint — and
`audit4`'s `bgOf` stopped at the first background that was not *exactly* `rgba(0,0,0,0)`, discarded
the alpha, and compared `rgb(26,28,31)` text against `rgb(26,28,31)` "background". Exactly 1.00,
every time. `bgOf` now composites translucent layers down to the first opaque one, translucent
*text* is composited over its backdrop too, and the parser handles the `color(srgb …)` serialisation
Chromium uses for anything resolved through `color-mix()` — without which every color-mixed element
(including the new axis balls) silently dropped out of the sweep. `.tp-segment` passes.

**2. Three more AA failures that the broken walker was hiding.** With the contrast maths corrected,
`audit4` reports three studio labels below 4.5:1, all of them `--pd-text-muted` on a raised panel,
all pre-existing and none of them D1–D12:

| element | bobble-light | claude-light | codex-light | codex-dark | claude-dark |
|---|---|---|---|---|---|
| `.tp-accordion-sub` | **2.79** | **3.96** | **3.19** | **4.45** | pass |
| `.tp-model-hint` | **2.79** | **3.96** | **3.19** | **4.45** | pass |
| `.tp-dropzone-sub` | **3.43** | pass | **3.24** | pass | **4.45** |

This is the `--pd-text-muted` token against `--pd-bg-raised`, not a studio-local choice, so fixing
it is an app-wide token decision rather than something to slip into a studio pass. Flagged, not
touched. `bobble-dark` is clean; the sweep is `contrast` in `audit4.json`.

## Build health

`pnpm test` **767/767 TS + 26/26 gen3d-engine TS + 10/10 Python** (four new Python tests for D1).
`pnpm typecheck` green across 24 packages. `pnpm build` green. `tripo-ui-probe` and
`tripo-resize-probe` both pass — the latter still reports no studio column leaving the window from
760px to 1280px. `tripo-ui-probe`'s capability-loop assertion was inverted rather than deleted: it
now asserts the loops are **absent** from the cards, so D6 cannot creep back. `biome check` is
unchanged at the repo's pre-existing 42 errors / 22 warnings — this branch adds none.
