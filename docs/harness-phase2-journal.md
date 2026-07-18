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

## Session 2 — UI reframe, run-safety, acceptance (2026-07-17/18)

After the harness was built and validated (§1–§12), a second session reframed the live UI, removed an over-tight safety net, and drove the acceptance runs. Every change was built in tested slices and verified live on the running app.

### A. The 90-minute cap was wrong — replaced by a no-progress watchdog
The original RunBudget carried a hard 90-min wall-clock cap (§11) as a "no year" belt-and-suspenders. In practice it only TRUNCATED legitimate long work (it cut off both the 3D-game run and the Breakout run mid-build). The run is already bounded WITHOUT it: the plan-scaled turn cap × the per-call network abort makes even a misbehaving model terminate (every loop bounded, dispatch a finite DAG). So the absolute cap now **defaults to DISABLED**, replaced by a **no-progress watchdog** (`budget.ts` `markProgress` / `stallWindowMs`, default 30 min): the run terminates only if it makes NO forward progress — no builder writes a file, no stage turn completes — for the window. A run grinding forward is never cut; a stuck one still dies. The budget summary now reports which net ended a run (`turns` / `stalled` / `wall-clock`). Harness suite **729/729**; watchdog unit-proven (stall trips `stalled` with turns+clock to spare, `markProgress` resets it, explicit-0 disables it). An opt-in absolute ceiling remains for a future snappy low-effort mode.

### B. Over-decomposition is the real pace lever (not parallelism)
Observed on real runs: the per-CONTRACT pace is fine (~2–3 min for an engineer to read deps, think, write, self-check), but the architect DECOMPOSES heavily — "polished Breakout" → 38 contracts, richer Snake → 28–41. On a single GPU those run sequentially (parallelism benchmarked to ~0 aggregate gain, §10), so total wall-clock scales with contract COUNT. This is bounded + coherent (not a stall/loop/OOM — no "year"), but it makes "max effort" as tuned thorough-and-slow. The lever to speed it up is TIGHTER decomposition (a CEO/architect scoping dial), not more parallel width. Top live-tuning item.

