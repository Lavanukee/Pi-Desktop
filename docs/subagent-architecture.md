# Pi Subagent Architecture
## How the Agent Corporation Works

---

## The Problem with How Everyone Else Does This

Most multi-agent AI systems work like a bad manager.

There's one central "orchestrator" that receives every task, decides who does what, routes every message, waits for every result, and synthesizes everything into a final answer. Every worker reports back to it. Nothing happens without its knowledge.

This pattern — the **orchestrator-worker model** — covers roughly 70% of production multi-agent deployments. It has three fatal problems:

**It doesn't scale.** If the orchestrator takes 3 seconds to think and you have 20 workers waiting, your whole system is capped at 6.7 decisions per second regardless of how many workers you add.

**It creates context explosion.** The orchestrator has to hold everything in its head: the full task, all previous results, all worker states, the global plan. For any sufficiently complex project, this overflows its context window. It starts forgetting. It starts making mistakes.

**It isn't how anything at scale actually works.** There is no company of 1,000 people where one person routes every message and makes every decision. That company would be paralyzed.

---

## The Reference Implementation: A Human Company

We already have a working reference for coordinating 1 to 100,000 parallel workers on complex tasks without a single point of control. It's called a **corporation**.

Corporations aren't perfectly efficient — but they *function*. They ship products. They handle complexity that would overwhelm any single person or any centralized system. And they do it with properties we want to replicate:

- No one knows the whole codebase — but the whole codebase always gets built.
- No one routes every message — but information gets where it needs to go.
- No one decides every task — but tasks get decided and completed.
- When there's a conflict — it resolves at the lowest level with the context to fix it.
- When there's a company-wide change — it's announced and everyone adjusts.
- The CEO doesn't write code. They establish the vision, approve the result, and send it back if it's not right.

The architecture below implements these properties as concrete engineering primitives. It works correctly for a single-file edit, scales to a 100-file feature, and grows its hierarchy to match project scope over time.

---

## The Living Hierarchy: Corporations Don't Start at Full Size

This is the property most agent systems miss entirely. The hierarchy is not fixed at startup. It **grows with the project**.

### Stage 1: Solo Developer

A user comes in with a simple request: "Build me a dashboard prototype." One agent handles it. There is no CEO, no divisions, no specialists called. One agent, one task, one output. The agent is a competent solo developer who builds the thing.

```
[User]
  ↓
[Agent — solo dev]
  ↓
[Output]
```

### Stage 2: The Promotion

The user comes back: "Okay I love this — now I want to connect real APIs, add an account system, handle multiple users, and make this production-ready."

The original solo-dev agent is not disbanded. It **becomes the CEO**. This is its first act: to look at what it already built, understand the scope of the new request, and decide how to structure the work ahead. It determines which divisions are needed, what levels of hierarchy the task warrants, and issues the initial structure.

```
[User]
  ↓
[CEO — was the solo dev. Now sets the vision.]
  ↓  ↓  ↓
[Div A]  [Div B]  [Div C]
  ↓         ↓        ↓
[Impl...]  [Impl...] [Impl...]
```

The CEO doesn't forget what it built before. The project history is context it carries. It's the entity in the system with the longest-running view of what the product is and where it's going.

### Stage 3: The Established Corporation

For future requests in the same project, the hierarchy already exists. A new task comes in, the CEO receives it, decides how to route it — maybe it's a two-agent task, maybe it's a whole division's worth of work — and delegates accordingly. The corporation doesn't rebuild itself from scratch for each task. It adapts.

This is session-persistent. The "company" for a given project accumulates structure over time. A chat session with Pi has a specific corporate structure, and as the project grows, so does that structure.

---

## The CEO Layer: Vision, Not Implementation

The CEO's job is precisely defined, and implementation is explicitly not part of it.

### What the CEO Does

**Receives all user requests first.** Every task enters the system through the CEO. In most cases — for small tasks — the CEO simply relays it one level down with a brief framing and that's all. The delegation is nearly instant.

**Sets or interprets the vision.** For anything non-trivial, the CEO's job is to translate user intent into a clear, high-quality direction that the level below can act on. Not implementation details — direction. What should this feel like? What's the goal? What does success look like?

