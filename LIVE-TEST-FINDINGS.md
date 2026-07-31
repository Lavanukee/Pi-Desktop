# Live testing the 4B — what breaks, and why

Driving the real app with the real model (`qwen3.5-4b-mtp`, Q8_0, MTP draft) and
writing down what actually goes wrong. jedd's framing, which shapes the whole
document:

> there's literally no reason that the 4b model can't do anything like that, none
> of the individual steps are out of its reach or anything, it's not complex
> coding, it's totally doable stuff that we can fix in the harness without
> actually saying "if you get this task do this" or equivalent, we just need
> structuring better.

So every finding has to end in a STRUCTURAL fix — something that changes how the
harness presents work to the model — not a special case keyed to a task. Where I
can only see the symptom and not the structure yet, it says so.

**A theme runs through all of it.** In every case below the model wanted the
right thing. It said so out loud, in its own thinking, and then could not get
there — because a capability was absent, or present but unreachable, or reachable
but silently returned nothing. Not one of these is a reasoning failure.

---

## 1. `fetch failed` — none of this was testable until now

**FIXED — shipped `0b36241`.**

Every "live" probe in this repo has been driving an app that **never starts a
model**. `ensureChatServerReady()` returned early on `?piE2E` — the same flag
that unlocks `window.__pi_store` so a probe can observe the app at all.

> Making the app observable switched its model off.

The visible symptom was `fetch failed` on every turn, which reads as an inference
bug. It is not: the supervisor forks, idles, and pi fetches an address with
nothing behind it.

**Fix:** split the two intentions. `?piNoServer` (`PI_E2E_NO_SERVER=1`) skips the
boot for mock-pi runs that have no model to reach; `?piE2E` now only means "let me
see inside".

**Why it hid for so long:** the renderer console said nothing, `status.error` said
nothing, and the one line that named the cause (`[pi-diag]
ensureChatServerReady: …`) went to the main process's stdout, which the probe did
not forward. It does now.

> **Generalisable, and it recurs below:** a failure that surfaces as a two-word
> transport error gets blamed on the model. Every layer that can refuse to start
> needs to say so where the operator is already looking.

---

## 2. THE BIG ONE — vision never turns on, so the model cannot see its own work

**NOT FIXED. This is the most valuable finding in the document.**

Asked to *"take a screenshot of stripe.com's homepage and recreate its hero
section"*, the model did exactly the right thing and then died trying, over five
consecutive turns:

```
assistant: "The user wants me to: 1. Take a screenshot of stripe.com's h…"
assistant: "The user wants a screenshot of the Stripe homepage and a rec…"
assistant: "I need to see the actual visual appearance of the Stripe hom…"
assistant: "I need to get a screenshot to see the actual Stripe homepage…"
assistant: "The browser_snapshot tool isn't giving me useful information…"
```

It knew it needed to look. It tried four times. Then it correctly concluded the
tool was useless to it — and wrote the HTML blind.

**Root cause, from the same run's main-process log:**

```
llm:start-server requested { modelId: 'qwen3.5-4b-mtp', quant: 'Q8_0', launchMode: 'fast-text' }
```

`fast-text` was the only launch mode for the entire session. **No `mmproj`, so no
vision.** Any image handed back by a tool is tokens the model has no encoder for.

This is one level deeper than the bug I fixed earlier today. I made tool-returned
images actually reach the request (they were being filtered out entirely), and
extended `contextHasImage` to notice them. But *reaching the request* is not
*being seen*: the server has to be running multimodal, and nothing ever asks it
to switch mid-session.

**What it silently breaks** — every one of these is a task jedd named:

| Task | Fails because |
|---|---|
| Recreate a UI from a screenshot | never sees the screenshot |
| Draw bounding boxes on an image | never sees the image, so cannot locate anything |
| Image specialist's improve-loop | "LOOK at it, decide what is wrong" — cannot |
| Motion specialist checking frames | "check that frame 0, middle, last DIFFER" — cannot |
| Review its own work visually | the whole category |

### 2a. Blocker one: the projector was never on disk — FIXED

jedd's first instinct ("mmproj loaded at all?") was right, and it was worse than
not loaded. The default model's projector had been sitting as a **stranded
`.part`**:

```
620553303  mmproj-F16.gguf.part      # qwen3.5-4b-mtp — never promoted
175115840  mmproj-F16.gguf           # gemma-4-12b-it — fine
927607360  mmproj-F16.gguf           # qwen3.6-27b-mtp — fine
```

The catalog entry carried `bytes: 0` — a placeholder — and the download's
completion check read:

```ts
if (expectedSha256 === undefined && expectedBytes !== undefined && bytes !== expectedBytes)
  throw new DownloadError(`size mismatch: expected ${expectedBytes} bytes, got ${bytes}`);
await rename(partPath, dest);   // ← never reached
```

`0 !== undefined`, so **every completed transfer threw `expected 0 bytes, got
620553303` and the rename never ran.** The download could never succeed, no
matter how many times it was retried, and nothing surfaced that.

**Fix:** a zero expected size means *unknown*, not *expect nothing*
(`expectedBytes > 0`). Unit-tested both ways — the placeholder promotes, a real
expected size still rejects a short file. The 4B's real size (672,423,488, from
`unsloth/Qwen3.5-4B-MTP-GGUF`) is now in the catalog, and the projector is on
disk and verified (`GGUF` magic).

> The lesson is bigger than this file: **a placeholder was being enforced as a
> constraint.** Nothing said so, and the visible symptom was a model that
> appeared unable to use a tool.

### 2b. Blocker two: nothing asks for the switch — TRIGGER FIXED, relaunch unverified

With the projector present I re-ran the same ask. The server *still* launched
`fast-text` and only `fast-text`. The model again navigated, again asked for a
screenshot, again could not see it.

`ensureVisionMode()` already exists and works — but it is called from exactly one
place, `pi-connect.ts:382`, guarded by `messageNeedsVision({ imageDataUris })`.
That only sees images **the user attaches in the composer**. An image the MODEL
produces — a browser screenshot, a rendered frame, an image it just generated —
never reaches that check, so the relaunch is never requested.

**What now exists.** Three pieces:

1. The host publishes whether the running server can see (`PI_DESKTOP_VISION`),
   so the provider is no longer guessing.
2. When it cannot, the provider **replaces the image with an explanation** rather
   than shipping tokens the server has no encoder for. The model reads that
   images are unreadable right now and that retrying will not help — which ends
   the four-turn loop immediately, with no relaunch needed. The note deliberately
   does NOT promise sight is coming (an earlier draft did; that would only have
   moved the loop one turn later).
3. A screenshot taken while the server is text-only records a **vision want**,
   spent at the next `agent_end` — not immediately, because going multimodal is a
   hard restart of llama-server and firing it mid-turn would kill the very turn
   that took the screenshot.

**Confirmed live:** `ensureVisionServer: relaunching multimodal { modelId:
'qwen3.5-4b-mtp' }` fires, at the turn boundary, exactly once.

**NOT confirmed, and I will not claim it:** that the relaunch COMPLETES and the
next turn can actually see. In the verifying run the relaunch was requested and
then the following turn produced no token within 200s, and no success or failure
line followed. Either loading the 672 MB projector takes longer than the window,
or the relaunch stalls. `ensureVisionServer` logs a warning on failure and none
appeared, so it was most likely still in flight. **This is the next thing to
check**, and it may share a root with §5a below.

**The original statement of the fix, kept because the remaining half is exactly
this:** the same
`ensureVisionMode()` path must be reachable when a TOOL returns an image, not
only when a human attaches one. `contextHasImage(context)` in
`provider-llamacpp/src/stream.ts` is already the correct predicate and already
returns true for tool results (fixed earlier today) — it has no callers. The
honest interim behaviour, worth having regardless: when an image rides a tool
result and the server is text-only, **say so in the result**. The model then
reports "I cannot see this" instead of looping four times and concluding the tool
is broken.

Second, cheaper half: `browser_snapshot`'s screenshot is **opt-in via a parameter
buried in its description** ("Optionally attach a screenshot"). A model that says
"I need to see the actual visual appearance" is not going to discover a boolean.
When the model's intent is visual, the screenshot should not be a parameter it has
to find.

