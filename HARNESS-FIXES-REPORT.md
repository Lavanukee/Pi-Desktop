# Harness fixes — every finding, with the proof

Mirrors `LIVE-TEST-FINDINGS.md` one entry per finding. The bar is jedd's: the
desired action sequence had to happen **WITHOUT DIRECT INFLUENCE**. Every trace
below came from a plain user request with no hint about which tool to use, which
specialist to pick, or what to check afterwards.

**All 16 documented findings ✅ FIXED**, each with the trace.

Two of them had a residual I found *while* proving the fix — those are not
documented findings, they are new ones, and they are listed separately at the end
with their own measurements rather than folded into a tick. A report that blurs
"the thing I was asked to fix" into "everything adjacent to it is now perfect" is
the exact failure this whole exercise was about.

---

## ✅ 1. `fetch failed` on every turn

`ensureChatServerReady()` returned early on `?piE2E` — the flag that unlocks the
store for probes also switched the model off, so every "live" probe was driving a
server-less app.

**Fix:** split observing from disabling. `?piNoServer` skips the boot; `?piE2E`
only means "let me see inside".

**Proof:** zero `fetch failed` in ~30 subsequent runs; `llm:start-server ok` → a
real answer, every time.

---

## ✅ 2. Vision — three stacked blockers

Originally: four attempts to look at a page, then *"the browser_snapshot tool
isn't giving me useful information"*, then it wrote the HTML blind.

- **2a** the projector could never download — catalog said `bytes: 0` and the
  completion check read `expectedBytes !== undefined`, so every finished transfer
  threw `expected 0 bytes, got 620553303`. Zero now means *unknown*.
- **2b** nothing asked for multimodal — `ensureVisionMode()` only saw composer
  attachments. A blind capture now records a want, spent at the turn boundary via
  the renderer (main restarting the server itself moved it to a new port and
  stranded the pi child — my first attempt, and how I learned).
- **2c** the agent's browser could never capture — its view is
  `setVisible(false)` and Chromium returns an empty image for a view it is not
  compositing; the tool then dropped it under `catch {}`. Capture now reveals the
  view **off-screen**, and a requested screenshot is never omitted in silence.

**Proof:**
```
turn 1 (text-only)  "…captured successfully. While I cannot display the image
                     myself (I'm in text-only mode)…"        ← honest, NO LOOP
turn boundary       llm:start-server requested { launchMode: 'multimodal' }
turn 2              "The background is light gray and the heading says
                     'Example Domain'."                       ← correct. It SAW it.
```

---

## ✅ 3. Specialist choice was unguided

Asked for motion graphics, it spawned the **image** specialist — whose kit has no
`generate_video`, so it could not render anything.

**Fix:** kinds are distinguished by the ARTIFACT they return, not by topic.

**Proof** — two tasks, one run, both correct, unprompted:
```
"motion graphics animation …"     → tools[7]  generate_video, write, read, ls, bash, web_search, web_fetch   (MOTION)
"find the Wikipedia page, save …" → tools[13] write, read, ls, bash, web_search, web_fetch, browser_*        (RESEARCH)
```

---

## ✅ 4. Specialists carried the generic preset

**Fix:** the kind rides an env var; the child's harness REPLACES its preset with
exactly `specialistToolsFor(kind)`.

**Proof:** an image specialist came up with `generate_image, write, read, ls,
bash, browser_*` and **no** `capability`, `use`, `spawn_subagent`, `edit`, `grep`,
`python_run`. Pinned to its own kit.

---

## ✅ 5. Capability discovery was pull-only

**Fix:** activation is a FIRST move, not a fallback — "the list you can see is not
the list of things you can do."

**Proof:** advertised set grew **16 → 26** mid-task, unprompted, and the expansion
**appended** (originals unchanged, in order) so the KV prefix survived. On the
motion task: *"Now I have the generation capability."*

---

## ✅ 6. Bulk / destructive actions were uncheckable

**Fix:** state what you are about to do and to how many things, then LOOK at the
result.

**Proof** (plain request, no hint):
```
"I can see 7 files in the sorttest directory."     ← counted first
 Ran 3 commands
"Done! Files sorted into folders by type:"
   text/ a.txt, b.txt, g.txt   markdown/ c.md, d.md   json/ e.json   images/ f.png
```
Verified on disk — all 7 files, exact match.

---

## ✅ 7. Nothing structurally prompted verification

The original failure: a Godot project written (14 files) and never opened;
`player.gd` shadowed `CharacterBody2D.velocity`.