**Makes decisions when the user is indecisive.** If a user says "make it feel more premium" and isn't sure what that means, the CEO takes ownership of interpreting that — researching, calling up a visual critic, mocking up ideas, working through a direction — and then presents a concrete, specific vision to the level below. It doesn't ask the user seventeen clarifying questions and it doesn't guess and implement blindly.

**Approves the final output.** Before anything goes back to the user, it passes through the CEO. They review it against the original intent. If it's right, it goes back. If it's not, they send it back down with specific notes.

**Issues global changes.** If a decision affects the whole codebase — a design token rename, a changed API pattern, a new constraint — the CEO issues the broadcast and optionally directs a find-and-replace pass before any deeper implementation work begins.

### What the CEO Does NOT Do

- Write code
- Write implementation contracts
- Manage individual agents
- Resolve merge conflicts
- Do the work

In a traditional corporation, the CEO is often the least technically literate person in the room. In our system, the CEO is fully technically literate — it can code, it understands the stack, it can call critics and read render outputs. This is an advantage: it makes the vision more precise and the critique more useful. But it doesn't change the role. The CEO's technical knowledge makes it a *better* visionary and *better* reviewer. It does not make implementation part of its job.

### The Two Modes: Interpret vs. Ask

The system has a first-party setting that changes the CEO's behavior for ambiguous requests:

**ASK mode (default):** When a request is ambiguous, the CEO surfaces the ambiguity to the user as a short, specific set of options before doing anything. "Here are three ways I could interpret this — which direction?" No guessing, no overextension.

**INTERPRET mode:** When enabled, the CEO takes ownership of ambiguous requests and resolves them autonomously before delegating. The process looks like this:

```
1. CEO receives vague request: "make it feel more premium"

2. CEO researches: looks at the existing design, calls the visual-critic 
   specialist to assess the current state.

3. CEO synthesizes a direction: "Premium here means tighter spacing rhythm 
   (8px → 6px grid), a shift to variable-weight serif headings, and 
   micro-motion on state transitions. No full redesign — these three 
   changes have the highest signal-to-noise ratio."

4. CEO may mock something up itself or call the design division to 
   produce a reference. Critic reviews. CEO refines.

5. CEO issues a concrete vision document downward:
   — Spacing system: here are the new values
   — Typography: here is the new scale with weights  
   — Motion spec: here are the transitions and timings
   — System-wide find/replace: [token list] → [new values]
   
6. THEN it delegates implementation of the remaining pieces.
```

The CEO in INTERPRET mode should not start implementation before the direction is coherent. The value of this mode is a well-reasoned interpretation, not a fast guess.

---

## The Core Principles

### 1. Abstraction-Gated Context

Every agent knows exactly what it needs to do its job. Nothing more.

An engineer implementing a settings panel doesn't need to know what the company does. They need:
- What goes in (input types)
- What comes out (output types)  
- Where it slots in the app (injection point)
- The visual spec
- Which shared utilities they can use (pre-vetted imports)

That's the **task contract**. The agent works within it. The project can have a million lines of code and every agent's context stays the same size — they only hold their contract, their files, and the broadcast channel.

### 2. Git Is the Ground Truth

Every agent works on its own branch. The whole codebase is always known — not by any agent, but by git. The "compiler" (CI, type-check, tests) is the entity that knows the whole program, and it's deterministic — it doesn't have a context window that can overflow.

No agent ever needs to read the full codebase. They read the interface contracts around them, not the implementations.

### 3. Interface Contracts Are the Coordination Primitive

Agents don't coordinate through continuous messages. They coordinate through **typed artifacts** — contracts that define what one piece produces and what another piece expects.

A task contract in practice:

```
TASK: Implement NotificationSettings component

INPUT:
  - userId: string
  - settings: NotificationPreferences
  - onSave: async (settings: NotificationPreferences) => void

OUTPUT:
  - React component
  - Slot: "settings-content-area"
  - Visual spec: [attached]

AVAILABLE:
  - @/components/ui  (design system)
  - @/hooks/useUser
  - @/api/notifications

BRANCH: feat/notification-settings-agent-12
```

