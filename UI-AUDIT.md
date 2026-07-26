# Bobble 3D studio — UI/UX parity audit

Branch `worktree-agent-a6a0c31f63243ae1f`, based on `ce54371`.

Everything below was produced by **driving the built app** with Playwright, not by reading
code. Three probes generated the evidence; they are committed so any claim can be re-checked:

| probe | what it produces |
|---|---|
| `apps/desktop/tests/e2e/tripo-parity-audit.mjs` | chat UI + studio screenshots in the same window, `getComputedStyle` geometry/type for equivalent controls on both sides, 3 flavors × light/dark, purple-hue scan |
| `apps/desktop/tests/e2e/tripo-parity-audit2.mjs` | resolved focus outlines while tabbing, count of elements actually painted `--pd-accent-primary`, scroller metrics |
| `apps/desktop/tests/e2e/tripo-parity-audit3.mjs` | cropped scrollbar shots per flavor (scrollbars are `::-webkit-scrollbar` pseudo-elements and invisible to `getComputedStyle`) |

Screenshots and JSON live in `apps/desktop/tests/e2e/.tripo-audit-shots/{before,after}/`
(untracked, same convention as the existing `.tripo-pipeline-shots`).

Run them with:

```
export AUDIT_APP_ROOT=$PWD/apps/desktop AUDIT_OUT=/tmp/audit
node apps/desktop/tests/e2e/tripo-parity-audit.mjs
```

---

## Verdict

The studio is a genuinely good piece of tool design — the pipeline reads clearly, the
viewport chrome is restrained, and it does not carry the credits/upsell ballast of the
product it was modelled on. What it is **not** is the same application as the chat UI.

The root cause is structural and is stated in `primitives.tsx`: the studio hand-rolls its
primitives "so the workspace can match the reference's density/geometry exactly while still
drawing every color from the pd token set." That trade was taken honestly — colors *do* flow
through tokens (853 `var(--pd-*)` references) — but **geometry, type scale, motion and focus
were never part of the deal**, and those are what make two surfaces feel like one product.
The result reads as a well-made 3D tool that has been *embedded in* Bobble rather than *built
from* it.

Good news up front, both verified:

- **No purple.** The hue scan over every element's `color` / `background` / `border` / `fill` /
  `stroke` in the loaded studio returned **0 hits** in the 255–320° band. The standing brief
  is respected.
- **Colors really are tokenised.** 853 `var(--pd-*)` uses across 64 distinct tokens.

---

## Findings, ranked by impact

### P0 — functional bugs, not style. See the BUGS section at the bottom.

### P1 — the parity breaks that matter

**1. Button shape language is a different product's.**
Measured `.tp-export-cta`, `.tp-pill-btn`, `.tp-back-btn`, `.tp-segmented`, `.tp-segment` all at
`border-radius: 9999px` — full capsules. The app's `.pd-btn` measured **10px**
(`--pd-radius-button`). `tripo.css` used `--pd-radius-full` **57 times**; all of
`packages/ui/src/styles/*.css` uses it 18 times and exactly **one** of those is a button
(`.pd-btn-round`, an icon button). Worse, this defeats a deliberate mechanism — `controls.css`
says of `.pd-segmented`: *"Radius derives from --pd-radius-button so codex goes full-pill"*,
i.e. roundness is meant to be a **flavor** decision. Hardcoding capsules removed that.
Evidence: `before/B01-studio-empty-dark.png` next to `before/A02-chat-thread-dark.png`.

**2. Accent is used with no hierarchy.**
Counted elements actually painted `--pd-accent-primary` (≥8×8px): empty studio **3**, model
loaded **5**, **Animate stage 22** — including four large CTAs competing head-on:
"Open State Machine" 12558px², "Add parameter" 5998px², "Auto-Rig with SkinTokens" 5320px²,
"Export" 3160px² ×2. The chat UI at the same viewport has essentially no large accent fills at
all — its only chroma is the amber Sandbox chip (`before/A02-chat-thread-dark.png`). Nothing
told you what the panel wanted you to do. `.tp-retry-btn` also carried a `0 0 22px` accent
**glow**; nothing else in the app glows.

