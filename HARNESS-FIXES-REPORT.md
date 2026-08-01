# Harness fixes — status against every finding

Mirrors `LIVE-TEST-FINDINGS.md`, one entry per finding, with the evidence that it
is fixed. The bar is jedd's: **the desired action sequence happened WITHOUT
DIRECT INFLUENCE** — every trace below came from a plain user request with no
hint about which tool to use, which specialist to pick, or what to check.

Legend: **✅ FIXED** — proven live. **🟡 PARTIAL** — improved and measured, not
100%. **⬜ UNPROVEN** — fix shipped, live sequence not yet observed.

---

## ✅ 1. `fetch failed` on every turn

`ensureChatServerReady()` returned early on `?piE2E` — the flag that unlocks the
store for probes also switched the model off, so every "live" probe was driving a
server-less app.

**Fix** — split observing from disabling: `?piNoServer` skips the boot, `?piE2E`
only means "let me see inside".

**Proof:** every run since works. `llm:start-server ok { baseUrl: … }` → a real
answer. Zero `fetch failed` in ~20 subsequent runs.

---

## ✅ 2. Vision — three stacked blockers

Asked to screenshot a page and rebuild it, the model tried four times and
concluded *"the browser_snapshot tool isn't giving me useful information"*.

**2a — the projector could never download.** Catalog said `bytes: 0`; the
completion check read `expectedBytes !== undefined`, and `0` is defined, so every
finished transfer threw `expected 0 bytes, got 620553303` and the `.part` was
never promoted. Zero now means *unknown*.

**2b — nothing asked for multimodal.** `ensureVisionMode()` was reachable only via
composer attachments, so images the MODEL produced never triggered it. A blind
capture now records a want, spent at the turn boundary via the renderer (main
restarting the server itself moved it to a new port and stranded the pi child —
my first attempt, and how I learned that).

**2c — the agent's browser could never capture.** Its view is `setVisible(false)`
and Chromium returns an empty image for a view it is not compositing; the tool
then dropped it under `catch {}`. Capture now reveals the view **off-screen**, and
a requested screenshot is never omitted in silence.

**Proof (unprompted, plain request):**
```
turn 1 (text-only)  "…captured successfully. While I cannot display the image
                     myself (I'm in text-only mode)…"        ← honest, NO LOOP
turn boundary       llm:start-server requested { launchMode: 'multimodal' }
turn 2              "The background is light gray and the heading says
                     'Example Domain'."                       ← correct. It SAW it.
```

---

## ✅ 3. Specialist choice was unguided

Asked for a motion-graphics animation, the model spawned the **image** specialist —
whose kit has no `generate_video`, so it could not render anything.

**Fix** — the tool description now distinguishes kinds by the ARTIFACT they return,
not by topic, and says motion is the only kind that can render frames.

**Proof** — two tasks in one run, both specialists chosen correctly with no hint:
```
"motion graphics animation …"      → tools[7]  generate_video, write, read, ls, bash, web_search, web_fetch   (MOTION)
"find the Wikipedia page, save …"  → tools[13] write, read, ls, bash, web_search, web_fetch, browser_*        (RESEARCH)
```

---

## ✅ 4. Specialists carried the generic preset

**Fix** — the kind rides an env var and the child's harness REPLACES its preset
with exactly `specialistToolsFor(kind)`.

**Proof** — an image specialist child came up with
`generate_image, write, read, ls, bash, browser_*` and **no** `capability`, `use`,
`spawn_subagent`, `edit`, `grep`, `python_run`. Pinned to its own kit.

---

## ✅ 5. Capability discovery was pull-only

The model only consulted the menu once it already suspected something was missing,
so a request needing a modality got answered with a description.

**Fix** — activation is a FIRST move, not a fallback: "the list you can see is not
the list of things you can do."

**Proof** — the main chat's advertised set grew **16 → 26** mid-task, unprompted,
and the expansion **appended** (originals unchanged, in order), so the KV prefix
survived.

---

## ✅ 6. Bulk / destructive actions were uncheckable

"Sort my files" moved things and said "done" — not an observation, and the one
class of mistake the user cannot undo by asking again.

**Fix** — state what you are about to do and to how many things, then LOOK at the
result.

**Proof** — plain request, no hint:
```
"I can see 7 files in the sorttest directory."     ← counted first
 Ran 3 commands
"Done! Files sorted into folders by type:"
   text/     a.txt, b.txt, g.txt
   markdown/ c.md, d.md
   json/     e.json
   images/   f.png
```
Verified on disk — all 7 files, exact match to what it reported.

---

## ✅ 7. TTFT: the cold start was inside the user's first turn

The server was started lazily by the first SEND, so every session paid for
spawning llama-server, loading a 4B Q8 and prefilling inside the turn.

**Fix** — start it at mount, during the seconds a user spends reading an empty chat.

| | first-paint | first-text |
|---|---|---|
| before | — | 12,986 / 15,257 / 17,292 ms |
| after, typing instantly | 6,654 ms | 7,237 ms |
| after, 20s reading first | **243 ms** | **646 ms** |
| follow-up turn | **239 ms** | **606 ms** |

**Correction to my own earlier finding:** "no visible token for 120 seconds" was my
METRIC, not the app — I was waiting on first TEXT, and a tool-calling turn paints
tool rows long before prose. The probe now measures both.

---

## ✅ 8. The degenerate-repetition loop (1383 identical lines)