The implementing agent knows nothing about auth, routing, analytics, or any other system. It has a contract. That's enough.

### 4. Escalation Radius Equals Conflict Radius

When something goes wrong, resolution travels the **minimum distance** to find someone with the context to fix it.

Two implementation agents conflict → goes up one level.  
Two module subsystems conflict → goes up one level from there.  
The problem never travels higher than the scope of the conflict.

The CEO never receives a specific merge conflict. They don't have the implementation context to resolve it. Two levels down does.

---

## The Full Hierarchy

```
┌──────────────────────────────────────────────────────────────┐
│  CEO                                                          │
│                                                               │
│  • Receives all tasks first                                   │
│  • Interprets or relays the vision                            │
│  • Decides hierarchy structure as project grows               │
│  • Issues global broadcasts and system-wide changes           │
│  • Final approval before output returns to user               │
│  • Can send back down with notes for another pass             │
│  • Does not write code or implementation contracts            │
└──────────────────────────┬───────────────────────────────────┘
                           │ vision brief ↓ / approval request ↑
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Division    │  │  Division    │  │  Division    │
│  Lead (L1)   │  │  Lead (L1)   │  │  Lead (L1)   │
│              │  │              │  │              │
│  Writes      │  │  Writes      │  │  Writes      │
│  contracts.  │  │  contracts.  │  │  contracts.  │
│  Assigns     │  │  Assigns     │  │  Assigns     │
│  branches.   │  │  branches.   │  │  branches.   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ task contracts ↓                   │
   ┌───┴────┐                        ┌──────┴──────┐
   ↓        ↓                        ↓             ↓
┌──────┐ ┌──────┐               ┌────────┐  ┌──────────┐
│ Impl │ │ Impl │               │ Impl   │  │ Impl     │
│  L2  │ │  L2  │               │  L2    │  │  L2      │
└──────┘ └──────┘               └────────┘  └──────────┘

┌──────────────────────────────────────────────────────────────┐
│  SPECIALIST REGISTRY  (always exists, callable from any      │
│  level directly — not routed through hierarchy)              │
│                                                               │
│  visual-critic    security-audit    performance              │
│  accessibility    design-system     integration-test         │
└──────────────────────────────────────────────────────────────┘
```

The L1 division leads are the ones who write contracts, assign branches, and coordinate within their domain. They're the engineering managers: technically deep in their area, focused on making their division's work coherent and shippable. They produce the task contracts that implementation agents receive.

---

## The Review Pipeline

### The Core Tension

Reviews are valuable — they catch errors before they compound, and visual review in particular catches things that automated tests miss entirely. But every review pass is time and compute. The right answer is not "review everything constantly" nor "review only at the end." It's a tiered model.

### The Tiers

**Automated review (runs continuously):** Type checking, linting, unit tests, and visual diff against reference screenshots run on every branch push. This is not an agent — it's the CI pipeline. Zero cost in inference terms.

**In-task specialist review (on demand, within task):** Any implementation agent can call a specialist directly — visual critic, security audit, accessibility check — when they've produced something worth checking. Frequency is up to the agent and the nature of the task. A UI component probably calls the visual critic after every major render. A utility function probably doesn't call anyone.

**Division-level integration review (before merging to division branch):** Before a division lead merges its implementation agents' branches into a unified division output, a reviewer pass checks that the pieces are coherent together. This catches interface mismatches, visual inconsistencies across components, and semantic contradictions that individual agents couldn't see.

**Final reviewer pass (non-negotiable):** Before anything goes to the CEO for approval, a dedicated reviewer agent runs over the full integrated output. This is not the same as CI — it's a qualitative pass. Does it make sense? Does it feel right? Does it match the vision that was set?

**CEO final review (non-negotiable):** The CEO reviews the final output against the original user intent. This is the highest-level qualitative check. They are asking: "Is this what was asked for? Is it good enough to hand back?" If yes, it goes to the user. If no, they issue specific notes and send it back down.

### The Feedback Loop

