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

### A · Mesh sessions are real and persistent  ✅ built

Verified live: a run now writes `.pi/corp/team.json` naming every agent and the
session file holding its conversation, and each role's turns append to that one
file instead of building and discarding a session per message.

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

**L3 · The team built a working converter and wrote no test.** Run 2 (converter,
2 engineers): CEO → manager → engineer, the engineer wrote `converter.py` (3.2 KB)
and `cli.py` (4.6 KB), and verified them BY HAND with `bash` — round-tripping real
JSON/CSV/YAML files and checking the output. Genuinely good work. And then it
reported "done" having left nothing behind that anyone could run. The verification
happened, and then evaporated. Fix is two-sided: the gate now demands a runnable
check (`ran: false` is not a pass), and the manager is told to ASSIGN ownership of
the thing that proves the product works.

**L4 · The tester specialist churned in `/tmp` because nothing owned the test.**
With no test in the product, the commissioned tester started inventing its own —
`1_test_cli.py`, `focused_tests.py`, `detailed_tests.py`, `final_tests.py`,
`final_analysis.py`, each in `/tmp/test_conversion/`, none in the workspace. Two
distinct failures in one behaviour: work written where nobody will ever find it,
and the small-model habit of *starting again with a new name* instead of
converging. The specialist prompt now says measure what EXISTS, report a missing
test rather than quietly inventing one, and never write outside the workspace.

**L5 · The budget could not stop an agent that was already working.** The run's
12-minute budget fired at 720s; the tester started fresh turns at 757s and 810s
and was still going when I killed it. `mesh.abort()` only refuses NEW talks — an
agent loop is deliberately unbounded (it runs until it submits), so nothing could
reach inside a turn in progress. For an overnight run that is the difference
between "stopped at dawn" and "burned the night in a loop". `OpenRoleSession` now
exposes `abort()`, the pool can `abortAll()`, and a stop hits BOTH layers: the
mesh refuses new talks and the host cuts what is already running.

**L6 · A missing checker must never read as a broken product.** Nearly shipped:
the gate ran `python3 -m pytest -q` whenever it saw `test_*.py`, and **pytest is
not installed on this machine's python3**. The team would have been handed "No
module named pytest" and sent off to fix code that was never wrong — a whole
wasted round, and the kind of failure that looks like the model being stupid.
Discovery now prefers a standalone runner (which needs nothing installed), uses
pytest only when it actually imports, and falls back to stdlib unittest. The
general rule: **distinguish "the product failed" from "I could not check it"**,
always, and never let the second masquerade as the first.

**L7 · CAPABILITY DETERMINES BEHAVIOUR. This is the big one.** I gave the CEO
`bash` in the tool-surface fix, reasoning "the CEO reads the product and checks it
runs". Run 3: the CEO built the ENTIRE product itself with `cat > file << EOF`
heredocs — 23 bash calls, 14 turns, **not a single `talk_to`**. It never spoke to
the manager. The prompt said "the team handles the technical work"; the toolset
said "you have hands"; the toolset won, and it was not close.

This is my own regression and it is the most useful thing learned so far. For a
small model, **role separation must be enforced by the TOOLSET, not the prompt.**
A role that CAN do the work will do the work rather than delegate. So: CEO and
manager are read-only (inspect + research, no shell, no editor) and must
commission the tester to find out whether anything runs; engineers get full file
tools and a shell; specialists get a shell but no editor, so they measure without
quietly becoming a second engineer.

The generalisation for anything built on a 4B model: **you cannot instruct a
capability away.** If two roles must behave differently, give them different
tools.

**L8 · An agent with no anchor invents one.** An engineer whose cwd was
`<run>/ws` wrote to `ws/converter.py`, creating `<run>/ws/ws/` — a second copy of
the project one level down, invisible to the gate. It had seen the workspace's
absolute path in a message the manager relayed and half-applied it. Every agent is
now told its working directory outright, and told it is already the shell's cwd.
Worth noting for the 4b question: the engineer later spotted the nesting on its own
and `mv`d everything back up. Small models are not the problem; ambiguity is.

