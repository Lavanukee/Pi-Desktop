# Phase-2 build journal — decisions, evidence, and every lingering question accounted for

The heart of the harness (spec §13 Phase 2) is *build → run real models → observe → tune*. This is the "every piece of the puzzle and question we had lingering at the start … accounted for and documented" record. Companion to the source-of-truth `harness-architecture.md`.

> Status: the acceptance run (the observed Three.js 3D-game build) is the final gate; its outcome is recorded at the bottom.

---

## 1. The central correction — no role runs bare

The first Phase-2 build ran each corp role as **one bare `/chat/completions` call** (the `CorpChatFn` seam) — a shortcut that diverged from the design (§4/§7: workers are agents with tools). At 3D-game scale it surfaced as qwen **"overthinking"**: some engineer turns rambled to the 16k ceiling (~15,400 tokens, ~3.7 min/turn), pushing the run toward the wall-clock cap.

**Root cause (owner's call, validated): qwen overthinks precisely when run bare — no harness, no tools.** Inside an agentic harness (tools to act with + a submission tool to finish), the model tethers to the task and self-terminates.

**Fix — every role is a scoped pi `AgentSession`** (`role-agent.ts` + the injected `RunRoleAgentFn` seam; the harness stays pi-agnostic, chat fallback kept for the driver/tests). Evidence:
- Bare engineer: max single-turn **~15,400 tok** (rambled to ceiling). Harnessed: **~1,281 tok**, clean stop, wrote via tools, ~10–16s/turn.
- Full multi-engineer + CEO-revise run harnessed: **no runaway on any role** (max ~5,900 tok).

## 2. No per-agent limits (owner principle)

The only control points are **setup** (system prompt + tools + contract + task) and, for engineers, the **final check** (the submit self-review). Between those a role runs fully autonomously — any tools, as much/long as it wants, until *it* submits. **No per-agent step-cap or timeout.** The sole net is the global `RunBudget` (turns + 90-min wall-clock — the "no year" guarantee at the *run* level) plus a per-individual-CALL network abort (a hung HTTP request degraded to empty — §197). Bump-to-continue, escalation, and the review bounce *add* attempts; they never cap.

## 3. Sampling — the corp registers its own provider

pi has no native `top_p/top_k/min_p/penalty` support, and the app's `llamacpp-stream` provider doesn't fire pi's payload hook. So the corp registers its **own in-process `openai-completions` provider** at the local server and injects the owner's qwen profiles via `before_provider_request`: engineers→thinking-coding (temp 0.6, top_p 0.95, top_k 20, presence 0); judgment→thinking-general (temp 1.0, presence 1.5); structured→instruct-general (temp 0.7, top_p 0.8). `preserve_thinking` off; rolling context.

## 4. Engineer execution realigned to spec (§7/§8/§91/§164/§182)

- **Isolated workspace** (default): each engineer's cwd is a fresh dir seeded read-only with only its deps' produced files; it writes its module there; dispatch **harvests** (diff vs seed) into the shared product tree = the merge (the architect's non-overlapping module map keeps it clean). `Contract.workspace==='shared'` opts back in.
- **`submit_contract` = the §164 interceptor**: first call returns the self-review bounce ("re-read your contract, improve"), second call verifies the slot file exists then finalizes.
- **Scoped, lore-free prompts**: a role sees only its scope — no CEO/manager/corporation lore.

## 5. Recovery pipeline (§7/§9/§12-Q7/Q11)

- **Bump-to-continue** (bounded 2): an engineer that ends without submitting AND with no file is re-prompted to finish or declare unfulfillable. Lifted completion 64%→75% on the fixture.
- **Escalation re-dispatches** (bounded 1): the re-scope manager turn (was a discarded no-op) now yields a re-dispatchable contract that runs once; recovered → gap closed. Fixture hit 100% after recovery.
- **Consults** (advice-only, depth cap 1): `call_peer` + `call_specialist` in the engineer allowlist; advisors spawn read-only with no consult tools; each charges the RunBudget.

## 6. CEO vision-forming turn (§4, §12-Q5)

The raw task no longer goes straight to the architect. A harnessed CEO **vision turn** runs first (read/write/bash/**web_search**/submit_vision, thinking-on, no cap): researches, drafts a vision brief + optional quick-mockup (scratch-isolated so it never pollutes the product), iterates, submits. The brief seeds the architect + managers. The false-completion cure is preserved by the review input's *shape* (no transcript field) — the CEO judges the product against the vision it wrote.

## 7. Specialist review-at-merge (§8)

Pipeline is now **assemble → verify → review-at-merge → CEO sign-off**. The advisory specialists (correctness/security/performance always; visual-critic/accessibility when renderable, flagged render-limited) run as harnessed read-only agents that **measure via bash** (build/typecheck/tests/scan) and file findings. A blocking finding re-dispatches the affected contract (bounded, reuses the revise bound) → re-assemble/verify. Validated: a deliberate build flaw was caught (cited `file:line`), fixed via bounded re-dispatch (verify FAIL→PASS), then the CEO signed off over the findings — transcript-free.

## 8. The situation room — live and honest (§11)

- **Live activity**: agent turns stream file-touches mid-work (the map lights the right region as an engineer writes), nodes pulse per turn, and a **per-node live tool-call transcript** feeds the click-through.
- **Peek** works on a real run (`corp:peek` reads the current product tree on demand — real files, not the mock).
- **Live-view fixes** (owner feedback while watching): progress "X of N" ticks up as engineers complete (was stuck at 0); **only actually-running nodes light** (queued/failed stay dim); the left pane is **never blank** and **follows the running node** (pin/Follow-live); the click-through shows real tool calls, not a static briefing; **no overlap**; **per-section collapse** + **adaptive reflow/auto-collapse** at narrow widths.

## 9. App-level robustness (server management — the goal's "no OOM / no collapse")

Two boot-time crashes were found by preflight (the `.mjs` validations run as ESM and never hit them; only the packaged CJS app does) and fixed:
- **pi SDK ESM/CJS**: `@mariozechner/pi-coding-agent` is ESM-only; a static value-import compiled to `require()` → boot crash. Fixed with a cached dynamic `import()` (bundle keeps a real `import(`).
- **inference-supervisor**: rolldown co-bundled main + supervisor, so the forked utility process ran `main.js`'s top-level (`app.isPackaged`, undefined in a utility) → crash → **no model server**. Fixed by building the supervisor as its own isolated pass. Proven: server starts (phase `ready`), corp runs, and closes with **no orphan** (no zombies on quit — server reaped on app close).

## 10. Parallel dispatch — benchmarked away on single-GPU

The `-np` throughput dial was built (concurrent DAG dispatcher, OOM-safe K, `--parallel K` with `-c 16384×K`) but **benchmarked to ~no gain on a single Apple GPU**: single-stream **72 tok/s** vs 3-concurrent **75.8 tok/s aggregate** (slots share one GPU). So the corp **defaults to sequential (K=1)**; parallel is opt-in for multi-GPU/servers. Divergence-by-evidence, documented.

## 11. Run safety — config cannot stall a run (the "no year / no loop / no OOM" guarantees)

- Global **`RunBudget`**: turns (plan-scaled) + a 90-min wall-clock hard net, charged before every model turn; on exhaustion the run terminates gracefully, assembles what exists, and still runs the terminal CEO verdict. **Test-proven** against always-empty / always-REVISE / always-error mocks.
- Every loop bounded: retry-on-empty=1, escalation re-dispatch=1, CEO revise=maxRevisions(1), dispatch=finite DAG walk, bump-to-continue=2, consult depth=1. Per-role ≥16k generation floors (no silent truncation); structured roles thinking-off (no runaway `<think>`). A hung call is aborted→degraded-to-empty.
- Sequential K=1 = one 16k slot = **bounded KV, no OOM**. Denylist gates every corp `bash` (rule-based, no LLM — §9).

## §12 open-question status

| # | Question | Status |
|---|---|---|
| 1 | Promotion trigger | **ANSWERED** — promotes reliably; "stop after the tool call" nudge |
| 2 | Contract quality/granularity | 6–12 cap + terminator built; quality is a live-tuning outcome |
| 3 | Abstraction depth (division-head?) | **DEFERRED** — layer defined, not instantiated (a testing question) |
| 4 | Heavier CEO/manager model | **DOCUMENTED / DEFERRED** — tier labels set; tier→model resolution is Phase 3; all roles run the one 4B today |
| 5 | Pseudocode/mockups in contracts | **ANSWERED** — CEO vision turn researches + quick-mockups |
| 6 | Submission interceptor raises quality | **BUILT** (§164 bounce, both paths) |
| 7 | Stuck→escalate recovers | **ANSWERED** — escalation now re-dispatches (was a no-op) |
| 8 | Right tools per division | **MECHANISM BUILT** — managers author `available.tools`, engineers consume; good subsets are live-tuning (full set correct for JS/web) |
| 9 | Org-chart mutation across prompts | **DEFERRED** — full rebuild each prompt today |
| 10 | Merge robustness | **BUILT-by-design** — isolated → harvest; no branch-merge conflicts |
| 11 | Peer-review capabilities | **ANSWERED** — consults are advice-only |
| 12 | Isolated workspaces worth it | **ANSWERED** — default isolated; lifted write-rate, zeroed stray reads |
| 13 | Memory-maxed steer | **DEFERRED** — steer plumbing exists, live steer is Phase 3 |

## Lingering questions from the start — both sides, accounted for

**Owner's opening asks:** harness modularity/swap → BUILT (CoordinationEngine boundary, DTO-only renderer). Chat-template pull + `--jinja --chat-template-file` → the app auto-fetches the Qwen template from HF; jinja default-on. Hierarchy by *scope* not model size → BUILT (a 4B builds the full corporation via promotion). "It IS a different entity" (context defines the worker) → BUILT (per-role scoped context/prompts). Parallel width to max throughput → dial BUILT, benchmarked-away on single-GPU (documented). Predefined division prompts + light extension → BUILT (`composeNodePrompt`). CEO signs off / vetoes contracts → BUILT. Checklist = DAG, managers queue-not-start → BUILT. Static denylist, no LLM reviewer → BUILT + now wired to corp bash. CEO context structurally clean (false-completion cure) → BUILT + validated. Escalate one level → BUILT (re-dispatches). Never Q4 for <12B → all <12B run Q8. Roles→capability tiers, model-agnostic corp → tiers BUILT; per-hardware model resolution deferred. Advisor tier (heavier CEO/manager/bonsai) → insight documented; resolution deferred; vision/advisor get web search. Heavy modality specialists (trellis/VLM/hyperframes) → foundation wired (gen stack, gated flag); corp-integration is Phase 3. Situation room to watch for hours → BUILT + made live/honest/collapsible. Effort dial → deferred (spec says tune last).

**My uncertainties, resolved by running:** the manager 0-contract "runaway" (once thought a template bug) → really the bare-completion overthinking; cured by harnessing + thinking-off + sampling. Thinking on/off by turn kind → structured off, judgment on; validated. CEO false completion → the CEO correctly REVISED an incomplete product. Parallel benefit → refuted by benchmark on this hardware. Engineer write-reliability → isolation + submit-review + bump/recovery. The two app-boot crashes + the done-count/live-view → found by preflight, fixed.

## Deferred to Phase 3 (spec §13 — documented, not built)

Role→tier→per-hardware model resolution (the heavier-CEO/advisor insight); the `-np`/memory scheduler at scale; the heavy modality specialists as corp `call_specialist` entries (image VLM-loop, 3d/trellis, video, audio — the gen foundation is wired behind an experimental flag); the effort/thoroughness dial; git isolation + shadow repo + branch merge; org-chart persistence/crash-resume; CEO ASK mode + global broadcasts; the division-head adaptive layer; live human steer. Each is a deliberate Phase-3 item, not an oversight.

## The acceptance run

*(Recorded on completion of the observed Three.js run: total time, phases, completion, whether the system held up end-to-end with no collapse/loop/OOM, the produced game, and the CEO's verdict.)*