```
[CEO issues vision]
        ↓
[Implementation]
        ↓
[Automated CI — continuous]
        ↓
[In-task specialist calls — as needed]
        ↓
[Division integration review]
        ↓
[Final reviewer pass]
        ↓
[CEO final review]
        ↓ (if approved)
[Back to user]
        ↓ (if not approved)
[Notes issued, goes back to appropriate level]
```

The CEO's notes after rejection go to the right level. If the vision was misinterpreted globally, the notes go to L1 and the whole thing re-runs. If one component is off, the notes go to that implementation agent specifically. The rejection is scoped like escalation: minimum distance to the right owner.

### Performance Consideration

The review tiers above have meaningfully different costs:

| Review type | Cost | Required |
|---|---|---|
| CI / automated | Negligible | Always |
| In-task specialist | Medium (1 inference call per specialist) | Agent-initiated |
| Division integration review | Medium | Before division merge |
| Final reviewer pass | Medium–high (full output context) | Always |
| CEO final review | High (full output + original intent) | Always |

For a fast, simple task (single file, clear spec) the pipeline is: CI → CEO review → done. No division reviews, minimal specialist calls. For a large multi-division task, all tiers run.

The non-negotiables are the final reviewer pass and CEO review. Everything else is calibrated to task complexity. A setting can be exposed to users: **thoroughness level**, which scales how aggressively intermediate review is applied. Higher thoroughness = more intermediate specialist calls and division review passes. Lower = lean on the final pass.

---

## Scenarios in Practice

### Scenario 1: Tiny Edit — Fix a Typo

**Request:** "Change 'Sumbit' to 'Submit' on the login button."

The CEO receives it. One-second assessment: this is a single-file find-replace. CEO delegates to one implementation agent directly, skipping L1 entirely for a task with no coordination surface.

```
CEO → [solo impl agent] → fix → CI → CEO approves → done
```

**Agents spawned:** 1  
**Review: CI + CEO glance.** No specialist, no division review.

---

### Scenario 2: Small Refactor — Design Token Rename

**Request:** "Rename `--brand-blue` to `--color-primary` everywhere."

CEO receives it. Issues a **broadcast** to all running agents: "design token rename in effect." Spins up one agent for the find-and-replace pass. CI confirms nothing broke.

```
CEO broadcasts → [find-replace agent] → CI → CEO approves → done
```

**Agents spawned:** 1  
No division structure needed. Broadcast ensures any parallel work respects the new token.

---

### Scenario 3: Medium Feature — Settings Panel

**Request:** "Add a settings panel for notification preferences — email, push, SMS toggles, saves immediately."

CEO receives it. Concrete enough to delegate. Brief sent to L1 with three domains: UI, State, API.

Three L1 agents each issue contracts to implementation agents. Agents work in parallel. Visual critic called by UI agent after first render — catches toggle spacing issue, fixed inline. State agent sends one-question clarification to API agent about response shape.

All branches merge to division branches. Division integration review runs — passes. Final reviewer pass — passes. CEO reviews against original intent — approved. Back to user.

```
CEO → [L1: UI, State, API] → [impl agents, parallel]
     → specialist calls as needed
     → division review → final review → CEO → user
```

**Agents spawned:** ~6–8 + specialist calls  
**Escalations:** 0 (peer clarification resolved it)

---

### Scenario 4: The Promotion — Solo Project Becomes a Company

**Prior state:** A user had a single-file dashboard prototype built by one agent in a previous session.

**New request:** "Make this production-ready. Real APIs, accounts, multiple users, proper auth."

CEO assessment: this is a company-level restructure. The solo dev agent becomes CEO. First act: structure the corporation for what this app now needs.

```
CEO (former solo dev) decides:
  — Frontend Division: Dashboard, Auth UI, Account UI
  — Backend Division: API integration, Auth system, User management  
  — Infrastructure: DB schema, session handling
```

L1 agents for each division are spawned. Each issues contracts to implementation agents. The original codebase context is now the CEO's domain knowledge — it doesn't need to be re-explained or re-read at lower levels; it flows through the contracts as typed interfaces.

For future sessions with this project, the corporation exists. New requests enter through the CEO, who routes them into the existing structure.

---

### Scenario 5: Vague Request in INTERPRET Mode