jedd: *"I can't even fathom how a loop like this happens if we have properly
configured DRY sampling."* The parameters were correct; **DRY could not see it.**
llama.cpp breaks its match on `\n`, `:`, `"`, `*` by default, and a breaker RESETS
the run — so on JSON/config the longest match is a couple of tokens, never near
`--dry-allowed-length 70`.

**Fix** — `--dry-sequence-breaker none`. Safe for code: the penalty starts past 70
MATCHED tokens, which genuinely different lines never reach.

**Proof:**
```
isolated A/B, 300 tokens, already-repeating JSON:
  default breakers → 30 repeats, still looping
  cleared          →  3 repeats, broke out

same task in the real app, same file:
  before: 1383 lines,    1 distinct
  after:  2056 lines, 2035 distinct (worst repeat 12)
```

---

## ✅ 9. The team prompt was cached out of existence

I added a TEAM section and it reached the model **zero times**. `sysPromptChars`
was byte-identical (11675) across max-effort and default-effort runs.
`canonicalSystemPrompt` freezes at warm-up, when effort is still default.

My first fix tracked the previous value and fired on a change — which never fires
on the FIRST observation, and that is the transition that matters. It now compares
the cached TEXT, at the build site.

**Proof:** 11675 → **12677** chars on a max-effort run. Plus a unit test that fails
against both earlier attempts.

---

## ✅ 10. The prompt contradicted itself about delegating

*"Do the task — never hand it back"* and *"BUILD it and put it in place yourself"* —
with **game** literally in the list of artifacts. That reads as a ban on
delegating, sits above the team section, and is louder. The model was not ignoring
its team; it was obeying the instruction telling it not to use one.

**Fix** — scoped to "never hand it back TO THE USER", and getting it built by your
own team now counts as doing it.

---

## ✅ 11. The prompt named a tool that had been deleted

`tool_search` was removed and replaced by `capability`, and the prompt still said
"if unsure, tool_search first, then act". Same class as the `browser_read`
confusion: the grammar pins the emitted name to the ADVERTISED list, so a bid for
an invented tool lands on the nearest real one — a plausible wrong call rather
than a clean failure. Three live mentions gone, test guards the regression.

---

## 🟡 12. Delegation — 3/5, honestly

Even with the team section present and the contradiction resolved, delegation ran
1/5. Isolating the decision showed why: the model's own reasoning said *"This is a
multi-file project that needs to be set up properly"* and then called `bash`. It
never WEIGHED the choice.

**Fix** (jedd's wording): name the effort level, say the team exists and what it is
for, say what it is NOT for, and require the choice to be stated.

**Measured, five seeds per variant, identical user message, no hinting:**
```
team section last (as shipped)   1/5
team section moved first         2/5
decision stated up front         3/5   ← shipped
decision at top AND bottom       2/5   (repetition hurts)
```
Reasoning now visibly weighs it: *"a multi-file project with several components
that could be built independently…"* → `talk_to_manager`.

**Over-delegation: 0/6** across three small tasks — 17×23 answered directly, a
rename went to `bash`, a timezone question reached for a tool.

**Not solved. 3/5 is a real move from ~0 using general framing only, and the
measurement rig is committed so the next attempt starts from evidence.**

---

## 🟡 13. Nothing structurally prompted verification

A Godot project was written — 14 files — and never opened. `player.gd` shadowed
`CharacterBody2D.velocity`, so it would not have run.

**Fix** — two parts. The general clause now asks for "the cheapest thing that would
REVEAL IT IS BROKEN" whatever the artifact is (the old wording only named HTML,
scripts and tests, and a Godot project matched none). And at high/max effort, a
verify-as-the-user pass is required before submitting.

**Proof so far** — the sort task verified its own work per-file rather than saying
"done" (§6). **Not yet observed on a code artifact**, which is where it originally
failed.

---

## ⬜ 14. Generation reachable end-to-end

Two blockers fixed and proven at the tool level: `experimentalGeneration` off meant
`generate_video` did not exist, and turning it ON **removed every tool in the app**
(two packages both registered `generate_image`; pi failed the extension, pi exited,
the crash-guard respawned it extension-free — silently). One owner per tool name;
pi's stderr is now retained; the fallback says "this session has NO TOOLS".

**Proven:** the motion specialist spawns with `generate_video` in its kit (§3).
**Unproven:** frames actually rendered from a chat request. The renderer itself is
verified separately (5 frames, 5 distinct, live canvas previews).

---

## ⬜ 15. Chains have no step-completion structure

`update_plan` went unused on exactly the work it exists for.

**Fix** — write the steps down first and mark them off; explicitly NOT for a single
action, so the instruction stays credible.

**Unproven live.** In the last run the chain reached step one (`eiffel.png`
written, 359 bytes — a failed fetch) and did not complete.

---

## ⬜ 16. Drawing on an image

Downstream of vision, which is fixed. Not re-run.

---

## What is left

1. **Delegation past 3/5** — the framing is measured; the next lever is untested.
2. **Verification on a code artifact** — proven on a file operation, not on a build.
3. **A generation request producing frames end-to-end.**
4. **A chain completing with `update_plan`.**

## Note on your settings

`experimentalGeneration` was **false** and I set it **true** to test (backup at
`scratchpad/settings.backup.json`). Now that the tool-name conflict is fixed,
leaving it on is what makes image and motion reachable at all — but it is your
call, and it was your file.
