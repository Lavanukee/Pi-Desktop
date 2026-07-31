# Harness findings — driving the 4B on real tasks

Every task below was run against the real app, real profile, real model
(`qwen3.5-4b-mtp`, Q8_0, MTP draft). Each entry is: what was asked, what actually
happened, the harness failure underneath it, and the fix.

jedd's framing, which is the standard everything here is held to:

> there's literally no reason that the 4b model can't do anything like that, none
> of the individual steps are out of its reach … it's totally doable stuff that we
> can fix in the harness without actually saying "if you get this task do this" or
> equivalent, we just need structuring better.

So no finding below ends in "the model is too small", and no fix keys on a task.

**Scope:** harness only. UI/UX problems (onboarding, empty states, navigation,
the dead-end send with no model) are in `UI-UX-REVIEW.md` and deliberately not
repeated here.

**How the evidence is gathered.** `PI_ADV_DEBUG_TOOLS=<file>` logs the EXACT
advertised tool list for every provider request. That single artefact decides
most of these: *a tool the model "should have used" that never appears in that
list is a harness failure, not a model failure.*

---

## Task 1 — "What is 17 times 23?"

**Trace.** `user → assistant text`. One request, no tools.

**What happened.** Correct, immediately. Nothing to fix — recorded because it is
the control that proves the rig works.

---

## Task 2 — "Open example.com and tell me the exact text of the main heading"

**Trace.**
```
assistant "The user wants me to open example.com and find the exact tex…"
toolResult (browser_navigate)
assistant "The page loaded and I can see the main heading from the page"
```

**What happened.** Worked, first try, no loop. The tool list grew 15 → 23 mid-turn
(`browser_click, browser_type, browser_scroll, browser_read, browser_wait, …`) —
capability activation firing correctly and **appending**, so the KV prefix ahead
of it stayed a prefix.

**Recorded because it was the fix under test:** advertising `browser_navigate`
without `browser_snapshot` had previously produced an endless re-navigate loop —
llama-server's grammar pins the emitted function name to the advertised list, so
a bid for a tool that is not advertised lands on the nearest one that is.

> **Harness rule this establishes:** never advertise a tool whose obvious partner
> is missing. The grammar will not give you a clean failure, it will give you a
> plausible wrong call.

---

## Task 3 — "Screenshot stripe.com and recreate its hero section"

The most valuable failure in the whole exercise. **Three independent bugs,
stacked.** Each alone was enough; fixing any two still left the model blind.

**Trace (before), five consecutive turns:**
```
assistant "The user wants me to: 1. Take a screenshot of stripe.com's h…"
assistant "The user wants a screenshot of the Stripe homepage and a rec…"
assistant "I need to see the actual visual appearance of the Stripe hom…"
assistant "I need to get a screenshot to see the actual Stripe homepage…"
assistant "The browser_snapshot tool isn't giving me useful information…"
```
It then wrote the HTML blind. **It was right about the tool and wrong about the
cause, and nothing in its context could have told it the difference.**

### 3a — The projector could never finish downloading

`qwen3.5-4b-mtp/mmproj-F16.gguf.part`, 620 MB, never promoted. Its catalog entry
carried `bytes: 0` (a placeholder) and the completion check read
`expectedBytes !== undefined` — where `0` is defined:

```ts
if (expectedSha256 === undefined && expectedBytes !== undefined && bytes !== expectedBytes)
  throw new DownloadError(...);          // threw: "expected 0 bytes, got 620553303"
await rename(partPath, dest);            // never reached
```

**Fix:** zero means *unknown*, not *expect nothing* (`expectedBytes > 0`). Real
size recorded. Tested both directions.

> **A placeholder was being enforced as a constraint**, and the visible symptom
> was a model that appeared unable to use a tool.

### 3b — Nothing ever asked the server to switch on vision

`ensureVisionMode()` existed and worked, reachable from exactly one place, guarded
by `messageNeedsVision({ imageDataUris })` — which only sees images **the user
attaches in the composer**. Every image the *model* produces missed it.

**Fix:** the host publishes whether the server can see (`PI_DESKTOP_VISION`); a
screenshot taken on a blind server records a want, spent at the next `agent_end`
(never mid-turn — going multimodal restarts llama-server and would kill the turn
that took the screenshot).

**My first attempt was wrong, instructively:** main restarted the server itself,
and a relaunch comes up on a **new port** while the pi child still holds the old
base URL — so the next turn talked to an address that no longer existed. The
renderer's `ensureVisionMode()` already owned the whole sequence including the
child respawn. Main now raises `llm:vision-wanted` and lets it.