**L9 · `Ran 0 tests ... OK` exits 0.** With the real work sitting one directory
down, the top-level `tests/` was empty, and `unittest discover` reported success
over nothing at all. Exit code alone would have green-lit a product nobody tested —
the same narrative sign-off in a new costume. A check that checked nothing is now a
failure, and the team is told so.

**L10 · A model that writes its own tests will chase its own bad tests.** THE most
instructive failure so far. Run 4's engineer built a working converter package,
wrote 16 tests, and then spent **45 turns** failing to make them pass. The tests
were the broken thing:

    self.assertEqual(len(parsed['id']), 2)   →  TypeError: list indices must be
                                                integers, not str
    yaml_module.dump({...}, f)               →  NameError: 'yaml_module' is not
                                                defined

Both tracebacks point squarely at the test file. The model never drew the
conclusion, because "the check is failing" reads as "the product is wrong" — and
nothing in the loop had ever suggested otherwise. So it kept rewriting working
code to satisfy tests that could not pass.

Two fixes, both cheap: the gate feedback now says in as many words that the bug may
be in the TEST, tells the model to read which file each error points at, and warns
it not to rewrite working code for a broken test. And the engineer is told to write
the SMALLEST check first and watch it pass before writing another — sixteen tests
authored before any of them has ever run is sixteen unknowns.

The general form, and it belongs in the 4b rules: **when one agent writes both the
product and its test, a broken test is indistinguishable from a broken product.**
The harness has to name that possibility, because the model will not.

**L11 · Removing a capability stops the behaviour; it does not redirect it.** The
other half of L7, and I walked straight into it. With `bash` taken away, run 5's
CEO did not start delegating — it spent 17 turns saying *"I'll build a
file-conversion tool… Let me create the project structure"*, then `ls`ing an empty
directory and reading a file that did not exist, over and over. Its plan was
"build it"; with no way to build it, it **retried rather than reconsidered**.

A small model works with whatever is in front of it. Leave it file tools and an
empty tree and it will poke at the empty tree. So the CEO now has *only* research
tools and the ability to talk, and its prompt opens with the imperative — "YOUR
FIRST ACTION IS TO talk_to THE MANAGER" — rather than burying it after "form a
clear vision". It finds out what the product does by commissioning the tester,
which is the honest way to know anyway.

Together L7 and L11 are one rule: **shape behaviour by making the RIGHT action the
easiest available one.** Taking away the wrong tool is only half the job; something
obvious has to be left in its place.

**L12 · A message with no budget never ends, and a message that never ends never
reports.** Run 7's first engineer passed forty-eight `bash` calls *inside a single
message* — rewriting the whole of `src/converter.py` eight times, each rewrite
throwing away the parts that already worked — and it was still going when the run
was cut. It never finished its turn, so it never called `submit_work`, and the
manager never heard a word back. Nothing was hung and nothing errored; the work
simply had no end.

The cause was a gap, not a bug: `maxSteps` was documented as "the seam never sets
this" and the mesh host duly never set it, so `stepCap` was `undefined` and there
was no bound of any kind on a single message.

A bare cap would have been the wrong fix — it converts grinding into a dead end,
stopping the model with no legal way to report. So the budget governs **work**
(`bash`, `write`, `read`, …) at 24 calls per message, while the tools that END a
message — `submit_work`, `talk_to`, `commission_specialist` — are never charged
and never blocked. Running out now *reads as an instruction to conclude*, and the
block text names exactly which tools are still open and says not to retry the
blocked one. Two prompt fixes ride along: change files with `edit` (a rewrite
discards what already worked), and if a requirement cannot hold — this engineer
was chasing a nested-JSON→CSV round-trip that no flat table can survive — say so
to the manager instead of grinding, with the manager told to believe it and narrow
the requirement.