**3. `--pd-text-link` used as a decorative accent, so it ignores the flavor.**
`.tp-accordion-sub` ("Face limit · topology · symmetry") was painted `var(--pd-text-link)`.
That token is blue in *every* flavor (claude-dark `#74abe2`, codex-light `#339cff`), so it was
the one element that stayed **blue** while the whole studio went terracotta under claude and
mono under codex — visible in `before/C-studio-claude-dark.png` and
`before/C-studio-codex-light.png`. It is also semantically wrong: that string is a contents
summary, not three links, and the whole accordion head is the single click target.

**4. Switch geometry and fill had drifted from a spec that is documented to the pixel.**
`controls.css` specifies 36×20 track / 16px thumb / travel 16px, and deliberately fills checked
switches with `--pd-text-link` — *"NOT the inverted mono"*. Measured `.tp-toggle`: **21px** tall,
15px travel, filled `--pd-accent-primary` (`rgb(10,132,255)`). Under claude the studio's
switches went terracotta while every switch in Settings stayed blue.

**5. Top bar height and surface don't match the app's.**
Measured `.tp-topbar` **h=52px, bg `rgb(30,30,33)`** (`--pd-bg-raised`) against `.pd-topbar`
**h=48px, bg `rgb(21,21,23)`** (`--pd-bg-base`). `--pd-height-topbar: 48px` exists and was
ignored. Crossing Chat → 3D Studio stepped the window chrome 4px taller and one surface lighter.

**6. Type scale runs below the app's floor.**
`tripo.css` carried 15 raw sub-caption declarations — 8px ×1, 9px ×5, 10px ×5, 11px ×4 — while
`--pd-font-size-caption: 12px` is the smallest token the rest of the app ever renders.
`.tp-rail-label` measured **10px**. At the other end `.tp-empty h1` was **30px** where
`--pd-font-size-title: 22px` is the top of the scale. `.tp-workspace-label` was a fractional
**12.5px** with a literal `font-weight: 600`.

**7. A phantom token.**
`var(--pd-accent-primary-fg, #fff)` appeared twice. `--pd-accent-primary-fg` **does not exist**
— 0 occurrences in `packages/themes/src/generated/themes.css` — so it always silently resolved
to the `#fff` fallback. The real token is `--pd-text-on-accent`.

**8. Off-token status colors.**
`#e0705a` ×6 for destructive affordances (`.tp-node-tool-del:hover`, `.tp-tr-delete`,
`.tp-param-del:hover`) where `--pd-status-danger-fg` exists and is *different in every flavor*
(bobble-dark `#ff6961`, claude-dark `#ec7e7e`, codex-dark `#ff6764`). `#3ea55f` ×3 for the
success/entry-state green vs `--pd-status-success-fg` (bobble-dark `#30d158`). Also
`#26262c` hardcoded as the letterbox behind every motion-preview video, which stayed a dark slab
under both light modes. The file header claimed *"No hardcoded colors anywhere"* while carrying
**26 hex literals**.

**9. Voice breaks the app's sentence case; storage names leak into the UI.**
The empty state read **"Ready For A New 3D Model?"** — Title Case marketing voice at 30px,
against the app's "Ask anything…", "No projects yet." The motion library rendered raw asset
filenames as labels: `angry_01`, `sad_01`, `angry_02`, `dance_01` (`store.ts` did `name: a.id`).
The right panel tab said "Property" for a list of many nodes.

**10. Reduced-motion coverage was partial.**
The studio's single `@media (prefers-reduced-motion: reduce)` block only stopped the `.cl-*`
capability-loop SVG artwork. Its own dialog/menu entrances, press-scale and snapshot flash kept
animating, while **ten** files in `packages/ui/src/styles` honour the query.