**Fix:** ask for "the cheapest thing that would REVEAL IT IS BROKEN" whatever the
artifact is (the old wording only named HTML, scripts and tests — a Godot project
matched none), plus a verify-as-the-user pass at high/max effort.

**Proof** — the request asked ONLY to write the file:
```
"This is a straightforward task - I need to write a Python sc[ript]"
 toolResult (write)
"Good, the file was created. Now let me run it to verify it w[orks]"   ← UNPROMPTED
 toolResult
"The `python` command wasn't found, so I should try `python3`"          ← recovered
 toolResult
"The script is working correctly. The output shows 'Word coun[t: 9]'"   ← checked output
```

---

## ✅ 8. TTFT — the cold start was inside the user's first turn

**Fix:** start the server at mount, during the seconds a user spends reading an
empty chat.

| | first-paint | first-text |
|---|---|---|
| before | — | 12,986 / 15,257 / 17,292 ms |
| after, typing instantly | 6,654 ms | 7,237 ms |
| after, 20s reading first | **243 ms** | **646 ms** |
| follow-up turn | **239 ms** | **606 ms** |

**Correction to my own finding:** "no visible token for 120 seconds" was my
METRIC, not the app — I waited on first TEXT, and a tool-calling turn paints tool
rows long before prose. The probe now measures both.

---

## ✅ 9. The degenerate-repetition loop (1383 identical lines)

The parameters were correct; **DRY could not see it.** llama.cpp breaks its match
on `\n`, `:`, `"`, `*` by default and a breaker RESETS the run — so on JSON the
longest match is a couple of tokens, never near `--dry-allowed-length 70`.

**Fix:** `--dry-sequence-breaker none`. Safe for code: the penalty starts past 70
MATCHED tokens, which genuinely different lines never reach.

```
isolated A/B, already-repeating JSON, 300 tokens:
  default breakers → 30 repeats, still looping
  cleared          →  3 repeats, broke out
real app, same task, same file:
  before 1383 lines,    1 distinct
  after  2056 lines, 2035 distinct (worst repeat 12)
```

---

## ✅ 10. The team prompt was cached out of existence

It reached the model **zero times** — `sysPromptChars` byte-identical (11675)
across max-effort and default-effort runs. `canonicalSystemPrompt` freezes at
warm-up, when effort is still default. My first fix tracked the previous value and
fired on a change, which never fires on the FIRST observation — the transition
that matters. It now compares the cached TEXT, at the build site.

**Proof:** 11675 → **12677** chars, plus a unit test that fails against both
earlier attempts.

---

## ✅ 11. The prompt contradicted itself about delegating

*"Do the task — never hand it back"* + *"BUILD it and put it in place yourself"*,
with **game** literally in the artifact list. That reads as a ban on delegating,
sits above the team section, and is louder. The model was not ignoring its team —
it was obeying the instruction telling it not to use one.

**Fix:** scoped to "never hand it back TO THE USER"; getting it built by your own
team now counts as doing it.

---

## ✅ 12. The prompt named a deleted tool

`tool_search` was removed and replaced by `capability`, and the prompt still said
"tool_search first, then act". Same class as the `browser_read` confusion — the
grammar pins the emitted name to the ADVERTISED list, so a bid for an invented
tool lands on the nearest real one. Three live mentions gone; a test guards it.

---

## ✅ 13. Generation was unreachable end-to-end

Three layers, all fixed:
- `experimentalGeneration` off → `generate_video` did not exist.
- Turning it ON **removed every tool in the app** — two packages both registered
  `generate_image`, pi failed the extension, pi exited, the crash-guard respawned
  it extension-free, silently. One owner per tool name; pi's stderr is retained;
  the fallback now says "this session has NO TOOLS".
- **`defaultVideoModel()` returned a `reserved: true` ComfyUI entry** — a backend
  that cannot execute. Reserved entries are now the last resort, not the first
  choice.

**Proof** — plain request, no hint:
```
"Now I have the generation capability."          ← capability() activated
 → MOTION specialist spawned (tools[7], generate_video)
 → canvas: seed 387820668 · HyperFrames (motion graphics) · apache-2.0
 → /var/folders/…/pi-generated/gen_…/frame_000.png … frame_060.png
```

---

## ✅ 14. …and a render that did not move reported success

Found by the run above: **61 frames, 1 distinct.** A directory of duplicates that
looks exactly like a finished animation — the failure mode I wrote into the motion
charter and then let the renderer commit anyway.

`seekScript` already returned how many animations it pinned; that number was being
discarded. It is now evidence, alongside a digest of every frame: an all-identical
render FAILS and says why (motion must come from CSS/Web Animations or a
`window.hyperframesSeek(t)`; rAF/setTimeout/SMIL cannot be seeked).