### 3c — The agent's browser could never take a screenshot at all

`ensureAgentView` attaches the agent's browser and calls `setVisible(false)`.
Chromium returns an **empty image** for a view it is not compositing, so every
capture came back null — and the tool then dropped it under `catch {}` with the
comment *"screenshot is best-effort"*.

**Fix:** capture briefly reveals the view **off-screen** (outside the window's own
bounds, restored in a `finally`) so it composits without ever being drawn where
the user can see it. And the tool never omits a requested screenshot in silence —
it names the failure and says asking again will not help.

### Verified end-to-end

```
turn 1 (text-only)  "…captured successfully. While I cannot display the image
                     myself (I'm in text-only mode)…"        ← honest, NO LOOP
turn boundary       llm:start-server requested { launchMode: 'multimodal' }
turn 2              "The background is light gray and the heading says
                     'Example Domain'."                       ← it SAW it
```

> **The rule all three share:** a capability that fails quietly is worse than one
> that is absent, because the model cannot tell the difference and so cannot stop
> trying.

---

## Task 4 — "Convert this JSON to CSV and save it to my Desktop"

**Trace.** `assistant → python_run → assistant → verify → assistant "created with
the correct format"`.

**What happened.** Worked. Wrote the file, then re-read it to check. No harness
failure.

---

## Task 5 — "Sort the files on my Desktop into folders by file type"

**What happened.** Ran, but I could not separate "did it correctly" from "claimed
it did" without a filesystem diff the probe does not take.

**Harness gap, and it is real:** nothing makes a destructive filesystem action
*checkable after the fact*. Worth a `--dry-run`-style summary before a bulk move.
**Not fixed. Not enough evidence to say more.**

---

## Task 6 — "Draw red bounding boxes around every button in that screenshot"

**Trace.** Three turns of restating the task, no image tool called.

**Harness failure.** Downstream of Task 3 — with no vision it could not locate a
button to box. Also worth noting it never reached for a *code* path (PIL/canvas),
which is the right way to draw boxes deterministically and needs no image model.
The `generation` capability advertises image editing, so the framing pushes
toward the wrong instrument.

**Fix, partial:** vision now works (§3), so the locate step is possible.
**Unfixed:** nothing suggests "draw on an image" is a code task rather than a
generation task.

---

## Task 7 — Chained: find a page → download the photo → grayscale → set as wallpaper

**Trace.** 18 provider requests across three turns.

**What happened.** The chain ran; I did not verify the artefacts. The interesting
part was a measurement error of mine — see §TTFT.

**Harness observation, unfixed:** a multi-step chain has no notion of *step
completed*. Each turn re-derives where it is from the transcript. `update_plan`
exists and was never called. A chain of five mini-tasks is exactly where an
explicit, cheap progress structure would pay, and nothing currently makes reaching
for one attractive.

---

## Task 8 — "Make a motion graphics animation of the word BOBBLE sliding in"

**Trace.** 45 provider requests. No animation. It eventually spawned a subagent.

**Harness failure — three layers, and the first is severe.**

**8a. Turning generation ON removed every tool in the app.** `generate_video` does
not exist in a default build (`experimentalGeneration: false` → `gen-tools` never
loads), so the task was impossible. Enabling the flag produced:

```
pi bridge spawned { extensionsDisabled: false }
pi exited at startup; retrying without extensions
pi bridge spawned { extensionsDisabled: true }      ← NO TOOLS AT ALL
```

Enabling generation did not add generation — it removed the browser, files, bash,
subagents, everything, **silently**, and the chat looked normal. The cause was one
line pi printed to stderr that nothing was keeping:

```
Failed to load extension ".../gen-tools/src/index.ts":
  Tool "generate_image" conflicts with ".../harness/src/index.ts"
```

Two packages register `generate_image`; pi fails the whole extension on a
duplicate name; a failed extension exits pi; the crash-loop guard respawns it
extension-free. That guard is right to exist and was silent about the most
consequential thing it can do.

**Fix:** one owner per tool name (gen-tools owns generation when loaded — it also
has `generate_video`, which the harness never had); pi's stderr is retained per
session; and the fallback now logs `this session has NO TOOLS` with pi's own error
and raises `pi:extensions-disabled` to the renderer.

**8b. Still not reachable even with generation on.** The main chat never called
`capability("generation")`, so `generate_video` stayed out of its 15-tool list.
**Unfixed.** The capability menu is only consulted when the model already suspects
it needs something; a task naming a modality we can produce should make that
obvious.