**11. ~1000 lines of dead clone vestige.**
`.tp-credits*`, `.tp-cost*`, `.tp-account-*`, `.tp-bell-*`, `.tp-badge-new`, `.tp-share-plus`,
`.tp-upgrade-*` — 18 rule blocks with **zero** references in any studio `.tsx`. These are the
credits/accounts/notification-bell UI of the product this was modelled on; `tripo-ui-probe.mjs`
explicitly asserts that words like "credits" and "Upgrade" must never render.

**12. Redundant affordances.**
Two "Export" buttons on screen simultaneously (top bar + viewport pill), identical label,
identical action (`set('modal','export')` in both), measured identical 3160px² accent fills.
The download panel header carries both a "‹ Back" button and an "✕".

### P2 — noted, not fixed

- **Codex squircle skips the studio.** `base.css` applies `corner-shape: superellipse(1.5)` to an
  enumerated list of `.pd-*` primitives only; no `.tp-*` class is in it, so studio surfaces keep
  circular corners under codex while the rest of the app gets the signature. **I could not
  visually confirm this** — I did not verify whether this Chromium build supports `corner-shape`
  at all. Static read of `base.css` only.
- **Class names are semantically wrong**, which the accent audit surfaced by accident:
  "Auto-Rig with SkinTokens" uses `.tp-retry-btn`, "Add parameter" uses `.tp-upload-btn`,
  "Open State Machine" uses `.tp-generate-btn`. Renaming is a refactor; this was a visual pass.
- **Static info rendered as interactive-looking cards** — "Rigging / SkinTokens",
  "Animation / ARDY", "Model / CubePart", "Target / dropped-model" sit in bordered cards
  identical to the genuinely clickable "Geometry" and "AI Model" cards.
- **Viewport float toolbar grouping is arbitrary** — three buttons in one pill, then two more in
  separate solo pills (`.tp-float-solo`), with no rule distinguishing them.
- **Download-panel card thumbnails** are near-empty dark rectangles with a small dot, ~90px tall,
  conveying nothing; they read as broken images (`before/B03-studio-download-panel-dark.png`).
- **Menu row geometry**: `.tp-menu-item` measured h=36px / 12px text vs the app's
  `--pd-row-height: 32px` / `--pd-font-size-body: 14px`. Left alone — the studio's denser menus
  are defensible for a tool surface, and changing them touches every popover.

---

## What changed

All in `apps/desktop/src/tripo/`. Behaviour preserved: no testid renamed, no store shape
altered, nothing under `packages/gen3d-engine/` or `apps/desktop/electron/gen3d/` touched.

| # | change | verified by |
|---|---|---|
| 1 | Focus grammar adopted from `base.css` for every `.tp-` control | outline `auto 1px rgb(153,200,255)` @0 → `solid 2px` @2px, colors in on `:focus-visible` |
| 2 | Text buttons derive radius from `--pd-radius-button` via two aliases | `.tp-export-cta` 9999px→**10px**, `.tp-segmented` →**13px**, `.tp-segment` →**10px** (exactly `.pd-btn` / `.pd-segmented`) |
| 3 | Top bar rides `--pd-height-topbar` / `--pd-bg-base` | **52→48px**, `rgb(30,30,33)`→`rgb(21,21,23)` |
| 4 | `.tp-toggle` matched to `.pd-switch` | **21→20px**, fill `rgb(10,132,255)`→`rgb(41,151,255)` |
| 5 | One accent-filled primary per panel; tonal + quiet tiers added; glow removed | accent-filled count **3→2**, **5→2**, **22→18** (the 18 = 1 primary + 1 top-bar Export + 16 18px "+" badges) |
| 6 | `.tp-accordion-sub` → `--pd-text-muted` | `after/C-studio-claude-dark.png` — now muted, no longer the one blue thing |
| 7 | Status colors → `--pd-status-danger-fg` / `--pd-status-success-fg`; video letterbox → `--pd-bg-inset`; phantom token → `--pd-text-on-accent` | hex literals **26→20** (rest are `#fff`/`#000` mix endpoints + DCC brand logos, deliberately theme-invariant) |
| 8 | Studio scrollers carry `.pd-scroll` | `after/D-scrollbar-{claude,codex}.png` — thick UA bar → hairline |
| 9 | Stats overlay given a blurred surface | `after/B07-studio-stage-animate-dark.png` |
| 10 | Export dialog → centered, scrimmed, dialog motion tokens | `after/B06-studio-export-dialog-dark.png` |
| 11 | Wireframe split from the exclusive segmented control (`role="switch"` + state dot) | `after/*` render-mode strip |
| 12 | Type: empty state →`--pd-font-size-title`, rail label 10→11px, workspace label →caption | measured |
| 13 | Copy: "No model yet", "Properties", motion labels humanized (`angry_01`→"Angry 1") | `after/B07-studio-stage-animate-dark.png` |
| 14 | 18 dead rule blocks removed | `tripo.css` 3781→3834 lines net (dead code out, comments in) |
| 15 | Reduced-motion broadened to the studio's own animations | per-rule, no `!important` (repo bans it) |

