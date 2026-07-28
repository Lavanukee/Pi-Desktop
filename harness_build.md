# Harness build

The plan for the coordination harness — what we are building toward, what is
actually there today, and the order we get from one to the other.

Companion to `roadmap.md`. That file is the product; this one is the machine
underneath it. Mirrors the live task list (A1–A8, B1–B3, C1–C3, D1–D3, E1, F1–F2).

---

## 1. The vision

**A project has a team, and the team persists.**

Not subagents. A subagent is a stranger you brief from scratch every time, who
knows nothing about what changed while it was dormant. That is the wrong shape
for a codebase someone comes back to for months.

Instead: when a project starts a corp run, we stand up an org — a CEO, managers,
divisions, engineers, specialists — and **that org is saved with the project**.
Each role is a real, long-lived agent session with its own accumulated context.
The SFX engineer knows the audio code because it wrote the audio code, and it
still knows it next week.

**Every role is a full agent, prompted like a person.**

A manager handing an engineer a contract is doing exactly what jedd does when he
opens a chat and asks for something: a message into an ongoing conversation with
someone who has the whole toolset — read, write, edit, bash, grep, web search,
browser, python — and who works in the real tree. Not a templated completion, not
a constrained JSON emitter. The same harness the user gets, scoped to a role.

So "improve the SFX" becomes: vision forms, the manager talks to the SFX engineer,
and the engineer — already holding the context of the module it owns — thinks
*"right, I need to regenerate this sample and swap the path on line 40 of
audio_bus.gd"*, and does it.

**The mesh is the runtime, the ledger is the truth.**

Roles talk to each other freely (`talk_to`, `commission_specialist`) — that part
should be emergent, because asking for help is exactly the thing you cannot
schedule in advance. But **what counts as done is never a conversation outcome.**
Completion is a command exiting 0. The conversation is free; the bookkeeping is
code.

**The model calls for help; help is never forced on it.**

No review passes, no adversarial passes, no per-effort critique counts. A model
that needs a second opinion asks for one. A trivial turn costs a trivial amount.
Effort buys a corp run more budget, not a chat turn more scrutiny.

---

## 2. The 4b rule

Everything here is designed to be run by a 4B model. That is the constraint that
makes it robust — if a 4B model can drive it, a larger one sees near-zero
failures, and we can *relax* rigidity for speed later. Building the other
direction does not work.

Concretely, that means:

- **Never ask for a large structure in one turn.** One item per turn, via a tool
  call with a flat schema. Code holds the shape. (`parseManagerContracts`
  currently "salvages complete contracts from a reply truncated mid-array" — that
  is the code admitting the ask is too big.)
- **Never ask it to merge.** Three-way reasoning over a serialized scene file is
  hopeless at any size we will run.
- **Never ask it whether it is done.** Run something.
- **Never leave it in an open-ended peer loop with no ledger.** Four small models
  in an unbounded conversation converge on "great work everyone". Free
  conversation is fine *because* the ledger contradicts them.
- **Give it eyes.** The current engineer is deliberately blinded (isolated dir
  seeded with only its dependencies) because it wandered. The fix for wandering is
  framing and an explicit list of the files you own — not amputation.

---

## 3. Ground truth — where it actually is today

Verified by reading the code on 2026-07-28, not from memory. **The corp harness
has never completed a run.** The individual modules are heavily unit-tested (pure
functions behind injected seams); the *system* is unproven. `.corp-runs/` contains
only 3D-studio and dictation probe output — no corp artifact has ever existed.

| Claim | Reality |
|---|---|
| The org/hierarchy is stored | **No.** `corp/persistence.ts` serializes an OrgChart and says *"Skeleton only. Nothing live reads or writes this yet."* Zero callers outside its own tests. |
| Roles keep their context | **No.** `role-agent.ts:1040` uses `SessionManager.inMemory()`, and `runRoleAgent` does `mkdtempSync` for a fresh agent dir **per call**. Every turn is a brand-new session, discarded. |
| Mesh agents remember | **Barely.** `mesh-host.ts` keeps `Map<agentId, string>` and replays it as *text* in the next prompt, capped at `MAX_MEMORY_CHARS = 8000`, tail-truncated, in-memory, dead at end of run. A pasted summary, not a conversation. |
| Roles have the full toolset | **No.** `ENGINEER_BUILTIN_TOOLS = read, write, edit, bash, grep, find, ls`. The web-research and browser factories exist in the seam impl but gate on names that never appear — **no corp role can search the web or read documentation.** |
| Engineers know the codebase | **No, by design.** Engineers run in an isolated workspace seeded with only their dependency files, *"so there is nothing to wander."* |
| A contract can edit code | **No.** `Contract.slot` is one path; `writeSlot(root, slot, content)` overwrites a whole file; slots must be distinct after the sanitize sweep. There is no verb for "edit". |
| Anything is executed | **Almost nothing.** `verify.ts` is per-file. `preflight.ts` is a *static* import walk scoped to products with an `index.html`. Nothing runs the product. |
| The environment is handled | **Not at all.** Nothing acquires or verifies godot, ffmpeg, libreoffice, pandoc. |

Two systems exist in parallel: the deterministic `runCorp` pipeline (vision →
architect → contracts → engineers fill slots → assemble → verify → CEO), and the
`AgentMesh` (persistent peers talking via `talk_to`). **The vision above is the
mesh.** The pipeline is a different animal, and its guarantees are the ones worth
keeping — so the end state is the mesh as runtime with the pipeline's ledger and
gates underneath, not one replacing the other.

