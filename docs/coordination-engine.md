# The CoordinationEngine boundary — today's flow → the interface

This is the companion to [`harness-architecture.md`](./harness-architecture.md) §1 for the
`@pi-desktop/coordination` package. It records **how the app runs today**, **how that flow maps
onto the `CoordinationEngine` interface**, and the **Phase-2 rewire checklist** to move the live app
behind the boundary. Phase 1 landed the interface + DTOs + the `SoloEngine` skeleton; nothing live is
rewired yet (additive, non-breaking).

## Where it lives

| Thing | Path | Renderer-safe? |
|---|---|---|
| The interface + DTOs (`CoordinationEngine`, events, `OrgChartView`, …) | `packages/coordination/src/index.ts` (`@pi-desktop/coordination`) | **Yes** — plain DTOs, no `node:*`, no harness value-imports |
| The solo adapter skeleton (`SoloEngine`) | `packages/coordination/src/solo/index.ts` (`@pi-desktop/coordination/solo`) | No — Node-side (main process); renderer never imports it |
| Shape/smoke test | `packages/coordination/src/coordination-engine.test.ts` | — |

The root export is the UI's dependency. The `/solo` subpath is an engine implementation and stays on
the Node side — the renderer only ever sees the neutral DTOs, over IPC.

## Today's app ↔ pi ↔ harness flow

```
apps/desktop/src (renderer)
    │  IPC (DTOs: ChatMsg, RPC types)
    ▼
Electron main
    │  @pi-desktop/engine/main → PiBridge  (spawns `pi --mode rpc`, JSONL over stdio)
    ▼
pi child process  ──loads──▶  @pi-desktop/harness  (pi extension: classifier, tool_search,
    │  AgentEvents (JSONL)                          repair 3–5, permissions, effort, /harness)
    ▼
PiBridge onEvent(PiBridgeEvent)
    │  @pi-desktop/engine → createEventRouter(sink) translates events → ChatMsg rows
    ▼
renderer store (chat transcript, canvas artifacts)
```

Concrete symbols (verified in-repo):

- **`PiBridge`** (`packages/engine/src/main/pi-bridge.ts`) — the child-process bridge. Public surface
  already lines up with the interface: `prompt(...)`, `steer(message)`, `abort()`, `kill(signal)`,
  `respondUi(id, answer)`, and the constructor's `onEvent: (e: PiBridgeEvent) => void`.
- **`createEventRouter(sink, options)`** (`packages/engine/src/renderer/event-router.ts`) — turns pi
  `AgentEvent`s into `ChatMsg` rows; helpers `opFor(name)` (`read|write|edit`) and
  `extractToolResultText(tr)` are exactly what the file-touch / artifact translation needs.
- **`@pi-desktop/harness/corp`** (`packages/harness/src/corp/*`) — the org-chart/contract/queue data
  model (`OrgChart`, `Contract`, `QueueEdge`), `loadOrgChart`/`saveOrgChart` persistence, and the
  DAG helpers (`readyContracts`, `topologicalOrder`, `findCycle`). This is the corp engine's internal
  model; the interface's `OrgChartView` is a neutral projection of it.

## Interface → today's flow

| `CoordinationEngine` member | Today | Notes |
|---|---|---|
| `startTask(prompt, ctx)` | `new PiBridge(opts, onEvent)` → `bridge.ready()` → `bridge.prompt(prompt, { images })` | Handle returned synchronously; the pi turn drives the stream. `ctx.cwd`/`ctx.projectId` pick the spawn dir + org-chart location. |
| `steer(handle, text)` | `bridge.steer(text)` | pi **already** has no-seam steering (spec §1/§9) — this is a direct pass-through, not new plumbing. |
| `abort(handle)` | `bridge.abort()` then `bridge.kill('SIGTERM'/'SIGKILL')` on timeout | Stream ends with `done{ outcome: 'aborted' }`. |
| `respondToPermission(handle, id, granted)` | `bridge.respondUi(id, answer)` | The answer side of the `permission` event: git approve/deny, the pi extension-UI ask, a denylist confirm. |
| `getOrgChart(handle)` | solo: a single-node view; corp: `loadOrgChart(projectDir)` → `OrgChartView` | Synchronous snapshot for a situation-room bootstrap; live changes also arrive as `org-chart` events. |
| **event stream** | `onEvent(PiBridgeEvent)` translated → `CoordinationEvent` | See the table below. |

## Event translation (pi `AgentEvent` → `CoordinationEvent`)