### C. The live UI reframed — "you never left your chat"
The situation-room canvas TAKEOVER (it replaced the chat thread AND opened a bespoke org-chart room on submit) felt like leaving the conversation. Reframed:
- **The chat stays the chat.** On submit the ORIGINAL model streams inline immediately (a "Getting started…" bridge during the ~30–60s server boot, then the agent's live feed) — never blank. A prompt that stays SOLO is just answered in the chat, no situation room (verified: "Neon Snake" solo in 2.4 min).
- **The situation room returns to the CANVAS, opens only on PROMOTION** (the chart grows past the root). It is a clean **subagent navigator** — each row a bold name + live current action in the EXACT chat `ActivityRow` (same icon/spinner/SVG) — plus the checklist, progress rail, gated Build-snapshot. Org-chart tree, file-map, and the separate activity bar retired.
- **Click a subagent → its stream shows in the chat.** The chat auto-follows the DEEPEST producing node (the engineer streaming code), so it streams live output the whole run; a click pins one. (`followTarget` originally preferred the top-of-hierarchy "working" node, which sat on the idle-coordinating Lead and left the chat static — flipped to follow the producer; canvas tests updated.)

### D. The corp feed renders like the real chat (Markdown, not raw text)
The feed rendered agent `message` text through a bespoke plain-`<span>` streamer — so prose was unformatted and a manager emitting its contracts as JSON assistant-text (by prompt design) dumped a raw blob. Fixed: `message` lines now render through the app's real `<Markdown>` (react-markdown + fenced `CodeBlock`), identical to normal chat; a JSON message renders as a boxed ```json block (large ones collapse into a "Structured output" reveal), never raw; streaming poll tightened 350→120 ms. Tool-call/thinking rows already reused the shared `ActivityChain`. Verified live: an engineer's turn streams a Markdown bulleted plan + a fenced TypeScript code block, exactly like the real chat. (A per-token PUSH channel — replacing the 120 ms poll with real deltas for byte-identical smoothness — is the one remaining polish item, pending owner sign-off on whether the tightened poll suffices.)

## The acceptance run — outcome

The terminal outcome is now recorded DURABLY (a `outcome-<taskId>.json` sidecar + a main-log line written the instant a run terminates — independent of the renderer, so a verdict can never again be lost to a window navigating away).

**Held-up evidence across runs:**
- **3D Three.js game (run 1):** 43 files / 7,718 LOC across all 5 areas, coherent cross-module imports (engine ← levels/player/physics), one render loop — the merge held. Ran to the (then-90-min) cap without collapse/loop/OOM; truncated by the OLD cap, not a failure.
- **Breakout:** 27 files / 7,804 LOC, real ball/paddle physics, 6 live nodes — merge held; ran ~85 min bounded, truncated by launcher timing.
- **Snake (solo):** completed NATURALLY in 2.4 min — the worker judged it simple, stayed solo, produced a complete polished "Neon Snake" (start screen, HUD, rising speed, sound) as its verdict. Clean natural completion + captured verdict on the solo path.
- **Snake (promoted — the FINAL observed acceptance run):** **COMPLETED NATURALLY in 50 min** (2026-07-18, no cap — the watchdog never tripped because it kept advancing). The full hierarchy ran end-to-end: CEO vision → promotion → **32 nodes / 28 contracts** across areas → engineers wrote in isolated workspaces → harvest/merge into **28 files / 4,016 LOC** (single self-contained web game, no external deps) → specialist review → **CEO SIGN-OFF**. The verdict is a structured assessment table, every verification check passing — single executable web game, start menu + difficulty selection (`src/ui/overlays/start-menu.tsx`), keyboard-controlled gameplay (`src/logic/movement.ts` / `control.ts`), progression system. Preserved to `~/Desktop/pi-snake3-game`. This is the definitive proof the hierarchical harness holds up the entire way autonomously to a clean natural completion with a real CEO verdict.

**Did it hold up autonomously, no breakdown?** YES — proven by the completed 50-min Snake3 run and corroborated across all runs: no role endless-looped uncaught (turn cap + per-call abort + bounded loops held), the server started/stopped cleanly with no orphan/OOM (single 16k slot, bounded KV), and no config produced an unbounded/"year"-long run (finite DAG + no-progress watchdog bound it — Snake3 ran 50 min and finished on its own, never hitting a cap or stalling). The one honest caveat is PACE (§B): heavy decomposition makes a max-effort run thorough-and-slow (~50 min for a rich Snake, ~90+ projected for a full 3D game), not stalled — bounded and coherent, but the top live-tuning item is tighter decomposition.

## Session 3 — the runnable-entry gap ("food with no home")

A separate 74-min Snake run (verdict preserved at `~/Desktop/pi-final-game`) exposed a real hole the acceptance run happened to dodge: the corp produced **well-decomposed modules but NO runnable product entry.** Vision was "a playable Snake game — ONE `index.html` that opens directly in a browser without Node.js/npm/build." The corp emitted `src/{engine,particles,ui,audio}/*.ts` (27 cross-importing TS modules) + fragment HTML files + a 58-byte `package.json` with only a `typescript` devDep — **no root `index.html`, no entry that mounts the game, no bundler.** The tester gate correctly set `runnableEntryMissing=true` and the CEO refused to approve, but `review.ts` treated that as a HARD gate the bounce **could never clear**: the bounce only re-dispatches EXISTING contracts, and the missing entry maps to none, so it flagged forever and never built the entry.

**Two root causes, both fixed:**

1. **No contract/region OWNED the runnable entry.** Fixed in three layers (all bounded, all pure helpers behind injected seams, matching the corp's idiom):
   - **Part A — guarantee it at planning time.** `corp/integration-contract.ts` (`buildIntegrationContract` / `ensureIntegrationContract`) synthesizes a final integration `Contract` whose `slot` is the runnable entry (root `index.html` for a web/openable product, else a wiring `src/main.ts`), that **`dependsOn` every division output** (runs LAST, sees real code), owned by an integration engineer node. `run.ts` calls `ensureIntegrationContract` right before `buildOrgChartQueue`, so it is **auto-injected** rather than trusting the small model to author one. The architect prompt (`architect.ts`) also now reserves the entry as a dedicated final integration step. A pure-logic product has no browser entry to own → none injected (keeps those plans unchanged).
   - **Part C — produce it in recovery, don't just flag it.** `review.ts` `runReviewPhase` gained a `DispatchIntegrationContractFn` seam (wired in `run.ts` exactly like `reviseForFindings`): when the tester gate reports "no runnable entry" and it maps to no contract, it **synthesizes + dispatches a NEW integration contract** (pruned deps + shared workspace so it reads the produced tree), re-assembles the manifest, and **recomputes `runnableEntryMissing` / `testerGatePassed` against it** — so a real fix clears the gate. Reuses the `maxRevisions` / `RunBudget` net; never throws, never deadlocks. This is the net for when Part A's entry was *skipped* (a module it depended on failed).

2. **The delivery constraint never reached the decomposition.** "Single openable index.html, no build" never propagated to the architect, so it chose a bundler-dependent module layout that can't open directly. `corp/delivery.ts` (`deriveDeliveryShape`) extracts a light, robust signal from the vision *text* (openable / no-build / single-file / web — never hardcoded), threaded into both the **architect prompt** and the **integration contract's brief**, steering toward a self-contained openable entry (inline / import-map / single file).

**Judgment call (flagged for review):** injection is scoped to **web/renderable products** — the class the tester gate actually governs — not literally every promoted run. A pure-logic library has no runnable-entry gate and no browser entry to own, so fabricating a `src/main.ts` for it would be gold-plating that also churns every pure-logic test's contract counts. Widening to "always" is a one-line predicate change in `needsIntegrationEntry` if the owner prefers it.

**Verification:** `packages/harness` typecheck clean; `vitest run` **777/777** (was 746 — +31 new: `delivery.test.ts`, `integration-contract.test.ts`, the review Part-C recovery tests, the architect delivery-constraint tests, and run-level Part A/C tests). The one run-level test that asserted the OLD "can never clear" behavior was rewritten to the new correct behavior (the corp now produces the entry and the gate clears).

## Known open items (documented, not silently dropped)
1. **Corp tool-call EXECUTION repair (provider-level).** The corp registers its own `openai-completions` provider (for the sampling hook + the per-call hang-watchdog); the normal chat's `provider-llamacpp` additionally runs `reconstructToolCallFromContent` so a tool call the server emits as TEXT (`<function=write>…`) is salvaged into a structured, EXECUTED call. The corp's provider lacks that, so an occasional text-form tool call is neither executed nor (until the render-layer fix) shown as an activity. RENDER is fixed (the corp feed reuses the chat's exact `reconstructToolCallFromContent` for display); EXECUTION parity needs a provider change (extend `createLlamaCppStream` to carry the extended sampling + re-arm the watchdog, then register the corp under it) that must be LIVE-verified — deferred as the recommended next step rather than shipped unverified (getting it wrong would drop sampling/watchdog = the "slow/broken config" failure this goal warns against).
2. **Per-token PUSH streaming for the corp feed.** The feed polls the transcript (120 ms) rather than receiving real per-token deltas like the normal chat (`pi:event` → `appendTextDelta`). Markdown + the tight poll is close, but byte-identical smoothness needs a push channel (route the role-agent `onActivity` over IPC as events). Deferred.
3. **Tighter decomposition dial** (§B) — the pace lever for a snappier max-effort mode.
