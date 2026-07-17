# Pi Desktop — Hierarchical Coordination Harness

## The complete architecture

This is the source-of-truth spec for the core of Pi Desktop: a **hierarchical coordination harness** that lets a local model — even a small one — produce work far beyond a single one of its turns, by organizing itself into a corporation of narrowly-scoped, differently-contexted workers.

It consolidates the full design conversation. Read [`subagent-architecture.md`](./subagent-architecture.md) for the founding vision and [`harness-corporation-walkthrough.md`](./harness-corporation-walkthrough.md) for a step-by-step run of the hardest case. This document is the build reference; those two are the *why* and the *story*.

---

## 0. First principles

1. **Structure is capability.** The corporation is not overhead bolted onto a model — it is the thing that lets a small model attempt something large, by never handing any one turn more than it can hold.
2. **Take weight off the model.** Give each participant *a focused amount* of work at the highest possible quality — not as little as possible, and never as much as possible. **100 sub-tasks of a few minutes each beat 5 sub-tasks of an hour each**, because the 5 collapse under their own load and ship low quality. Contract granularity is small and deliberate.
3. **Context defines the entity.** The same model weights under different context are genuinely different workers with different ideas. Diversity comes from *contracts, roles, and lenses* — never from randomness.
4. **The contract is law.** Whatever a worker thinks its purpose is, the typed contract governs the work. This is what makes prompts safe to vary and impossible to turn into a failure surface.
5. **Git + CI are ground truth.** No agent holds the whole program; the compiler does, and it is deterministic.
6. **Robustness is external.** As much as can be handled by the harness (repair, gating, scheduling) rather than by asking the model to be careful, is handled by the harness.

The north star: *a user can prompt a local model and get any high-quality artifact out, reliably — not by luck, but because the harness squeezes the model's real potential through directed refinement.*

---

## 1. Modularity — the swappable engine boundary (non-negotiable)

The coordination harness is **one implementation behind a stable interface**, never fused to the UI. We must be able to later offer users opencode, a custom pi setup, or a different harness entirely, and have them drive the exact same UI with a clean swap.