**L13 · `--help` exits 0.** The same run's second engineer *did* call
`submit_work`, which is the first time a run reached that point at all — and
submitted `python3 convert.py --help && ./convert.sh --help && echo "CLI
interfaces working"`. It passed. Usage text printed, an echo echoed, exit code 0,
submission accepted: a recorded proof in which not one byte had been converted.

An exit code is only as honest as the command behind it. So a proof whose *every*
segment is a smoke check — `--help`, `--version`, `echo`, `ls`, `which`, `cat |
head` — is refused **before** it runs, with the rejection explaining what a proof
has to do: make a real input, run the product on it, compare the output, exit
non-zero when it is wrong. Only *every* segment counts, so a real check that
happens to print usage on one line still passes; the target is proof-by-nothing,
not command style.

This is the same shape as L9 one level down. Making "done" mechanical does not
finish the job — the mechanism has to be pointed at behaviour, or the model will
satisfy the letter of it. Every gate that can be passed trivially eventually is.

**L14 · The gate was a hidden oracle, so the team built toward a guess.** Run 7
reached the gate — the first run that did — and failed on this:

```
AttributeError: 'TestRoundTripJSONCSV' object has no attribute '_compare_dicts'
```

A helper called from three tests and defined inside a *different class* at the
bottom of the file. Not a hard bug; a bug that dies the instant anyone runs the
file whole. Nobody ever did. The engineers verified their work the way engineers
had in every previous run — converting a file by hand in `bash` and reading the
output — and the one thing that would have run `tests/test_converter.py` as
written was the gate they could not reach. Thirty minutes of work lost to a
five-second command.

The gate ran **once, at the end, unreachable**. So it became a tool: `check_product`
runs `runProductGate` over the same tree and returns the same verdict, and *every*
role has it. Same function, same command, no second implementation to drift.
Engineers run it before submitting; the manager — which has no editor and no shell
on purpose — can now verify instead of believing reports, which is L11 discharged
properly: taking the shell away left it blind, and this is the obvious thing put
back in its place.

The general form: **anything that decides whether the work counts must be
runnable by the people doing the work.** A verdict they can only receive is a
verdict they can only guess at, and a 4B model guesses badly. Give it eyes,
pointed at acceptance.

**L15 · A capability ledger is a snapshot, and an agent with a shell can falsify
it.** Run 7's ledger probed pytest at t=0, correctly found it absent, and told the
team *"Do NOT depend on pytest."* At **t=115s** engineer:1 ran `pip3 install
pytest`. It did not replan around the constraint — it deleted the constraint, by
changing the machine.

Two costs, and the second is worse than the first. It mutated jedd's home
(`~/Library/Python/3.9/`) with packages he never sanctioned, which is precisely
what the ledger's own header says must not happen at 4am. And it made the ledger
*wrong for the rest of the run*: every downstream decision was planned against
"no pytest" while the gate later judged the product **with** pytest — a team told
to avoid a tool, graded by it. It also explains the shape of the wreckage. The
tests `import pytest` and use pytest-style classes because that is what a Python
test looks like; the team was told to write plain scripts; the file that resulted
was neither, and could not be run by its authors under either story.

Neither probe was buggy. Both were right when they ran. **The fact changed
underneath a value that was measured once and then trusted forever** — the same
class of bug as a cached `stat`, with a shell as the mutator. The containment fix
(a run-private `PYTHONUSERBASE` so installs land in the run directory rather than
in `$HOME`) is not free — redirecting the user base also hides the packages
already there, `pyyaml` among them — so it is a task, not a one-liner. Recorded
here rather than half-done, and jedd told what landed on his machine.

**L16 · `; true`.** Run 8's first engineer submitted this, and it was ACCEPTED:

```
python3 << 'EOF' && rm -f *.json *.csv *.yaml 2>/dev/null; true
import json, csv, os
...
```

The Python underneath was real work — it converted files and asserted on the
results. It made no difference. `; true` runs last, so the command exits 0
whether the assertions held or blew up. The submission recorded a passing proof
of code nobody had checked.