**Until this lands, every "look at what you made" instruction in every charter is
a promise the harness cannot keep** — and the honesty clauses I wrote into those
charters ("if you cannot see it, say so plainly") are currently the only thing
between that and invented critique.

---

## 3. Spinners re-aim themselves on every render

**FIXED (working tree).** Root cause was not a remount, which is what it looks
like:

```js
// packages/ui/src/components/spinner.tsx — before
const delay = { '--pd-loader-delay': `-${Date.now() % 1600}ms` };
```

That feeds `animation-delay` on both loader animations. Per spec, changing
`animation-delay` on a *running* animation updates it in place rather than
restarting — so re-deriving it from the clock on every render **re-aimed the arc
to a pseudo-random angle each time React re-rendered**. The jump could be up to
1600ms of an 1100ms rotation, which reads as snapping back.

It fired on every status change next to a spinner — the corp row status line, the
`m:ss` tick (1/sec), "Processing… Ns", the sidebar. Measured churning in the DOM:
`-1556` → `-1541` across two re-renders. That is "a lot of the time … constantly".

**Fix:** compute the delay once at mount, pinned to the document clock
(`-(performance.now() % 17600)`, the lcm of the two loader periods). This kills
the re-aiming *and* makes remounts invisible — a replacement element resumes at
its predecessor's angle, which immunises every spinner in the app against the
whole remount class.

Also fixed one genuine structural remount: `ActivityChain` keyed rows on their
**label**, which flips tense the moment a step settles ("Editing a file" →
"Edited a file"), remounting rows that were still running. Rows now carry the
tool-call id.

**Trade-off jedd should know about:** loaders are now phase-locked to each other
rather than staggered. Desync and remount-immunity are mutually exclusive here;
easy to revert to a stable per-instance random offset if the stagger is wanted.

---

## 4. Project selection: the click worked, nothing showed it

**FIXED (working tree).** The composer's project chip compared **two different id
spaces**. The dropdown's rows come from `useVisibleProjects()` (sidebar ids —
`cwd:<path>` for a folder, a `chatOrg` id for a user-made project) but `active`
read `useProjectStore.activeId`, the electron store's **path hash** (`p_1a2b`).

No row could ever equal it. So clicking a folder *did* select it — pi re-rooted,
the canvas file tree followed — but the menu showed no check mark and the chip
still read "No project". Indistinguishable from a click that did nothing.

Not the `getPiState`/`sessionChanged` race I expected. This is the other failure
mode this codebase keeps producing: **state lands in a namespace nothing renders
from.**

---

## 5. TTFT

Instrumented after the first runs, measured where the user actually feels it —
**from the Enter keypress to the first visible character**, not from the provider
request. Everything between those two points (queueing, a server that has to be
started, a tool prefix that got invalidated and forced a full re-prefill) is time
the user is sitting through, and reporting "provider TTFT" instead is how a
4-second wait gets logged as 200ms.

Two structural facts confirmed from the request logs, both good:

- **The advertised tool set never churned between turns.** Byte-identical across
  all 12 requests of the first run. That is the KV prefix holding, which is what
  it is for.
- **Capability activation APPENDS** rather than rewriting: 15 tools → 23 tools,
  with the original 15 unchanged and in order. A reused prefix stays a prefix.

### 5a. Two full minutes with nothing on screen — NOT FIXED, worst UX finding

The chained task (*find the Eiffel Tower page → download the photo → grayscale →
set as wallpaper*) measured:

```
[sent 1/3] Find the Wikipedia page … save it to my Desktop as eiffel.png.
[TTFT 1] NO TOKEN within 120000ms
[sent 2/3] Now make that image grayscale …
[TTFT 2] NO TOKEN within 120000ms
```

The model was **not** idle: 18 provider requests fired across the three turns (~6
per turn — it was working through tool calls the whole time). But for the first
two minutes of each turn the user sees nothing appear.

Whatever the attribution turns out to be, the UX conclusion stands on its own: a
turn that does real work for minutes must show that it is doing so from the first
second. Everything needed is already plumbed — llama-server emits
`prompt_progress` frames during prefill, the provider normalises them
(`promptProgressFraction`), and the harness publishes a fraction on the turn
status channel. Something between that and the first rendered block is not
landing. **This is the next thing I would chase**, and it is worth more than any
model-quality work: two silent minutes reads as a hang, and a user reaches for
the Stop button long before then.