```
┌────────────────────────────────────────────┐
│  UI (chat, canvas, situation room, models)  │   ← never imports the harness directly
└───────────────────────┬────────────────────┘
                        │ CoordinationEngine interface (typed, stable)
        ┌───────────────┼───────────────┬─────────────────┐
        ↓               ↓               ↓                 ↓
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Corporation  │ │ Plain pi     │ │ opencode     │ │ custom / BYO │
│ harness (us) │ │ (solo agent) │ │ adapter      │ │ adapter      │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

**`CoordinationEngine`** is the contract the UI depends on. Draft surface:
- `startTask(prompt, ctx) → taskHandle`
- `steer(taskHandle, text)` — mid-run guidance, no seam
- `abort(taskHandle)`
- **event stream**: `status`, `org-chart update`, `activity`, `artifact`, `checklist update`, `eta`, `permission request`, `done`
- `getOrgChart(taskHandle)` — for the situation room

Our corporation harness implements this. A trivial "solo pi" engine also implements it (and is what runs for small/simple tasks — the corporation is just the solo engine that grew). The UI subscribes to the events and never knows which engine produced them.

**Build rule:** nothing in `apps/desktop/src` (renderer) may import the harness internals — only the engine interface + plain DTOs over IPC. This keeps the swap clean and preserves the renderer-barrel discipline.

---

## 2. The three dials (and the one we prune later)

| Dial | Controls | Source |
|---|---|---|
| **Scope** | how much hierarchy exists (solo → full corporation) | the model, via `create_production_hierarchy`, adapting as the project grows |
| **Memory / compute** | parallel *width* — `llama-server -np N`, N chosen for max aggregate throughput | hardware, live |
| **Effort** | review *thoroughness* / the "good enough" bar | the user |

**We design the maximum-capability system, then prune to effort levels later.** Do not design five effort tiers up front; build the full corporation and calibrate what to cut empirically once it runs. Effort is the *last* thing we tune.

Scope drives hierarchy depth — **not model size.** A 4B handed a huge task builds the full corporation; that is precisely what lets it attempt the task. Model size only changes how finicky coordination is, and good structure is the bet that makes even a 4B workable.

---

## 3. Model tiers — hands vs. brain

One model runs at a time on consumer hardware, reused via `-np` slots. But roles map to *dispositions*, and we split by strength:

| Role | Model | Why |
|---|---|---|
| **Engineers / workers** | `qwen3.5-4b` (default) | tool-heavy agentic impl, precise tool-call formatting — its strength |
| **CEO + managers** | a heavier / advisor-class model *(to validate)* | vision, contracts, direction, quick mockups — judgment, little tool-calling |
| **Specialists / peer advisors** | advisor-class model (e.g. **1-bit Bonsai-27B**, mainline-viable) | world knowledge + judgment returned as *text* — tool-formatting weakness is irrelevant |
| **Conversational / weakest machines** | `gemma-4-E2B` | chat, simple web/tool, short responses; the sub-8 GB floor |

The advisor insight (Phase-important): a heavily-quantized 27B is *ideal* for the CEO/manager/advisor tiers, because those roles output **judgment as prose, not tool calls** — so the quality that quantization costs (precise formatting/tool syntax) is exactly the quality those roles don't need, while the world knowledge they *do* need survives. **This is a hypothesis to validate by testing**, memory permitting (worker + advisor ≈ 7.4 GB resident; sequence on tight machines).

**Roles map to capability *tiers*, never to hardcoded models.** The corp is model-agnostic: each role resolves to one of three tiers — `fast` / `balanced` / `intelligent` — and the engine turns a tier into a concrete model *per hardware*. Reasoning/judgment roles (CEO, manager, **architect**, and every advisory reviewer) are `intelligent`; the code-execution roles (engineer, division-head) are `balanced` — capable agentic implementation without spending the top tier's memory on every worker. The mapping lives in `packages/harness/src/corp/prompts.ts` as `ROLE_TIER` (+ `tierForRole(role)`), and it *only ever names a tier*. **Resolution path:** the engine reads a role's tier via `tierForRole`, then resolves that tier → a real catalog model + quant for this Mac's RAM via `resolveTierModels(hardware)` in `packages/inference` (the existing recommender, which returns `{ fast, balanced, intelligent }`). So on a <8 GB machine `intelligent` may resolve to a small model and on 64 GB to a 27B+, **with zero change to any corp code** — the live model-selection wiring is the memory-scheduler slice, not this one; the corp just publishes the label.

---

## 4. The corporation — roles

- **CEO** — the original solo agent, promoted. Writes/holds the **vision**; approves the final product; issues global broadcasts; never writes code or contracts. Context stays *minimal and clean*: it only ever holds the vision it wrote and the finished product handed back. Modes: **ASK** (surfaces options on ambiguity) vs **INTERPRET** (synthesizes an interpretation that *becomes* the task) — a user setting, asked at onboarding.
- **Manager block** — a *permanent* layer directly below the CEO (the CEO does not invent it). Writes the typed **contracts**, knows where things go, builds and edits the **queue**, proposes org-chart mutations (add/cut divisions) for CEO sign-off/veto. Holds structure — not necessarily the full vision.
- **Divisions** — created by the managers per the work (e.g. Frontend, Backend, Storyline, Gameplay, 3D-Assets, UI/UX). Each has a base system prompt from a **predefined library** (manager block, specialists, and common archetypes like general frontend/backend dev are all predefined); managers may *lightly* extend a base prompt for a custom division, but this can never cause failure because the contract governs.
- **Division head (adaptive)** — *if* a division's work is still too large for its engineers, a division-head layer does one more split (manager → division-head → engineers). **Depth grows only when the work justifies it** — the same "hierarchy grows with scope" principle applied one level down. *(Whether this extra layer is needed by default is a testing question — see §12.)*
- **Engineers (L2)** — hold one contract + their files + type-only imports. Nothing else.
- **Specialist registry** — callable from any level directly (not routed through the hierarchy). Two families:
  - **Advisory reviewers** (output = judgment text, evidence-grounded — they *measure*): `visual-critic` (a tuned model, later), `security`, `performance`, `accessibility`, `correctness/integration`.
  - **Heavy modality specialists** (run a big non-LM model in an exclusive memory window): `image-gen` (with a VLM-improve loop), `motion-graphics` (with video-model vetting), `3d-gen` (trellis), `audio-gen`.

---

## 5. The org-chart data model (the backbone)

A single **per-project** artifact (JSON on disk), the spine everything reads/writes. It is what the situation room renders and what a crashed run resumes from.

```
OrgChart {
  projectId
  nodes: Node[]            // CEO, manager(s), divisions, division-heads, engineers, specialists
  contracts: Contract[]    // typed task specs
  queue: QueueEdge[]       // dependency DAG over contracts (A∥B → C)
  branches: BranchRef[]    // per-node git branch/worktree
  status: per-node/contract state
}