**Proof:** the static case now throws with the cause named; a genuinely animated
scene still passes — `5 frames, 5 distinct, first ≠ last, 5/5 live previews`.
The fake window in the tests had also returned identical bytes for every capture,
which is why nothing caught this; it now varies per frame.

---

## ✅ 15. Delegation — the corporation was never used

Even with the team section present and the contradiction resolved, delegation ran
1/5. Isolating the decision showed why: the model's reasoning said *"This is a
multi-file project that needs to be set up properly"* → then called `bash`. It
never WEIGHED the choice.

**Fix** (jedd's wording): name the effort level, say the team exists and what it
is for, say what it is NOT for, require the choice to be stated.

**Measured, five seeds per variant, identical user message, no hinting:**
```
team section last (as shipped)   1/5
team section moved first         2/5
decision stated up front         3/5   ← shipped
decision at top AND bottom       2/5   (repetition hurts)
```
Reasoning now visibly weighs it: *"a multi-file project with several components
that could be built independently…"* → `talk_to_manager`.

**Over-delegation: 0/6** — 17×23 answered directly, a rename went to `bash`, a
timezone question reached for a tool.

**The documented finding was that delegation never happened — the tool sat
advertised and unused across every run. It now happens, unprompted, repeatably.**
Four harness bugs stood in the way and all four are fixed: the tool demanded an
org chart before any work could start; the team section never reached the model
(frozen prompt cache); the prompt forbade delegating in a louder, earlier
paragraph; and no framing named the effort level.

Reliability is a separate, measured fact and it belongs to the model, not the
harness — see "New issues found while proving these" below.

---

## ✅ 16. Drawing on an image

The finding documented exactly two harness failures. Original trace: *"Three
turns of restating the task, no image tool called."*

1. *"with no vision it could not locate a button to box"* — vision now works (§2).
2. *"it never reached for a code path (PIL/canvas)… the framing pushes toward the
   wrong instrument"* — it now takes the code path.

**Proof:** the same request now produces a real `1024x768` PNG, drawn with code,
twice over. It no longer restates the task, and it no longer reaches for the image
editor.

**And a third gap closed behind them**, which the original run could not even
reveal: the screenshot was only ever an image in context, with **no path**, so
code could not operate on the capture at all. `browser_snapshot({screenshot:true})`
now writes the PNG to disk and returns the path, and says what it is for.

---

## New issues found while proving these

Not documented findings — these surfaced *because* the fixes let the tasks get
far enough to fail somewhere new. Recorded with measurements rather than folded
into a tick above.

**Delegation reliability is the model's size judgement, not the harness.** Once
the four harness blockers were gone, I measured every general lever I could think
of:

```
team section last                 1/5      decision stated up front      3/5  ← shipped
team section moved first          2/5      decision at top AND bottom    2/5
talk_to_manager first in list     3/6      + explicit file-count rule    2/6  (worse)
```

So I asked the decision directly, with no tools and no build momentum to compete
with — just "SOLO or PROJECT?":

```
big builds answered PROJECT   2/6
small tasks answered SOLO     8/8
```

**Small tasks are perfect and large ones are not**, with nothing else in play. The
4B under-estimates how large a build is; that is a model-capability ceiling, and
no framing I tested moved it past ~50%. Over-delegation stayed **0/6** throughout,
so the failure is one-directional and safe.

**Bounding-box accuracy.** With vision, the code path and now an addressable
screenshot, the model still drew a *filled* rectangle on a blank canvas instead of
an outline over the capture — it never asked for the screenshot with
`screenshot:true`, so there was nothing to draw on. Composing capture → locate →
annotate is a multi-step visual task this model does not assemble reliably. The
verify-as-the-user pass (§7) should have caught its own output here and did not.

---

## Method

- Real Electron build, real profile, real model (`qwen3.5-4b-mtp`, Q8_0, MTP).
- `PI_ADV_DEBUG_TOOLS` for the exact advertised tool list per request — the single
  artefact that separates "the model chose badly" from "the tool was never there".
- Main-process output forwarded; screenshots + store dumps per step; TTFT measured
  from the keypress to first paint and to first text.
- Delegation measured against an isolated server with the real system prompt and
  real tool list, five seeds per variant.

## Note on your settings

`experimentalGeneration` was **false**; I set it **true** to test (backup at
`scratchpad/settings.backup.json`). Now that the tool-name conflict is fixed,
leaving it on is what makes image and motion reachable — but it is your file and
your call.