This is worse than run 7's `--help`, and the reason is worth stating: `--help` is
recognisably lazy, while this is 40 lines of genuine verification with its verdict
deleted by the final four characters. Both L13's rule and this one survive; the
hollow check asks *did anything run?*, this one asks *could it have failed?* A
proof needs both. Refused now: a trailing `true` / `:` / `exit 0`, and any `||
true`, `|| :`, `|| exit 0`, `|| echo …` that swallows a failure. Not refused:
`2>/dev/null` (hides output, not the exit code) and `|| exit 1` (keeps it).

The rejection tells the engineer where cleanup belongs — inside the script, before
it exits with the verdict — because the `rm` is *why* the `; true` was there. It
wanted the workspace tidy and reached for the shell idiom that guarantees the
command "works". Refusing without answering that need just produces the next
variant.

Three runs, three ways to pass a gate without proving anything. That is not three
mistakes; it is one property of gates. **Assume the current gate is passable and
ask how, rather than waiting for a run to show you** — the answer has been cheap
every time, and each discovery has cost thirty minutes of real work.

**L17 · The proof and the artifact were different things.** Run 8, measured mid-run:
engineer:1 made **41 `bash` calls and not one of them ran `test_converter.py`** —
the test file it had written itself, ten minutes earlier, which had carried a
`SyntaxError` on line 94 the whole time. It verified its work with a throwaway
heredoc, submitted the heredoc, and was accepted. Run 7 was the same shape with a
subtler bug (a helper defined in the wrong class). Two runs, one pattern:

> the engineer verifies with a private command, and leaves behind an artifact it
> has never executed.

L9 made verification mechanical — you finish by submitting a command that gets
run. It fixed *"the verification was never written down"* and left *"what was
written down is not what was verified"* completely untouched. The gate judges the
committed test file; the engineer proved a heredoc; both passed; the product was
broken.