## Deliberately left alone

- **Menu density, panel widths, rail width** — the studio is a tool surface; matching chat's
  32px rows would cost real information density. Divergence noted, not "fixed".
- **The `.cl-*` capability-loop artwork and DCC brand logos** — theme-invariant on purpose.
- **Class renames** (`.tp-retry-btn` for Auto-Rig etc.) — a refactor, and the brief was a visual
  pass with behaviour intact.
- **The download-panel thumbnails and float-toolbar grouping** — both need a design decision
  rather than a token fix.
- **The codex squircle gap** — unverified; would mean adding `.tp-*` to a shared `base.css`
  block, which is a shared-file change I did not want to make on evidence I could not see.
- **The pre-existing test failure** — see below. It is on the functional side.

---

## BUGS — functional, not cosmetic

**1. `pnpm test` was already red before I touched anything.**
`apps/desktop/electron/ipc-contract.test.ts` asserts every channel matches
`/^[a-z]+:[a-z]+(-[a-z]+)*$/`. The channel **`gen3d:catalog`** fails it — the domain contains a
digit. I confirmed this by stashing all my work and running the test on the clean tree: still
red. `git log -S` puts the test at `ece62c1` (v0.1) and the `gen3d:*` channels at `f2669aa` /
`0f7082e`, so the regex was never widened when gen3d IPC landed. **Not fixed** — either the
regex should allow digits or the channel should be renamed, and that is your call. Everything
else passes: **760/761 tests, 23/24 tasks**, and my changes add zero failures.

**2. `tripo-pipeline-probe.mjs` is dead and silently so.**
It times out after 30s waiting for `[data-testid="tp-load-sample"]`, which **does not exist
anywhere in `apps/desktop/src/`**. It is a stale probe from before the "no bundled placeholder
model" change (`tripo-ui-probe.mjs`'s own header documents that the viewport now starts empty).
Anyone running it reads it as a regression. Not fixed — deleting or rewriting a probe is yours.

**3. The export dialog was occluding a control it sat on top of.**
`.tp-export-dialog` was `position: absolute; right: 22px; bottom: 66px` with no scrim, and it
parked directly over the render-mode bar — the **Wireframe** control is unreachable while the
dialog is open (`before/B06-studio-export-dialog-dark.png`). Fixed as part of the modal work,
but flagging it because it was an interaction failure, not a look.

**4. Studio controls had no visible keyboard focus indication of the app's design.**
Every one of 10 sampled studio controls resolved to Chromium's default
`outline: auto 1px rgb(153,200,255)` at offset 0, while the chat side resolved to the app's
`solid 2px rgb(41,151,255)` at offset 2px. The studio was the only surface in the app drawing
the browser's ring. Fixed. Note the same gap exists on a few chat controls
(`.pd-project-chip`, `.pd-menu-trigger` also measured the UA default) — **outside my scope, but
you may want it.**

**5. Wireframe was lying about its own affordance.**
It sat inside the same segmented strip as Clay/Textured/Normal wearing the identical
`.tp-mode-btn`, so an exclusive-choice control advertised a fourth mode that is actually an
independent overlay toggle. Fixed with `role="switch"` + a state dot; the behaviour and testid
are unchanged.