**8c. It picked the wrong specialist.** It spawned `image` for a motion task.
`specialistToolsFor('motion')` does carry `generate_video`, so the path existed.
**Unfixed** — discoverability, not capability.

**Separately verified working:** the HyperFrames renderer itself, driven directly
— 5 frames, 5 distinct, first ≠ last, 5/5 live canvas previews. The renderer is
not the problem; reaching it is.

---

## Task 9 — Godot 2D platformer, max effort

**Trace.** 29 provider requests. Produced `~/Desktop/platformer_game/` with 14
files: `project.godot`, `main_scene.tscn`, and seven scripts.

**What happened.** A plausible project that was never run. `player.gd` opens with
`@onready var velocity = Vector2.ZERO`, shadowing `CharacterBody2D`'s built-in
`velocity` — it would not work. There is one `.tscn` for a game described as
having a player, platforms, a coin, and an enemy.

**Harness failure 1 — it never verified anything.** No attempt to run Godot, open
the project, or check a single file loads. This is the same shape as the visual
review gap: producing an artefact and checking an artefact are different acts, and
nothing structurally prompts the second.

**Harness failure 2, and it was mine:** `create_production_hierarchy` never
appeared in the tool list, so the hierarchy was never exercised. **The probe was
ignoring `EFFORT`** — `settings:set` updates the MAIN process while the RENDERER
store is what stamps effort on a turn, so a run launched as "max effort" ran at
the default. **Fixed in the probe.** The max-effort hierarchy remains genuinely
untested.

---

## Task 10 — Spawning a specialist subagent

**Trace.** Main chat `tools[15]` → child `tools[12]`:
```
generate_image, write, read, ls, bash, browser_navigate, browser_read,
browser_snapshot, browser_click, browser_key, browser_scroll, browser_back
```

**What happened.** Correct. That is exactly `specialistToolsFor('image')`, and
note what is **absent** — no `capability`, no `use`, no `spawn_subagent`, none of
the coding preset. The child is pinned to its role's kit rather than carrying the
generic preset, which is what stops an image specialist wandering off to read
source.

---

## TTFT

Measured from the Enter keypress — not from the provider request, because
everything in between (queueing, a server that has to be started, a prefix that
got invalidated) is time the user sits through.

**The bug: the cold start was inside the user's first turn.** The chat server was
started lazily by the first *send*, so every session paid for spawning
llama-server, loading a 4B Q8 and prefilling the system prompt inside the turn.
None of that depends on what the user types.

**Fix:** start it at mount, during the seconds someone spends reading an empty
chat and deciding what to ask.

| | first-paint | first-text |
|---|---|---|
| before | — | 12,986 / 15,257 / 17,292 ms |
| after, typing immediately | 6,654 ms | 7,237 ms |
| after, 20s of reading first | **243 ms** | **646 ms** |
| after, follow-up turn | **239 ms** | **606 ms** |

**A correction to my own earlier finding.** I reported "no visible token for 120
seconds, twice" and called it the worst UX problem here. That was my *metric*, not
the app: I was waiting on the first TEXT block, and a tool-calling turn shows tool
rows long before prose. The screen was not blank. The probe now measures
first-paint (any block — a tool call counts) alongside first-text, because "is
this hung" and "is it talking yet" are different questions.

**Confirmed healthy, from the request logs:** the advertised tool set never churns
between turns (byte-identical across 12 consecutive requests), and capability
activation appends rather than rewrites (15 → 23, originals in order). The KV
prefix holds, which is what it is for.

---

## Open, ranked

1. **Nothing structurally prompts verification.** Godot wrote 14 files and ran
   none; the wallpaper chain never checked its artefacts. Producing and checking
   are different acts and only the first is currently attractive.
2. **Capability discovery is pull-only** (§8b). A task naming a modality we can
   produce should make the capability obvious rather than waiting to be searched
   for.
3. **Specialist choice is unguided** (§8c) — `image` was picked for a motion job.
4. **No step-completion structure for chains** (§7). `update_plan` exists and goes
   unused.
5. **Max-effort hierarchy genuinely untested** (§9) now that the probe can set
   effort.
6. **Destructive filesystem actions are not checkable after the fact** (§5).

## Method

- Real Electron build, real profile, real model, via
  `apps/desktop/tests/e2e/live-probe.mjs` with `REAL=1`.
- `PI_ADV_DEBUG_TOOLS` for the exact per-request tool list.
- Main-process output forwarded (this is what ended several guessing sessions —
  the renderer console and `status.error` were both silent for failures that were
  fully explained in main's log).
- Screenshots + store dumps per step; TTFT from keypress to first paint and to
  first text.
