# Corp harness — first completing runs

Six runs, 2026-08-01. Forced corp (`?corpForce`), max effort, qwen3.5-4b-mtp,
identical prompt: a complete 2D platformer in Godot 4 at a named path.

Promotion was **forced**, not chosen — the model's own promotion decision measures
3/5, and a run that exists to prove the harness completes cannot be a coin flip.
Task content was never touched.

---

## The milestone

**A corp run completed end to end, twice.** It had never happened before.

| | run 5 | run 6 (clean testbed) |
|---|---|---|
| outcome | `completed` | `completed` |
| elapsed | 5m11s | 3m12s |
| team | 18 (CEO, manager, 4 engineers, 12 specialists) | same |
| verdict | `(no reply)` | a real briefing |
| files | 7, one location | 10, one location |
| strays outside the target | none | none |

---

## What jedd reported, and what was actually wrong

> "it finished but no presenting, I can't as the user go and see the run even
> primitively following its instructions going to the folder and the file and
> pressing f5, won't do anything. it hasn't installed godot or looked for an
> installation or run any visual tests or used the present tool."

### ✅ FIXED — the folder was empty because the files went somewhere else

Not a fence refusal, which is what I first reported. The fence refused the
requested path and its error said *"use a relative path like `corp-run`"*. The
model complied, that resolved against the working folder, and the whole project
was built at `/Users/jedd/Desktop/corp-run` — eleven files, no error, and a reply
naming the path that had been asked for. One earlier run wrote to **both**
locations (different roles, different roots): a project torn in half, which is
why F5 does nothing even once you find the folder. Same mechanism produced
`/Users/jedd/Desktop/Users/jedd/Desktop/platformer_game`.

`3e63fcb` — an absolute or `~`-anchored path under HOME is honoured; writing a
path out in full is what intent looks like. Bare relative names stay fenced; a
direct child of HOME (`~/notes.txt`) stays refused, because that is the spill the
fence exists for.

**Verified live:** runs 4 and 6 wrote 8 and 10 files, each entirely inside the
requested directory, with zero strays on the Desktop. Three runs before the fix
produced strays every time.

### ✅ FIXED — `present` could not fire in a corp run at all

Registered for the top-level agent, and in **no corp role's allowlist**. The
building produced the artefact, wrote a verdict about it, and left the user to go
find their own deliverable. `52cf918` gives it to the CEO alone — the one role
that has spoken to the user and whose reply they read. Everyone else reports
upward, so "no subagent ever has this" holds unchanged.

### ✅ FIXED — the runtime rule never reached the corp harness

"Establish the program exists before you build for it" lived only in
`CAPABILITY_PROMPT`. The corp mesh preamble is entirely separate text, so the
building actually writing the Godot project never read it. `037a7bb` puts it in
the preamble, where every role gets it.

### ✅ FIXED — an empty verdict said nothing

Run 5's entire verdict was `(no reply)` after five minutes and seven files,
because the CEO exhausted its per-message step budget mid-tool-loop. Its own
status update said so — *"I've now made ~30 tool calls without reporting back"* —
and none of it reached the caller. `2552d26` distinguishes a spent budget (names
the count, tells the caller to ask for a summary) from genuine silence.

---

## STILL BROKEN — what run 6 proves is not fixed

These are behavioural, and the prompt changes did not move them.

### ❌ No Godot check ever ran

**Correction:** I first reported this as "Godot is not installed". It is —
`/opt/homebrew/bin/godot`, 4.7.1. My check was stale, carried over from an
earlier session.

That makes the failure worse, not milder. A capability probe already runs
`godot --version` at task start and briefs the team on what this machine has, so
the team was told Godot was available. Every mention of "godot" in run 6's logs
is still only inside the CEO's own prose — *"then the project opens in Godot and
all requested features work"* — with no invocation anywhere. It asserted the
project runs in an engine that was installed, present in its briefing, and one
command away, and never ran it.

### ❌ `present` still never called

Allowlisted and named in the CEO charter, and the run still ended without it.

### ❌ The submit gate did not hold

The verdict ships work it knows is broken, in its own words: *"Sprites have
syntax errors"*, *"they're empty placeholders"*, *"**2 minutes** to fix"*. The
`DO NOT SUBMIT UNTIL YOU ARE CERTAIN` line did not stop it.

### ❌ It hands the work back, and to the wrong person

The final verdict is headed **"## Manager Briefing"** and ends:

> "Shall I finalize the sprites and open the project for you to verify everything
> works?"

Two failures at once. The reply that reaches the user is addressed to a manager,
so the CEO is passing a subordinate's report through rather than judging it. And
it closes by asking the user to authorise work it was already told to do — the
exact hand-back the prompt forbids.

### ❌ It claims files that do not exist

*"I've created 4 sprite files (Player.svg, Platform.svg, Coin.svg, Enemy.svg)"*.
None are on disk. The ten files that exist contain no `.svg` at all.

---

## Reading of this

Four fixes were **reachability** bugs — a capability that existed and that
nothing could get to. Those are now measured fixed, and that class is close to
exhausted: `present` in no preset, then in no allowlist; the runtime rule in a
prompt the building never reads; the fs fence relocating instead of refusing.

What is left is different in kind. The harness now completes, keeps files where
they belong, and carries the right instructions to the right roles. The remaining
failures are the 4B not *acting* on instructions it demonstrably received — not
checking, not presenting, not holding its own gate, and describing work it did
not do. Prompt text has stopped being the lever; the next moves are structural
(make the check a step the harness performs rather than asks for) or a bigger
model for the CEO seat.

## Environment note

Run 5 was spoiled by testbed contamination: the CEO found a prior run's
`PlatformerGame` and adopted it instead of building the requested project. My
fault, not the harness's. `~/bobble-testbed` is now archived to
`~/bobble-archive` and runs start clean.