Contract {
  id, title, ownerNodeId
  input, output            // typed
  slot                     // where the output plugs in
  available: { tools[], imports[] }   // the declared tool + import set
  reviewRubric             // what this will be reviewed against (seeded before impl)
  dependsOn: contractId[]
  workspace?: 'shared' | 'isolated'   // decided at division init (§9)
  status: queued | ready | in-progress | in-review | merged | unfulfillable
}
```

Projects are a **directory feature** (grouping conversations that share a working directory that isn't a per-chat sandbox); the org chart persists at the project level and is **shared across the project's chats**. The concrete serialization schema is a build detail; its *content* is fixed above.

---

## 6. Scheduling

- **Dependency DAG.** Managers build the queue ordered by dependency. Managers **queue, they don't start** — a contract runs only when its prerequisites clear. Independent work goes "off to the side" and runs whenever there's capacity. `C` needs `A,B` (independent) → `A ∥ B → C`. **Parallel is always optional**: if hardware can't run A and B at once, they serialize — correctness never depends on parallelism, only speed does.
- **Memory scheduler.** Heavy non-LM specialists (trellis, comfy, a review model) cannot co-reside with the worker LM. They get **exclusive memory windows** — unload the LM, run the heavy job, reload. Asset generation for a dependency-root division naturally runs *up front*.
- **`-np` throughput governor.** N = argmax over N of `N × per-slot-throughput(N)`, bounded by KV-cache fit (1 worker @ 50 tok/s vs 3 @ 30 → run 3). qwen3.5's hybrid attention (~4× less KV) lets far more workers fit. Overflow queues.

---

## Integration layer — the shared architecture pass

The DAG in §6 assumes cross-division edges exist, but never said **how one gets created**. Real-model testing (qwen3.5-4b) exposed the gap: when every division's manager plans in isolation, the plan is a **federation of siloed backlogs** — *zero* cross-division dependencies (a manager can't see another division's contract ids to depend on), and **silent semantic duplication** (three divisions each build a start-menu at three *different* file paths, so the exact-string slot detector reports "clean"). Divisions plan against nothing shared, so nothing connects them.

The fix is a shared **architecture, produced up front, that every division builds against.** It slots in between promotion and manager contract-writing:

*promotion → **architect turn** → per-division manager turns (seeded) → resolve handles → sweep → DAG.*

- **The architect** is a lead-architect role that runs *once*, before any contracts, on the **`intelligent` tier** (thinking-off like the manager — it emits structured JSON). Given the vision + the divisions, it defines the canonical **module map** — one clear region per division, no overlaps — and the key typed **interfaces** one division exposes for others to consume. It writes no code and no contracts; it defines the shared shape. (`corp/architect.ts`: `ARCHITECT_PROMPT`, `buildArchitectPrompt`, `parseArchitecture` — the parse reuses the tolerant salvage/repair ladder from `contracts.ts`.)

- **The `Architecture` artifact** (on the org chart, `corp/org-chart.ts`) has two parts:
  - `moduleMap: ModuleEntry[]` — `{ path, owner /*division*/, purpose }`: the canonical file/dir layout, one region per division. This is where duplication dies — there is one place each thing goes.
  - `interfaces: InterfaceHandle[]` — `{ name, exposedBy /*division*/, path /*slot*/, summary, consumedBy /*divisions*/ }`: the cross-division seams. This is the artifact that makes a cross-division dependency **expressible**.

- **Seeding the managers.** Each manager's contract-writing turn is seeded (`buildManagerContractPrompt(division, vision, architecture)`) with (a) the module-map region *this* division owns — target files there, do not invent a parallel structure — and (b) the interface handles, with the rule: when your work needs something another division produces, **express it by adding the interface handle NAME to that contract's `dependsOn`** (e.g. `dependsOn: ['iface:GameState']`) — do not reinvent it. The 6–12 granularity cap and terminator are unchanged.

- **Resolving the handles at assembly.** A pure resolver (`corp/integrate.ts`, `resolveInterfaceHandles`) rewrites each `dependsOn` entry of the form `iface:<Name>` to the concrete **contract id in the exposing division** that produces that interface's `path` (the contract whose `slot` equals the interface path, else the first contract in that division). That rewrite is what yields **real cross-division edges.** Unresolvable handles (naming no known interface, or an exposing division that wrote no contracts) are left in place and dropped by the existing `sanitize` sweep as dangling ids (recorded). Then `buildOrgChartQueue` runs exactly as before — sweep → DAG → break cycles.

The metric the whole layer exists to raise is the **cross-division edge count** (a siloed plan has zero). The slice-3 driver (`scripts/slice3-driver.mjs`) runs the full flow live (or `--dry-run` against a fixture) and reports `architectureModuleCount`, `interfaceCount`, `crossDivisionEdgeCount`, `perDivisionContractCounts`, `sweepRepairs`, `dagAcyclic`, and a `topoOrderPreview`.

- **Token budgets are config robustness.** Generation-heavy role turns — the **manager** writing a whole division's contract JSON, and later the **engineers** — need an *adequate* token budget (~16k), well above the judgment turns' cap. A verbose division emits ~10–12 KB of contract JSON, and a too-tight `max_tokens` silently **truncates**: in one real qwen run the reply was cut off *before its first contract object even closed*, so `parseManagerContracts` recovered 0 and an **entire division vanished from the plan** with no error. This is the "robustness is external" principle (§0.6) applied to *config*: a cap that's too tight loses whole units of work invisibly, so the driver floors the manager turn at ~16k. (The parser is hardened in tandem — a first-object truncation now yields its one partial-but-complete contract rather than nothing — but the real fix is not to truncate.)

---

## 7. Execution & quality

- **Contract dispatch** hands each engineer only its contract. Isolation is the point — an engineer can run a 100-file project because no turn holds 100 files.
- **Peer & specialist consults.** An engineer can `call_peer` (a *clean-context* instance of its own division) or `call_specialist`. *To validate (§12):* whether consults may propose file edits / web-search / write notes back to the requester, or return advice only. Advisors (§3) run the heavy model since they return prose.
- **Submission interceptor (quality gate, no second model).** The **first** time a worker calls "submit/done," the harness bounces it back with an auto-generated self-review prompt: *re-read your contract; does the result meet it; does it look right; is there anything you'd improve before submitting?* Cheap, model-free, and — hypothesis — reliably cuts carelessness. *(To validate: does it measurably improve quality?)*
- **Engineering handbook** (carried in every contract): the one rule — *good code is legible to a worker who does not share your context* — generating typed boundaries, small single-responsibility units, house-style consistency, intent-carrying names, explicit dependencies, tests at the boundary, contained blast radius.

---

## 8. Review, merge, and the false-completion cure

- **Review runs at the merge step, as its own memory phase.** Unload the worker → load the reviewer → review each branch → once each is up to par, reload the worker → merge → **CEO final review** (CEO-only for now). No two-big-models juggling.
- **The CEO can't rubber-stamp itself — structurally.** It never received the build. Its context is exactly *"here's the vision, managers, get it done"* → *(work happens out of sight)* → *"here's the finished product; we think it's done — review it."* So it reviews as a genuinely different entity. **Guardrail:** the manager→CEO handback must be the *clean artifact* (product + "meets spec?"), never the build transcript.
- **Reviews are evidence-grounded** — the reviewer measures (runs tests, screenshots + measures layout), never opines.

---

## 9. Failure, control, and safety

- **Escalation = conflict radius.** An impossible contract returns upward *"unfulfillable, because X"* and escalates **one level**: managers (who hold the queue/roadmap) adapt — re-contract, re-scope, reorder — and only reach the CEO if the vision is at stake. First stop for a stuck engineer is a **peer/specialist consult**, then the manager.
- **Permissions default = a static denylist** of known-dangerous ops (`rm -rf`, etc.), flagged by rule, **no LLM reviewer in the loop.** Full manual review remains an option nobody's expected to use.
- **Git isolation** via a floating *"Pi wants to use git — Approve / Deny"* prompt above the input (with a prominent "What's this?"). Approve → real repo; Deny → a hidden **shadow repo** so coordination/rollback still work. Agents get isolated branches either way; managers merge.
- **Isolated per-division workspace** (a contract flag, decided at division init): some divisions get their own working directory to avoid collisions. *(To validate: when is isolation worth the overhead?)*
- **Human steer / escape hatch.** The always-present chat input steers the running corporation (guidance to the CEO, no seam). *Open:* running the CEO to handle a steer when memory is maxed — no clean answer yet.
- **ETA honesty.** Show a *range that narrows* as contracts complete, never a fake precise countdown.

---

## 10. Repair robustness (hardened — no second model)

The tool-call repair ladder must be *incredibly robust*, especially for weak-formatting models. Beyond today's rungs 1–5 (which cover malformed argument JSON well), we add — **without any model-based checking**:

- **Rung 0 — text-content reconstructor.** Scan assistant *content* for a tool call written as prose/markdown (the biggest gap today: such calls never enter the ladder) and reconstruct it into the structured path.
- **Fuzzy tool-name matching** — an unknown/misspelled tool name maps to the nearest registered tool.
- **Deeper schema validation** — catch extra/unknown props, nested errors, enums, and constraints, not just top-level presence/type.
- **Real rung-4 relaxation** — actually re-register a looser schema for the session, instead of only logging.

This is what makes the advisor tier safe to eventually promote toward tool-using roles, and makes every worker more bulletproof.

---

## 11. The situation room

The canvas view of the corporation working — engagement, not a spinner. The hierarchy drawn as it grows (nodes pulsing when their worker is mid-turn); a file map lighting up as agents touch files; the **checklist as the DAG** (division-name dropdowns → ordered tasks with checks, driven *directly from contract state* — no model tool-call overhead); the plan; a narrowing **ETA**; and a **"peek at what we have so far"** button. The peek doubles as the safety valve — see it going wrong, steer it.

---

## 12. Open questions — to resolve by testing 1:1 with deployment

These are settled *by running real models end-to-end*, exactly as deployed, and tuning until they work — not by argument:

1. **Promotion trigger** — does the worker reliably call `create_production_hierarchy` when (and only when) scope demands? (Wire "if you feel this is beyond your scope, call this tool.")
2. **Contract quality & granularity** — do managers write contracts that execute well? Are they over-splitting or over-loading? Judge by whether contracts execute cleanly.
3. **Abstraction depth** — is manager→engineer enough, or do we need the manager→division-head→engineer split by default?
4. **CEO/manager model** — is a *more powerful* model better for CEO/managers (little tool-calling, mostly direction + mockups)? Likely yes — validate.
5. **Pseudocode/mockups in contracts** — do managers writing directional pseudocode/mockups alongside contracts improve outcomes?
6. **Submission interceptor** — does the self-review bounce reliably raise quality / cut carelessness?
7. **Stuck → escalate** — does the unfulfillable-contract → peer → manager re-contract pipeline actually recover?
8. **Tooling edge cases** — e.g. the 3D game must be built in Godot/Unity (connectors pre-installed): do the created divisions get the *right* tools initialized?
9. **Org-chart mutation** — do managers correctly add/remove divisions across follow-up prompts (and not leave dead ones)?
10. **Merge robustness** — does the system get stuck at merge?
11. **Peer-review capabilities** — advice-only, or may consults edit/search/write/note?
12. **Isolated workspaces** — when is per-division isolation worth it; decide at init?
13. **Memory-maxed steer** — how to run the CEO for a user steer when memory is full.

---

## 13. Build plan

**Phase 1 — Foundation (stable, non-behavioral).** The `CoordinationEngine` interface + the solo-engine adapter; the org-chart/contract/queue data model + per-project persistence skeleton; the role registry + predefined system-prompt library (as structured data); the hardened repair ladder (§10). Everything here is needed before any real-model test and is unlikely to change with tuning.

**Phase 2 — Behavior (the heart — iterative, real-model tested).** Promotion + `create_production_hierarchy`; manager contract-writing + the queue/DAG scheduler; dispatch + isolation + consults + the submission interceptor; review-at-merge + CEO sign-off; escalation. Built and then **tuned against real models end-to-end**, one scenario at a time (§12), across model sizes, adapting prompts until the flow works exactly as deployed.

**Phase 3 — Surfaces & scale.** Situation room; the `-np`/memory scheduler under real load; the modality specialists (which also lights up the gen workflows that are currently designed-but-unwired); advisor-tier wiring; effort pruning.

The heart is Phase 2. It is not a one-shot build — it is build-run-observe-tune, repeated, because "does a 4B manager write a good contract" is answered by watching it try, not by specifying harder.
