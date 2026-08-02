# Roadmap — current

Ordered. Each stage assumes the one above it works.

---

## Where we are

The failures we started with were almost all **capabilities that existed but
could not be reached**: vision blocked by three stacked bugs, generation pointing
at a worker that was not there and a backend that could not run, a team the model
was never told it had *and* was simultaneously instructed not to use, DRY that
could not see the text that loops. Those are fixed and measured.

What changed underneath is that we can now SEE. The probes drive a real model,
forward the main process, log the exact advertised tool list per request, and
measure TTFT from the keypress. Most of the findings came from that
instrumentation rather than from reading code — and twice it caught a diagnosis
that was wrong.

**The one thing that has never happened: a corp run completing.** Not once. Every
attempt died to something else first (the DRY loop, the cached team prompt, the
prompt contradicting itself, the org-chart entry fee). All four are fixed and the
manager's submit gate, the tester commission and the vision-anchored
`DO NOT SUBMIT` line have still never executed.

---

## 1. CORP HARNESS ← we are here

The core of getting large work out of a tiny model, and the least proven thing we
have. Expect this to take a while and to surface several more bugs of the kind
above.

- Get a run to COMPLETE, end to end.
- Verify `present` live in the same run — it is new, unproven, and its whole value
  is the forcing function. If the model does not reach for it, it is inert. The
  manager's gate says "verify as the user"; `present` is the mechanism.
- Produce the complete corp document from a real run.
- Delegation is 3/5 with 0/6 over-delegation. Harness blockers are gone; the
  residual is the 4B under-estimating build size (measured directly: asked
  point-blank with no tools in play, big builds answer SOLO 4/6, small tasks
  answer SOLO 8/8). Revisit only if a structural lever appears.

## 2. Lemonade — evaluate

AMD's open-source local inference server (Ryzen AI NPU + Radeon), OpenAI-compatible.

**Why it is worth looking at:** the fastest route to *shipping something that
works on hardware we cannot test ourselves*. We already talk to an
OpenAI-compatible endpoint through one indirection (`baseUrl` /
`PI_DESKTOP_UTILITY_BASE_URL`), so pointing at Lemonade is a backend swap, not an
architecture change.

**Honest caveat: I have not used it and cannot verify its claims.** Treat the
evaluation as real work, not a formality. What to establish:
- Does it genuinely install and run unattended on a stock AMD machine?
- Is the OpenAI surface complete enough for us — streaming, tool calls with a
  grammar, `logit_bias`, DRY or equivalent sampling? (Our tool-calling depends on
  grammar-pinned function names; a server without that changes model behaviour.)
- Vision / mmproj equivalent?
- What it costs us to supervise: another runtime to install, update and monitor.

**Frame it as an alternative BACKEND behind the seam we already have.** If it does
not fit that shape, it is not worth the second supervisor.

## 3. Connectors / skills / scheduled tasks

The ideal, and the thing to design toward: **zero instructions for the user, one
click, and the target app is connected.** An extension injected into Blender that
turns on its MCP surface. The same for Unity. The same for whatever else.

Nobody should read a setup guide. The mechanism is not yet designed — that is the
work.

## 4. Access from anywhere / universal hotkey

Quick chat and screenshot from any app, configurable keybind. (Already sketched in
`roadmap.md` item 4.)

---

**At this point the core vision of the project's initial prompt is fulfilled.**
Everything below is expansion.

---

## 5. Clustering + other platforms

- Ubuntu and Windows native.
- Multiple machines over Tailscale, work scheduled across them.

Scoped already: the core is portable; the blockers are three mechanical things
(Linux llama.cpp binary in the manifest, `hardware.ts` returning RAM 0 on
non-Darwin, no linux/win electron-builder target). The expensive part is that
`pi-mac`, the connectors and computer-use are new implementations per platform
rather than ports. Two seams are already indirected and would carry most of the
clustering: `ComfyClient.resolveOrigin()` and the inference `baseUrl`.

## 6. Autonomous fine-tuning / specialising models

**Strictly after 5.** It needs the other hardware and the machine-to-machine
connection to be real first — fine-tuning on one Mac is a much smaller idea than
fine-tuning across connected machines.

---

## Not on this path, but open

- **First-60-seconds dead end** (from `UI-UX-REVIEW.md`): dismissing the
  model-download modal still sends the message, and the chat hangs forever with no
  model, no error, no explanation. Small fix, worst thing a new user can hit.
  Worth doing whenever there is a gap.
- `experimentalGeneration` is currently ON in settings (backup in the scratchpad).
  Now that the tool-name conflict is fixed it is what makes image and motion
  reachable, but it is jedd's call.

## Companion documents

- `LIVE-TEST-FINDINGS.md` — what broke, per task, with traces.
- `HARNESS-FIXES-REPORT.md` — every finding and the evidence it is fixed.
- `UI-UX-REVIEW.md` — a new user's first sixty seconds.
- `roadmap.md` — jedd's own file. Not edited by me.
