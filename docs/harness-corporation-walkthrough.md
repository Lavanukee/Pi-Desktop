# The Corporation in Motion

## A mental simulation of the hardest flow — and the holes it exposed

This document stress-tests the [subagent architecture](./subagent-architecture.md) by walking a single, deliberately brutal request all the way through the system, step by step, and stopping at every point where the design was thin. Each stop is marked **⚠ Hole** (what wasn't specified) followed by **✓ Resolved** (the decision we landed on).

The point of the exercise: a design that only works in the happy path isn't a design. Running the worst case in your head surfaces the plumbing you forgot you needed.

**The scenario.** A user opens a brand-new chat. The loaded model is `qwen3.5-4b` (our default worker). They type:

> *"Build me a production-ready 3D game — real rigged assets, optimized, with a storyline."*

One prompt. No project yet. A 4-billion-parameter model. This is the request that, handed to a solo agent, produces the classic catastrophe: a confident *"Done! Here's your game 🎮"* attached to a single broken HTML file. We want the opposite outcome, and we want it from a *small* model. Here's how the corporation gets there.

---

## Phase 1 — Intake and the moment of promotion

The turn begins like any other. Semantic tool-search runs over the prompt and pre-activates the plausibly-relevant tools; the model is primed with the light line *"these look relevant — and you can do anything else, just search for it."*

Then the model reads the request and, in its own chain-of-thought, reaches the thought every small model reaches on a task like this: *"this is beyond what I can do in one pass."* The difference is what happens next. Instead of ploughing ahead and faking a result, it calls **`create_production_hierarchy`** — the tool that turns that realization into an action.

**⚠ Hole #6 — will a 4B actually pull the trigger?** A frontier model reliably recognizes over-scope and structures the work. A 4B might just start coding and fail the classic way.

**✓ Resolved.** Two things, and neither is worth losing sleep over. First, models are already *good* at the classification "this is beyond my capability" — so the work is simply wiring that judgment to *"if you feel that way, call this tool,"* which is a testable prompt detail, not a research problem. Second, a cheap scope classifier can nudge, and the wander/loop detector is the backstop: a solo agent that starts thrashing on an over-scoped task gets escalated toward structuring. Promotion is the model's call, with a net under it.

The moment it promotes, the original solo agent **becomes the CEO**. It doesn't forget what it was doing — it keeps the vision — but its job just changed.

---

## Phase 2 — The CEO writes the vision (and nothing else)

The CEO does one thing here: it synthesizes the user's intent into a clear, semi-structured **vision brief** — instructions plus deliverables — and hands it down. Not implementation. Direction. *"A third-person 3D game, this tone, this scope, these deliverables. Make it real and shippable."*

Crucially, the CEO's context now contains essentially two things and stays that way: **the vision it wrote**, and (later) **the finished product handed back for review**. It never accumulates the build. Hold that thought — it's the whole trick behind Phase 9.

**On vague requests.** If the user had instead said *"make it feel more premium and modern,"* and they're in INTERPRET mode (a settings toggle, asked at onboarding), the CEO researches, forms a concrete interpretation, and **that interpretation becomes the task** — pushed down to the managers exactly as a user request would be. From the managers' point of view there is no difference between "the user asked for X" and "the CEO decided X means this." In ASK mode, it surfaces a few concrete options to the user first instead.

---

## Phase 3 — The managers build the company

Below the CEO sits the **manager block** — a permanent role the CEO does *not* invent (it's always there). The managers read the vision and decide the structure: for this game, divisions like **3D-Assets**, **Storyline**, **Gameplay**, and **UI/UX**. They write the typed **contracts** and lay out the plan.

**⚠ Hole #1 — where do divisions get their identity?** "Frontend division" needs a system prompt. If the CEO/managers invent those from scratch every time, that's an unbounded failure surface.

**✓ Resolved.** There's a **library of predefined system prompts** — for the manager block (fixed, never CEO-decided), for the specialists, and for common division archetypes (general frontend dev, backend dev, etc.) that establish good practices up front. When managers spin up a custom division, they may *lightly tune or extend* a base prompt — but this is deliberately simple and **can never be a cause of failure**, because of the isolation principle: **the contract is the contract.** Whatever a division "thinks" its purpose is, the typed contract is what actually governs the work. The system prompt is flavor; the contract is law.

**⚠ Hole #3 — dependencies, not just parallelism.** Storyline feeds Gameplay; assets feed Gameplay; UI needs game state. Fanning all four divisions out at once produces pieces that don't integrate.

**✓ Resolved.** The managers build a **queue — the roadmap of contracts — ordered by dependency**, and they can read and edit that queue freely as things evolve. **Managers don't *start* tasks; they queue them until prerequisites clear.** Work with no ordering constraint goes "off to the side" and runs whenever there's capacity. Work with a real dependency waits: if C needs A and B, but A and B are independent, the queue is **A ∥ B → C**. And the parallel bars are always *optional* — if the hardware can't run A and B at once, they run one after the other; correctness never depends on parallelism, only speed does.

This queue-of-contracts, plus the division registry and per-node status, **is** the org-chart data model — the persistent backbone that everything else reads (the situation room renders it; a crashed run resumes from it).

---

## Phase 4 — Getting a place to work

Every agent works on its own branch — but the user's directory might not even be a git repo, and we can't scatter branches through their working tree without asking.

**⚠ Hole #2 — git isolation in an arbitrary directory.**

**✓ Resolved.** The first time the system wants version control, a **small floating prompt appears right above the input bar: "Pi wants to use git — Approve / Deny,"** with a prominent **"What's this?"** that expands a one-line explanation. Approve → a real repo. Deny → a **shadow repo** the system keeps out of sight, so coordination and rollback still work and the user is never forced into git they didn't want. Agents get isolated branches either way; managers own the merges.

---

## Phase 5 — The memory scheduler earns its keep

The 3D-Assets division needs to *generate* assets — which means running a heavy model like TRELLIS. On a consumer Mac, you cannot hold TRELLIS and the language model in memory at once.

**✓ This is why the memory scheduler exists.** It sequences: run the heavy generative work in its own **exclusive memory window** (unload the LM, generate the assets, reload the LM), rather than pretending everything is a peer sharing slots. Asset generation for a dependency-root division naturally runs *up front*, before the divisions that consume those assets even start.

For the language work itself, there's only ever **one model, reused** — `qwen3.5-4b` running with `llama-server -np N` parallel slots. N is chosen to **maximize aggregate throughput**: if one worker runs at 50 tok/s but three fit at 30 each, we run three (90 > 50), bounded by KV-cache memory. When memory only fits one, the workers just run one after another — same result, less speed. And because qwen3.5's hybrid attention uses ~4× less KV, far more workers fit than a dense 4B would allow.

Every one of those `-np` workers shares weights but holds a *different contract* — which, per the architecture's core insight, makes each a **genuinely different worker with different ideas**. Diversity here comes from context, not randomness.

---

## Phase 6 — The divisions work

Contracts go out. Each implementation agent receives only what it needs: input types, output types, the injection slot, its available imports (as types), its branch. It knows nothing about the other divisions, the overall game, or even the full vision — and that's the point. A 4B can *run* a 100-file game because no single turn ever contains 100 files' worth of context.

If an agent gets stuck, it doesn't spin: it asks a **peer in its division** or calls a **specialist**. If it hits something genuinely impossible, see Phase 10.

Every engineer works to the same **engineering handbook** (carried in the contract): the one rule that generates all the others is *"good code is legible to a worker who does not share your context"* — typed boundaries, small single-responsibility units, house-style consistency, intent-carrying names, explicit dependencies, tests at the boundary, contained blast radius. In a company of differently-contexted workers, that legibility isn't aesthetic — it's what makes the merge possible.

---

## Phase 7 — The user watches (and the checklist tells the truth)

None of this should read as a spinner labeled "10 million subagents running." The **situation room** in the canvas shows the corporation as it actually is: the hierarchy drawn as it grows, files lighting up as agents touch them, the plan, and a "peek at what we have so far" button.

The checklist is the DAG made visible — and it updates itself. **No model wastes a tool call to tick a box**; the harness drives the checklist directly from contract state. It's organized as **dropdowns: the top level shows division names, and expanding one reveals that division's tasks in dependency order, with checks on what's already done.**

**⚠ Hole #8 — the ETA has to be honest.** Early on the decomposition is incomplete; a precise "17:42 remaining" is a lie waiting to embarrass us.

**✓ Resolved.** Show a **range that narrows** — "~15–40 min" at the start, tightening as contracts complete and the rubric fills in. Honest uncertainty reads as competence; a fake countdown reads as a lie the first time it slips.

---

## Phase 8 — Review happens at the merge, as its own memory phase

When a division's branches are ready, they need review — and the best reviewer (including the tuned visual critic) is a *separate model*, which competes for the same memory as the workers.

**⚠ Hole #4 — the reviewer's memory budget.**

**✓ Resolved by sequencing, not co-residency.** Review runs **at the merge step**: unload `qwen`, load the reviewer, and let it work across each branch. Once every branch is up to par, reload `qwen` and perform the merges. The reviewer gets its own clean memory window exactly like a heavy generative specialist does — no fragile juggling of two big models at once.

Reviews are **evidence-grounded**: the critic *measures* (runs the tests, screenshots and measures the layout) rather than opining. That's what makes "good enough" objective and what makes the visual critic worth training.

---

## Phase 9 — The CEO signs off (and why it can't rubber-stamp itself)

The integrated product comes back up to the CEO for final approval.

**⚠ Hole #5 — if the same model that built it "reviews as CEO," does it just approve its own work?** This is the single most important detail: the entire cure for the *"I did it"* false-completion depends on the reviewer being a genuinely fresh perspective.

**✓ Resolved — and the structure gives it to us for free.** The CEO never held the build. Its context, from its own point of view, is exactly:

> *"Here's the vision, managers — get it done."* → *(work happens entirely out of its sight)* → *"Here's the finished product; we think it meets the bar — can you review it?"*

So when the CEO reviews, it is **already** a different entity from the workers, not because we forced a context reset but because it simply never received the implementation. It drives and tests the product against the vision *it* wrote, with a harness prompt to *"submit to the user only if it meets the standard."* The one guardrail: the manager→CEO handback must be the **clean artifact** (the product + "meets spec?"), never the full build transcript — keep that clean and the isolation is automatic. *(Per this design's own principle: context defines the entity. The CEO is a different being because it holds different context.)*

If it approves, it submits. If not, it sends specific notes back down to the minimum distance — the exact division or agent that owns the gap.

---

## Phase 10 — When things go wrong (they will)

**Impossible contracts.** A division hits an asset that won't rig or an API that doesn't exist. It must not spin.

**✓ Resolved.** A contract can be returned upward — *"unfulfillable, because X"* — and it **escalates exactly one level**: the managers, who hold the system queue and roadmap, **adapt** — re-contract, re-scope, or reorder — and only escalate to the CEO if the vision itself is at stake. Failure travels the minimum distance, same as everything else.

**Permissions at scale.** "Review every tool call" is a courtesy nobody actually runs, and it's unusable with ten agents acting at once.

**✓ Resolved.** The default is a **static denylist of known-dangerous operations** (e.g. `rm -rf`) — flagged by rule, **no LLM reviewer in the loop** to slow things down or burn a model on judgment calls. Full manual review remains available as an option, but it isn't the path we optimize for.

**Steering mid-run.** The chat input is always present; typing into it **steers** the running corporation — delivered as guidance to the CEO, no fake user turn, no seam.

---

## Open / loose ends (noted, not yet solved)

- **Running the CEO while memory is maxed.** If the machine is at full memory mid-run and the user steers, we may not have room to spin the CEO up to handle it. No clean answer yet — flagged, left loose on purpose.
- **The org-chart data model** needs its concrete schema written (nodes, contracts, queue edges, branch refs, status) — its *content* is now defined by the phases above; the serialization is a build detail.

---

## What the simulation proved

The architecture survives the worst case — a 4B model shipping a production 3D game — because **no participant ever carries more than it can hold**: the CEO holds vision, the managers hold structure, the engineers hold one narrow contract each, and git + CI hold the whole truth deterministically. The corporation isn't overhead bolted onto a small model; it's the thing that lets a small model attempt something far beyond a single one of its turns. Structure is the capability.