| pi / bridge event | → `CoordinationEvent` |
|---|---|
| turn start / agent begins | `status: 'starting'` then `status: 'working'` |
| assistant text / thinking delta | `activity{ kind:'message' }` (optional; UI already renders transcript directly) |
| `toolcall_start`/`toolcall_end` | `activity{ kind:'tool-call', summary, path? }`; if `opFor(name)` is `write`/`edit` → also `activity{ kind:'file-touch', path }` (lights up the file map) |
| tool result that produced a file/render/screenshot | `artifact{ kind, path?, uri? }` (via `extractToolResultText`) |
| pi extension-UI request / git-approval / denylist hit | `permission{ kind, summary, detail?, command? }` |
| turn/run ends (`stopReason: 'stop'`) | `status:'done'` → `done{ outcome:'completed', artifacts }` |
| error / non-zero exit | `status:'error'` → `done{ outcome:'failed', error }` |
| abort | `status:'aborted'` → `done{ outcome:'aborted' }` |
| corp: chart/queue mutation (managers) | `org-chart{ chart }`, `checklist{ items }` (driven from contract state via the DAG helpers — **no model tool-call ticks a box**, spec §11) |
| corp: contracts completing | `eta{ lowMinutes, highMinutes }` — a **range that narrows** (spec §11), never a fake countdown |

## `OrgChart` (harness/corp) → `OrgChartView` (neutral)

The interface stays engine-agnostic: an opencode/BYO adapter must be able to produce `OrgChartView`
without adopting our on-disk schema. The corp engine maps its internal model in:

| `@pi-desktop/harness/corp` `OrgChart` | → `OrgChartView` |
|---|---|
| `nodes: OrgNode[]` (`role`, `name`, `parentId`) | `nodes: OrgNodeView[]` (same role set + `solo`) |
| `nodeStatus[nodeId]` (`idle|working|blocked|done|retired`) | `OrgNodeView.state` |
| `nodes[].parentId` | `edges: { from: parentId, to: nodeId }[]` |
| `contracts` + `queue` (via `dag.ts`) | drives `checklist` events, not the chart view |
| `projectId` | (implicit; `taskId` correlates the run) |

`SoloEngine` short-circuits this: before any promotion the whole "corporation" is one `solo` node.

## Phase-2 rewire checklist

Ordered, each step additive and independently testable:

1. **Host the engine in main.** Instantiate the engine (SoloEngine now; CorpEngine later) in Electron
   main and expose it over IPC: request channels `coordination:startTask|steer|abort|getOrgChart|respondPermission`
   plus a one-way `coordination:event` push. The renderer gets a thin typed client that speaks only
   DTOs — **no value-import** of `@pi-desktop/engine|harness|coordination/solo` (RENDERER-BARREL rule);
   type-only + DTO + IPC.
2. **Wire `SoloEngine.startTask` to `PiBridge`.** Replace `emitScriptedRun` with: construct a
   `PiBridge` (`@pi-desktop/engine/main`), `await ready()`, `prompt(prompt, { images: ctx.images })`,
   and forward the constructor's `onEvent` into `translate()`. Keep the `PushStream` — it now buffers
   real events.
3. **Implement `translate(PiBridgeEvent) → CoordinationEvent`** per the table above; reuse
   `opFor()` / `extractToolResultText()` from the engine event-router for file-touch + artifact
   detection. Add an integration test driving a **fake PiBridge** that emits scripted `AgentEvent`s
   and asserting the translated `CoordinationEvent` sequence.
4. **Control methods.** `steer` → `bridge.steer`; `abort` → `bridge.abort()` + `kill()` fallback;
   `respondToPermission` → `bridge.respondUi(id, answer)`. Surface pi extension-UI asks, the git
   Approve/Deny prompt, and denylist confirmations as `permission` events.
5. **Org chart + checklist + ETA (corp).** Add a `CorpEngine` implementing the same interface:
   `getOrgChart` reads `loadOrgChart(projectDir)` and maps `OrgChart → OrgChartView`; emit `org-chart`
   on chart mutation; derive `checklist` from `contracts` via `readyContracts`/`topologicalOrder`;
   derive the narrowing `eta` from the merged/total contract ratio.
6. **Promotion seam.** `create_production_hierarchy` swaps `CorpEngine` in behind the **same**
   `TaskHandle` (the corporation is "the solo engine that grew"). Manager contract-writing, the
   queue/DAG scheduler, dispatch/isolation/consults, review-at-merge, and CEO sign-off are the Phase-2
   *behavior* built and tuned here (spec §13, §12) — the interface does not change.
7. **Move the renderer behind the boundary.** Point the situation room + chat at the IPC client;
   subscribe to `status|org-chart|activity|artifact|checklist|eta|permission|done`. Verify the desktop
   bundle still builds with no engine/harness value-import leak.
8. **Retire the scaffold.** Delete `emitScriptedRun`; the scripted burst existed only to make the
   boundary exercisable in Phase 1.