---

## 4. The build

Phases are ordered so each one is provable before the next depends on it.

### A · Mesh sessions are real and persistent  ← **current**

The load-bearing change. Everything downstream assumes a role is somebody rather
than a series of strangers.

- **A1** One live pi session per agent — a pool keyed by `agentId`, created once,
  reused. Stable agent dir.
- **A2** Disk-backed sessions — retire `SessionManager.inMemory()`; every role
  turn appends to a real session file.
- **A3** A turn is a message into the living session — delete the 8k replay.
- **A4** Wire `persistence.ts` — roster, prompts, peers and each agent's
  `sessionPath` saved per project.
- **A5** Rehydrate on reopen — the same engineer, mid-conversation, after a
  restart.
- **A6** Lifecycle bounds — idle eviction, live-session cap, transparent resume.
- **A7** Survive compaction — a role that works for hours rolls its context; pi
  compacts natively, so verify it fires and the role stays coherent. **Measure
  this before reaching for any memory store.**
- **A8 — GREEN GATE** On the real model: a manager talks to an engineer twice,
  minutes apart, the second message referring to the first, and the engineer
  answers correctly **with nothing replayed into its prompt.**

### B · Roles get the real toolset and the real tree

- **B1** Engineers work in the shared tree; fix wandering with framing and a
  "files you own" manifest.
- **B2** Full tool surface — web search, browser, python.
- **B3** File-ownership registry — one owner per file at a time; an edit to
  someone else's file is a request to that owner.

### C · The work ledger and the execution gate

- **C1** A contract owns a *set* of paths and produces *edits*. The single
  biggest structural blocker for anything real.
- **C2** Done is a command exiting 0.
- **C3** The whole product must run — generalize `preflight` past web.

### D · Capability ledger and provisioning

Not a permission system. jedd's call: full capability, no artificial constraints,
guard destruction hard at the terminal layer (including its python spellings —
`shutil.rmtree`, `os.remove`, redirects, `dd`, `mkfs`).

- **D1** Record what toolchains exist and work — a *planning input*, so nobody
  writes twenty contracts against a binary that is not installed.
- **D2** Contracts whose deliverable is a command, not a file.
- **D3** Blocked work is recorded and routed around, never fatal. An overnight run
  survives one missing binary and leaves a short list of what needed a human.

### E · Prove it

- **E1** First green run on the file converter scoped to **three** formats, with
  a product that genuinely runs. Debug the machine here, not on the flight
  simulator.

### F · Chat-side simplification (independent of A–E)

- **F1** No forced reviews at any effort. Escalation is a tool.
- **F2** `tool_search` without the re-prefill: return the schema as the tool
  *result*, accept the call against the full registry, promote it into the formal
  definitions at the next compaction — where we re-prefill anyway, so it is free.
  Nothing constrains us (`stream.ts` passes `body.tools` with no grammar).

---

## 5. Lessons

Every failed or disappointing run, what it actually was, and what changed. Kept
in the order they were hit, because the order is itself information — the early
ones are all "the machine could not start", the later ones are about the work.

**L1 · A TypeScript parameter property stops the whole run before a single agent
speaks.** First live run died at import: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` from
`constructor(private readonly runTurn: RunAgentTurn, …)` in `mesh.ts`. The
real-server drivers load these modules directly under Node's *strip-only*
TypeScript, which erases types but cannot TRANSFORM syntax — and a parameter
property is a transform. `role-agent.ts` already carried this rule in its header
("no relative value-imports so the smoke can load it") but it was never written
down as a constraint on the corp modules generally, so I reintroduced it in
`AgentPool` and `TeamBook` the same afternoon. **Rule: no parameter properties,
no enums, no decorators, no namespaces anywhere the drivers import.** Plain
fields, assigned in the constructor body.

**L2 · Half the team could not read documentation, and engineers could not
edit.** The mesh roster shipped `ceo/manager: ['read']`, `engineer: ['read',
'write', 'bash']`, `specialist: ['read', 'bash']`. So: nobody could `web_search`
(the seam's research factory gates on that NAME being in the allowlist, so it was
never even installed), no one could `ls` an unfamiliar tree or `grep` for a
symbol, and an engineer could only ever CREATE files — it had no `edit`, so
"change this line" was not expressible. For "wire up ffmpeg" or "build this in
Godot", where most of the work is looking things up and modifying what exists,
that is not a limitation, it is a hard stop. Roles now carry the full working
set: file tools + shell + research, with `tool_search` on top.

## 6. Known-hard, deliberately deferred

Recorded so they are decisions rather than surprises.

- **Godot `.tscn` is unmergeable** — a flat serialized node tree with
  `ext_resource` ids. The way out is to **generate scenes from code**, so the
  merge surface is GDScript (ownable, mergeable) and the scene is a regenerated
  artifact. Also gives a headless execution gate for free.
- **Art assets** — this app already has a working 3D generation pipeline. A
  flight sim's planes can come out of it rather than blocking the run.
- **Per-role semantic memory (cognee et al.)** — deliberately NOT in the plan yet.
  A rolled engineer does not need to remember, it needs to re-read: its contract,
  the files it owns, and a short append-only decision log. Humans do not remember
  their code either. Add a vector store only once A7 shows reading is not enough.
- **The CEO/architect genuinely does need memory** — "we tried X, it failed
  because Y". That is a small append-only file, not a database.