**Request:** "It feels a bit generic. Make it feel more premium."

In ASK mode: CEO surfaces three specific interpretations for the user to choose from.

In INTERPRET mode:

```
CEO → calls visual-critic specialist (current state assessment)
CEO → synthesizes direction: spacing, typography, motion
CEO → optionally mocks a reference implementation
CEO → critic reviews the reference
CEO → refines the direction
CEO → issues concrete vision document to L1:
      - Spacing: new token values
      - Typography: new scale + weights
      - Motion: transition specs
      - Global pass: [old tokens] → [new tokens] via find-replace

→ Implementation proceeds normally from here
→ Division reviews → Final review → CEO approves → user
```

The CEO in INTERPRET mode does real work — research, critique loops, concrete direction. But it produces a **vision document**, not code. Everything after the vision document is standard delegation.

---

### Scenario 6: Rejection and Second Pass

**Request:** "Build the onboarding flow."

Full pipeline runs. Final reviewer pass passes. CEO reviews — "The empty state on step 2 looks unfinished, and the CTA button doesn't have enough visual weight for a primary action."

```
CEO issues specific notes → back to UI division L1
L1 identifies: step-2 component + CTA styling
L1 issues targeted contracts to two impl agents (not the whole division)
Agents fix the specific issues
Division review (just the touched components) → final reviewer → CEO → approved
```

The second pass is scoped. The CEO's note contained specific enough information to route it to exactly the right agents without re-running the whole pipeline.

---

## What Each Level Holds in Context

| Level | Holds | Does Not Hold |
|---|---|---|
| CEO | User intent, product history, current vision document, broadcast state | Implementation details, individual component specs |
| Division Lead (L1) | Domain contracts, division-level architecture, sub-task breakdown | Other divisions' internals, full codebase |
| Implementation (L2) | Own files, own contract, available imports (types only) | Other implementations, division strategy |
| Reviewer | Output artifact being reviewed, original spec/vision | Implementation details, other divisions |
| Specialist | Own domain only (visual, security, perf, etc.) | Task context, codebase |

Context size stays bounded at every level regardless of project size. A million-line codebase does not increase any individual agent's context — they each hold their contract and their files.

---

## The Three Communication Channels

**Task contracts (downward):** Typed structured objects issued when work is dispatched. Define input, output, injection slot, available imports, working branch. Not natural language instructions — structured specs. Never change mid-task.

**Artifacts (upward and lateral):** Files, typed outputs, render screenshots, test results. The product of completed work. Agents write artifacts to their branch; other agents read them when ready. Asynchronous, not coupled.

**Broadcast (all directions):** Global state changes: requirement updates, design token changes, new constraints, CEO-level direction. All running agents subscribe. Broadcasts are rare, important, and authoritative.

Direct agent-to-agent messages are for single-question peer clarifications only. No general messaging between arbitrary agents. No agent sends messages up more than one level.

---

## What This Is Not

**Not an orchestrator-worker system.** No single agent routes all messages or holds all state. Division leads dispatch their own sub-tasks. Any agent can call specialists directly. Nothing routes through one point.

**Not a swarm.** Structure exists: the hierarchy is real, ownership is explicit, contracts are typed. Coordination is designed, not emergent.

**Not a chain.** Work happens in parallel. Serialization only occurs at merge time and review time, and only for the components that need integration.

**Not fixed at startup.** The hierarchy grows with the project. A solo task gets a solo agent. A production application gets a full corporate structure. The same architecture serves both because the structure is derived from task complexity, not pre-defined.

**Not trigger-happy with spawning.** Default is the minimum agents required. If a task fits in one file, one agent handles it. Hierarchy only appears when there's coordination surface to justify it.

---

## The Invariant That Makes It Work at Any Scale

Across a single-file fix, a medium feature, a full production app, and a growing project history — one thing stays constant:

**No agent ever needs to know more than its contract, its files, and the broadcast channel.**

The project's total complexity is held by git and CI, not by any agent. The vision is held by the CEO. The interfaces are held by the contracts. The implementations are held by the agents that wrote them.

Nobody carries the whole thing. Nobody needs to.