Not yet attributed — candidates, in the order I would test them: the first
provider request genuinely takes that long to prefill; the model opens with tool
calls whose reasoning never renders a visible block; or blocks are only committed
to the store at turn end rather than streamed.

**Attachment prefill** (jedd's upload/large-paste question) — already built and
measured: a ~5k-token paste goes 3747ms → 290ms, because `buildAgentMessage` puts
file blocks *before* the typed text, so the primed prefix is byte-identical to
what is sent by construction. **Images are deliberately excluded** with a stated
reason (vision encode re-runs per request on the pinned build, so priming buys
nothing). Numbers per-run are in the appendix as they land.

---

---

## 6. Pause / resume — three symptoms, three different causes

**FIXED (working tree).** My starting hypothesis was wrong, and usefully so: the
provider's stream parser keeps all its accumulation state *inside* the per-call
closure, so a new turn always starts clean. Nothing carries over there.

**Raw tool calls + the "ghost close" share a cause, and it is not the parser.**
Resume does not go through it. `resumePausedChat` continues the frozen reply over
llama.cpp's **raw `/completion`** endpoint, which returns undifferentiated tokens
— no `reasoning_content` channel, no structured `tool_calls`. The renderer
appended every one of those into a **text** block. So a reply paused inside
`<think>` resumes its reasoning correctly, but that reasoning (and then the
literal `</think>`) lands in a *new* text block: the thinking block stops growing
— exactly the ghost close — and a `<tool_call>{…}</tool_call>` in the
continuation is just markup, never parsed. Fixed with an incremental splitter that
demuxes thinking / text / tool-call from the raw continuation, holding back
markers split across token boundaries.

**The dropped send is separate, and there were two of them.** `pausePi` never
lowered `promptInFlight`. Pause is reachable in the dispatch→`agent_start` gap
(the composer flips to Pause the instant Enter is pressed, and `ensureChatServerReady`
can hold a send for seconds), where `pi:abort` is a no-op inside pi — so no
`agent_end` ever arrives and the store wedges "busy" permanently. Every later
message then queues behind a drain that requires `!promptInFlight`: a faded bubble
that never sends. `abortPi` and `stopRunningForQueue` had the identical hole.
Second, the drain's idle check ignored `resuming`, so a queued send could fire
into the middle of a token-exact resume — two requests fighting the single slot,
evicting the very KV that makes resume exact.

Two more found in the same sweep: an aborted stream left a half-built
`{name:'', arguments:{}}` tool call in the persisted message (replayed next turn
as an unnameable `tool_calls` entry with no result — a prompt corrupted precisely
where tool-call framing lives), and `agent_end` without `turn_end` left the row
`isStreaming: true` forever, which makes `frozenPartialAssistant()` return null so
**Resume silently regenerates instead of continuing**.

**Known remaining gaps, deliberate:** a tool call in a *resumed* continuation is
now parsed and displayed, but cannot be **executed** — that path talks to
llama-server directly, outside pi, so there is no agent loop to run it. And a send
parked mid-await when Pause is pressed still dispatches afterwards.

---

## Still to run

Honest status — these were launched or planned but are not yet analysed, and I
will not write findings I have not observed:

- Motion-graphics request end-to-end through the chat (the renderer itself is
  verified separately: 5 frames, 5 distinct, live canvas previews).
- The long chained task (find → download → transform → set wallpaper).
- Max-effort Godot game exercising the full hierarchy.
- Per-run TTFT tables.

---

## Method

- Real Electron build, real profile, real model — `REAL=1` through
  `apps/desktop/tests/e2e/live-probe.mjs`.
- Ground truth per turn: `PI_ADV_DEBUG_TOOLS=<file>` logs the EXACT advertised
  tool list and system-prompt size for every provider request. **A tool the model
  "should have used" that never appears in that list is a harness failure, not a
  model failure** — that distinction does most of the work above.
- Main-process output forwarded, so supervisor/server errors are visible.
- Screenshots + store dumps per step; TTFT from keypress to first character.