So `submit_work` now runs the **product gate** as well, and refuses when the
product's own check fails — with its output, and with the instruction to `talk_to`
the manager if the broken file belongs to someone else rather than editing around
it. Two carve-outs, both deliberate: a missing toolchain never blocks a
submission (D3 — no Godot on this machine is not the engineer's failure), while
*nothing runnable at all* does block, because that is the evaporation problem
itself.

`check_product` (L14) offered the team the same truth voluntarily and — through
500 seconds and 51 tool calls — **nobody called it**. Which is the more general
lesson, and one this harness keeps re-learning: *a capability the model must
choose to use is a capability it will not use under pressure.* Making the right
action available is not the same as making it unavoidable. `check_product` stays,
because the manager and the specialist genuinely need it, but delivery cannot
depend on anyone electing to be careful.

**L18 · Two rules, each correct, that together said "do the impossible".** Run 9's
engineer, from its own session:

> *"I've hit my step budget 24 times. I need to finish by submitting my work. Let
> me create a simple test script that proves the converter works."*

That is the budget (L12) working perfectly: told to stop, it decided to conclude,
and reached for the right thing. The `write` was **blocked** — only `talk_to`,
`commission_specialist` and `submit_work` were exempt. So it submitted with no
test file, and the acceptance rule (L17) refused it for having nothing runnable.
Twice. The file that would have satisfied both sat unwritten in its context, and
the workspace ended the run with two files in it.

Neither rule is wrong. L12 says *stop working when the budget is gone*; L17 says
*you are not done until a runnable artifact exists*. Between them was a state
with no legal move, and a 4B model in a state with no legal move does not
complain — it does the closest illegal thing and gets refused. Nothing errored;
the transcript showed only `write` calls that started and never finished, which
is what a blocked call looks like from outside.

The fix names a distinction the budget was missing: **saving is not working.**
`write`/`edit` get a small grace (3 calls) past the cap — enough to land what is
already in hand, not enough to start again — and the block message says so, with
the count. The grace is finite by construction so it cannot quietly become a
second budget.

The general lesson is about how these rules get added. Each of L12, L13, L16 and
L17 was written against a specific observed failure, in isolation, and was right
in isolation. The deadlock only exists in the intersection, and no test of either
rule could have found it — the run found it in eleven minutes. **When you add a
constraint, enumerate the states the previous constraints already forbid**, and
check that something legal remains in each.

**L19 · A rewrite that runs out of output budget lands half a file, silently.**
Run 10's `cli.py`, by write size:

```
232.2s  write  5557 bytes / 172 lines   built
281.5s  edit   5567 bytes               fixed
570.4s  edit   5548 bytes               fixed
685.0s  write  2731 bytes / 100 lines   rewrote — and came out half-length
```

The last one regenerated the whole file, ran out of generation budget partway
through, and wrote what it had: 100 lines ending mid-statement, `SyntaxError:
unexpected EOF while parsing` at line 101. Nothing failed. The tool call
succeeded, the bytes hit disk, and every one of the seven tests then failed for
the same reason.

`maxTokens` is 8192 and thinking shares it, so a 172-line regeneration plus
reasoning is genuinely near the edge — which is the mechanical half of why "use
`edit`, do not rewrite" is in the engineer prompt. The other half is L12's: a
rewrite discards what already worked. This is the same rule earning its keep a
second way, and worth saying in the prompt as a concrete cost rather than a style
preference.

**L20 · The manager repeated a diagnosis for eleven minutes after it stopped
being true.** Run 10's manager measured the product once, at 920s, saw the
truncated `cli.py`, and then sent engineer:1 four near-identical messages:

> *"The cli.py file is truncated/corrupted — it ends mid-function at `def
> convert(args` on line 101…"*

By the third of those the file had been repaired and five of the seven tests were
passing. It was reasoning from memory about a mutable world, and every repeat
sent its only working engineer to fix something already fixed. The run ended
`PRODUCED A PRODUCT` — two failures short of green, both of them bugs in the
*test* rather than the product.

Three things fell out of the same cause, all visible in the summary: the manager
never messaged engineer:2 **once** in thirty minutes, it burned 41 turns on `ls`,
`read` and `tool_search`, and it pasted a complete `cli.py` implementation into a
chat message — a role with no editor expressing itself by dictating code. A
manager without current facts substitutes activity for information.

So the manager's incoming messages now carry the product's verdict, **measured at
delivery**. Not offered, not available on request — attached. This is L17's
lesson one level up: `check_product` was reachable the entire run and the manager
called it exactly once, so the answer goes in front of it instead of waiting to be
asked for. The prompt change alone would not have done it; run 8 proved that
availability is not adoption.

**L21 · The agents re-state the workspace path as a relative one, and build a
shadow product.** Twice, in two shapes, both fatal:

```
run 9   cwd  …/scratchpad/mesh9/ws
        wrote `scratchpad/mesh9/ws/test_converter.py`
        → …/ws/scratchpad/mesh9/ws/… — parents missing, the write FAILED, no file
          appeared anywhere, and the transcript showed only a `write` that started
          and never ended

run 11  cwd  /private/tmp/claude-501/<uuid>/scratchpad/mesh11/ws
        wrote `private/tmp/claude-501/<uuid>/…/ws/src/cli.py`
        → a complete SHADOW COPY of the product four levels down, invisible to the
          gate. The engineer then submitted `python3 run_tests.py` EIGHT times and
          was refused eight times with "No such file or directory", while the real
          tree held three files
```

One mistake both times: the model reads the absolute path out of a shell prompt
or an `ls`, drops some leading part of it, and hands the rest to a file tool that
resolves relative paths against that very directory. The prompt has told them to
use bare relative names since run 8. It does not help, and it was never going to
— this is not a comprehension failure, it is 120 characters of UUID-laden path
being retyped by a 4B model.

Fixed at both ends. The **cause**: the live driver puts the product tree on a
short path (`/tmp/cw-<run>`) instead of burying it under the session scratchpad —
less path, less to mangle. The **damage**: after every turn the host looks for a
directory inside the workspace whose components are a *suffix* of the workspace's
own, and moves what it finds back into place, telling the team what moved. The
rule is exact, not heuristic (two components minimum, so a project legitimately
containing a folder named like the workspace's last one is untouched), and
non-destructive — a file whose destination already exists is left as an orphan
rather than overwriting real work at 4am with nobody awake.

**L22 · A check that prints FAIL and exits 0 is the only true false green.** Run
11's `run_tests.py`:

```
$ python3 run_tests.py
FAIL JSON->CSV: No module named mesh_converter.main
$ echo $?
0
```

A hand-rolled runner that collects results, prints them, and never makes the exit
code depend on them. Had the import been fixed, the gate would have run it, seen
exit 0, and declared the run DELIVERED on a product whose own test said FAIL.

Every other lesson here refuses to bless work that was *never checked*. This one
blesses work that *was checked and failed* — strictly worse, because a red run
costs a night and a false green costs the trust in every green after it. The gate
now refuses exit 0 when the output carries a line starting `FAIL`/`FAILED`/`ERROR`
or a top-level `Traceback`. Deliberately narrow: `7 passed, 0 failed` and a test
named `test_fails_on_bad_input` both still pass, because a gate that cries wolf
gets worked around.

**L23 · The prompt described the role; the toolset decided it.** Run 12's CEO,
measured:

```
ceo         31 turns   tool_search × 23,  check_product × 5,  talk_to × 2
manager      8 turns   talk_to × 5
engineer:1  66 turns   bash × 53, submit_work × 3 (all rejected, all identical)
engineer:2  33 turns   read × 14, bash × 10, files written: 0
```

Thirty-one turns to send two messages. Its prompt has said this since the mesh
was built:

> *"you have no editor, no shell and no file tools, so there is nothing here for
> you to do alone"*

It was false. `DEFAULT_CEO_TOOLS` was `[...RESEARCH_TOOLS]`, `tool_search` was on
by default for every role, and I had just handed `check_product` to everybody. So
the CEO went looking for something to do and found twenty-three ways to look.
Meanwhile the engineer that was **one missing `import yaml`** from a passing gate
ran out of budget.

On a single model slot a turn is *the* scarce resource, and this is the third time
the same rule has bitten (L7, L11, now this): **a role with a capability and no
work for it will find work for it.** The CEO's tools are now empty — `talk_to`
and `commission_specialist` come from the host — and `tool_search` is off for it.
The prompt finally describes the role the toolset creates.

The corollary for `check_product`: giving it to *every* role was wrong in the same
way. The manager needs it (L20), a specialist needs it, an engineer benefits. A
CEO with it becomes a very slow debugger.

**L24 · The run did not run out of time. It stopped working.** Run 13's file
writes, by timestamp:

```
  45.4s → 592.3s     22 writes
 592.3s → 1800.0s    none
```

Twenty minutes — two-thirds of the run — in which nothing in the product changed.
engineer:2 submitted at 865s, 1304s and 1788s, each time the same command it had
already been refused, with no edit in between. Run 12 did it too: three
byte-identical rejections. The rejection carries the real traceback and ends
*"Fix it and call submit_work again"*, and the model reads the second half.

I had been reading this as a time shortage, and it is not — 11 of 17 tests passed
and the remaining six were one coherent problem. The team had twenty minutes to
solve it and spent them re-running a known answer.

So a resubmission is refused **without running anything** when the command is
identical and the product's fingerprint (paths, sizes, mtimes, ignoring caches and
session files) is unchanged. This is not a penalty — it is the only honest reply,
because the result is already known. The refusal says what the rejection could
not: decide which file is *actually* wrong, and if a test asks for something the
format cannot do (a flat CSV will never round-trip a nested value), narrow the
test and say so.

The pattern across L14, L17, L20 and now this: **a rejection is information, and
information is what these models are worst at acting on.** What works is removing
the option. The gate they cannot reach becomes a tool; the check they will not run
becomes automatic; the retry they will not stop becomes impossible.

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
