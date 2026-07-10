# mock-pi

A deterministic stand-in for `pi --mode rpc`. It speaks the real RPC protocol
(strict JSONL over stdio, LF-delimited) from a JSON transcript fixture, so unit
tests and the built Electron app can run against `PI_BIN=<path to mock-pi.mjs>`
with no model, no network, and no timing flakiness.

## Running

```sh
node mock-pi.mjs fixtures/simple-chat.json
# or, the way the app spawns it (pi CLI args are accepted and ignored):
MOCK_PI_FIXTURE=$PWD/fixtures/simple-chat.json PI_BIN=$PWD/mock-pi.mjs <app>
```

- The fixture comes from `MOCK_PI_FIXTURE`, or the first `*.json` argument.
- `MOCK_PI_LOG=<path>` appends a JSONL record of the spawn argv and every
  received command — useful for asserting how the bridge spawned mock-pi
  (e.g. that `-e <extension>` flags were passed).
- Exits 0 on stdin end or SIGTERM (cooperates with the bridge kill ladder).

## Protocol behavior

- Every stdin line is parsed as a command; the response echoes the command
  `id` (this is how the bridge's pending-map correlation is exercised).
- A command with no `type` field gets the real-pi failure
  `Unknown command: undefined` — the regression the bridge's
  `command`→`type` rename exists to prevent.
- Unparseable stdin lines get `{"command":"parse","success":false,...}`.
- `get_state`, `get_available_models`, `get_messages`, `set_model`,
  `new_session`, `switch_session`, … are answered from fixture data
  (see schema below); simple commands (`steer`, `set_thinking_level`, …)
  get a bare `{"success":true}`.
- `prompt` consumes a scripted turn (see `prompts`) and streams its events.
  A message beginning with `/` is treated as an extension/agent command:
  `{"success":true}` with no scripted turn consumed and no DAG entry recorded
  (mirrors how real pi routes slash commands, e.g. the app's `/harness` config).
- `abort` responds `{"success":true}` and, if a turn is playing, stops it
  after the current step, then plays the turn's `abortSteps` (if any).
- `extension_ui_response` resolves a pending `awaitUi` step.

### Fork DAG (`fork` / `get_fork_messages` / `switch_session`)

The mock keeps an in-memory branch DAG so message-branch switching can be
driven end to end (verified against the real binary — real pi mints a NEW
session file per fork, branched at the forked message's parent, and switches to
it):

- Each `prompt` appends a `{ entryId, text }` user entry to the active branch.
- `get_fork_messages` returns the active branch's user entries, in order.
- `fork {entryId}` clones the active branch's entries **before** that entry into
  a new branch (fresh session file), makes it active, and returns
  `{ text, cancelled:false }` (or a top-level `success:false`,
  `Invalid entry ID for forking`, for an unknown id).
- `get_state.sessionFile` reflects the active branch's file, so the app can read
  the base/new branch identities around a fork.
- `switch_session {sessionPath}` re-activates the branch whose file matches (how
  the app keeps pi pointed at the shown branch when `‹/›` switches).

## Fixture schema

```jsonc
{
  "name": "human label",
  "state": { /* merged over defaults → get_state response data */ },
  "models": [ /* Model[] → get_available_models; also set_model lookup */ ],
  "messages": [ /* AgentMessage[] → get_messages */ ],
  "commands": [ /* RpcSlashCommand[] → get_commands */ ],
  "commandOverrides": {
    // Verbatim response-field override for any command type:
    "compact": { "success": false, "error": "quota exceeded" }
  },
  "greeting": [ /* Step[] played immediately at startup */ ],
  "prompts": [
    {
      // Optional substring match against the prompt message. The first
      // not-yet-consumed entry that matches wins; entries are consumed in
      // order. No match → {"success":false,"error":"mock-pi: no scripted..."}.
      "match": "confirm",
      // Response-field override for the prompt's own response (default
      // {"success":true}). If success:false, steps do not play.
      "response": { "success": true },
      "steps": [ /* Step[] */ ],
      "abortSteps": [ /* Step[] played when an abort interrupts playback */ ]
    }
  ]
}
```

### Steps

Each step is one of:

| Step | Meaning |
| --- | --- |
| `{ "emit": { ...event... } }` | Write one event as a JSONL record. |
| `{ "emit": {...}, "splitChunks": 3 }` | Same, but write the record in N slices with tiny pauses — exercises client chunk-boundary buffering (records split mid-line). |
| `{ "delayMs": 10, "emit": {...} }` | Pause before emitting (streaming pacing). `delayMs` also works alone as a pure pause. |
| `{ "emitRaw": "text" }` | Write raw bytes verbatim (no trailing `\n` added) — for non-JSON banners and torn-line torture. |
| `{ "awaitUi": "<request id>" }` | Block playback until an `extension_ui_response` with that id arrives on stdin (pair with an emitted `extension_ui_request` dialog). |

String templating: any string value equal to `"$repeat:<count>:<unit>"`
expands to `unit.repeat(count)` at emit time — used to script huge streamed
blocks without megabyte fixtures.

### Fidelity notes

- Events mirror pi 0.68.1 shapes: `message_update` carries
  `assistantMessageEvent` with `contentIndex` + `partial`; tool calls live in
  `partial.content[contentIndex]`. Fixture `partial`s are abbreviated to the
  `content` array (the router reads nothing else from them).
- `edge-cases.json` deliberately includes protocol torture: raw U+2028/U+2029
  inside JSON strings (V8 does not escape them — a readline-based client tears
  the record), a non-JSON startup banner, legacy pre-0.68 `toolcall_start`
  events with top-level `id`/`name`/`argsDelta`, tool executions whose
  `toolcall_start` never arrived (the router must synthesize rows), an aborted
  turn, and a blocking `confirm` dialog (`awaitUi`).

## Bundled fixtures

| Fixture | Scenario |
| --- | --- |
| `simple-chat.json` | One prompt → streamed text deltas (incl. a mid-record chunk split) → clean stop. Two models advertised. |
| `tool-use.json` | Three turns: bash call with streamed args + execution start/update/end; edit call whose streamed args contain `"path":` early (path-peek → artifact candidate); closing text turn. |
| `edge-cases.json` | Three prompts matched by substring: `think` (thinking deltas, unicode/U+2028 torture, ~19KB text block), `confirm` (blocking confirm dialog, errors-only notify policy, setStatus/setWidget, ghost + legacy tool calls), `abort` (turn ends with `error/aborted`). |
| `branch-chat.json` | Two prompts matched by `three` / `five`, each streaming a distinct response — drives edit→fork→branch-switch (`branch-switch-probe`). |
