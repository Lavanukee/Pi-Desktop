#!/usr/bin/env node
/**
 * mock-pi — a deterministic stand-in for `pi --mode rpc`.
 *
 * Speaks the real RPC protocol over stdio (strict JSONL, LF-delimited) from a
 * transcript fixture, so unit/E2E tests can run the actual bridge / the built
 * Electron app against `PI_BIN=<this file>` with zero network or model.
 *
 * Usage:
 *   node mock-pi.mjs <fixture.json> [pi args ignored...]
 *   MOCK_PI_FIXTURE=<fixture.json> mock-pi.mjs --mode rpc ...
 *
 * pi CLI args (--mode rpc, -e <ext>, --session ...) are accepted and ignored;
 * set MOCK_PI_LOG=<path> to record argv + every received command as JSONL for
 * assertions on how the bridge spawned us.
 *
 * Fixture schema: see README.md next to this file.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const fixturePath = process.env.MOCK_PI_FIXTURE ?? args.find((a) => a.endsWith('.json'));
if (!fixturePath) {
  process.stderr.write('mock-pi: no fixture (pass <fixture.json> or set MOCK_PI_FIXTURE)\n');
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const logPath = process.env.MOCK_PI_LOG;
function log(record) {
  if (logPath) {
    try {
      appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    } catch {
      // Logging must never break the protocol.
    }
  }
}
log({ kind: 'spawn', argv: process.argv.slice(2), fixture: fixturePath });

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const defaultState = {
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  sessionId: 'mock-session-0001',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

let promptCursor = 0;
let playing = false;
let abortRequested = false;
/** Pending awaitUi steps: ui request id → resolve fn. */
const uiWaiters = new Map();

// ---------------------------------------------------------------------------
// In-memory fork DAG
//
// Models pi's `fork` / `get_fork_messages` / `switch_session` over a set of
// branches. Each branch is a linear list of user-message entries + its own
// session file (real pi mints a NEW session file per fork, branched at the
// forked message's parent, and switches to it — verified against the binary).
// Every `prompt` appends a user entry to the active branch; `fork` clones the
// active branch's entries BEFORE the forked message into a new active branch.
// ---------------------------------------------------------------------------

let entrySeq = 0;
const initialSessionFile =
  fixture.state?.sessionFile ?? `/mock/sessions/${fixture.name ?? 'branch'}-0.jsonl`;
/** branches[i] = { file, userMsgs: [{ entryId, text }] } */
const branches = [{ file: initialSessionFile, userMsgs: [] }];
let activeBranch = 0;

function activeSessionFile() {
  return branches[activeBranch].file;
}

// ---------------------------------------------------------------------------
// step playback
// ---------------------------------------------------------------------------

/**
 * String templating for fixtures: "$repeat:<count>:<unit>" expands to `unit`
 * repeated `count` times (used to script huge streamed blocks without
 * megabyte fixture files).
 */
function expandTemplates(value) {
  if (typeof value === 'string') {
    const match = value.match(/^\$repeat:(\d+):([\s\S]*)$/);
    if (match) return match[2].repeat(Number(match[1]));
    return value;
  }
  if (Array.isArray(value)) return value.map(expandTemplates);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = expandTemplates(entry);
    return out;
  }
  return value;
}

async function emitStep(step) {
  if (step.delayMs) await sleep(step.delayMs);
  if (step.emitRaw !== undefined) {
    process.stdout.write(step.emitRaw);
    return;
  }
  if (step.emit === undefined) return;
  const line = `${JSON.stringify(expandTemplates(step.emit))}\n`;
  const chunks = step.splitChunks ?? 1;
  if (chunks <= 1) {
    process.stdout.write(line);
    return;
  }
  // Deliberately split the line mid-record to exercise client buffering.
  const size = Math.max(1, Math.ceil(line.length / chunks));
  for (let i = 0; i < line.length; i += size) {
    process.stdout.write(line.slice(i, i + size));
    await sleep(2);
  }
}

async function play(steps, abortSteps) {
  playing = true;
  for (const step of steps ?? []) {
    if (abortRequested) {
      abortRequested = false;
      for (const abortStep of abortSteps ?? []) await emitStep(abortStep);
      playing = false;
      return;
    }
    if (step.awaitUi !== undefined) {
      await new Promise((resolve) => uiWaiters.set(step.awaitUi, resolve));
      continue;
    }
    await emitStep(step);
  }
  playing = false;
}

// ---------------------------------------------------------------------------
// command handling
// ---------------------------------------------------------------------------

function respond(cmd, extra) {
  const base = { type: 'response', command: cmd.type, success: true, ...extra };
  if (cmd.id !== undefined) base.id = cmd.id;
  writeLine(base);
}

function handleCommand(cmd) {
  log({ kind: 'command', command: cmd });

  if (cmd.type === 'extension_ui_response') {
    const waiter = uiWaiters.get(cmd.id);
    if (waiter) {
      uiWaiters.delete(cmd.id);
      log({ kind: 'ui_response', response: cmd });
      waiter(cmd);
    }
    return;
  }

  // Real pi rejects commands without a known type as `Unknown command: <x>` —
  // this is exactly what happens when a client forgets the type/command rename.
  if (typeof cmd.type !== 'string') {
    writeLine({
      type: 'response',
      command: 'unknown',
      success: false,
      error: `Unknown command: ${String(cmd.type)}`,
      ...(cmd.id !== undefined ? { id: cmd.id } : {}),
    });
    return;
  }

  const override = fixture.commandOverrides?.[cmd.type];
  if (override !== undefined) {
    respond(cmd, override);
    return;
  }

  switch (cmd.type) {
    case 'prompt': {
      // Slash commands (e.g. /harness ...) are extension/agent commands, not a
      // scripted LLM turn — ack without consuming a prompt or touching the DAG,
      // mirroring how real pi routes them (no user-message entry is recorded).
      if (typeof cmd.message === 'string' && cmd.message.startsWith('/')) {
        respond(cmd, { success: true });
        return;
      }
      const prompts = fixture.prompts ?? [];
      let index = -1;
      for (let i = promptCursor; i < prompts.length; i++) {
        const match = prompts[i].match;
        if (match === undefined || String(cmd.message ?? '').includes(match)) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        respond(cmd, { success: false, error: 'mock-pi: no scripted turn for this prompt' });
        return;
      }
      promptCursor = index + 1;
      const entry = prompts[index];
      // Record the user message on the active branch (fork/get_fork_messages).
      branches[activeBranch].userMsgs.push({
        entryId: `e${++entrySeq}`,
        text: String(cmd.message ?? ''),
      });
      respond(cmd, entry.response);
      if (entry.response?.success !== false) {
        void play(entry.steps, entry.abortSteps);
      }
      return;
    }
    case 'abort':
      if (playing) abortRequested = true;
      respond(cmd);
      return;
    case 'get_state':
      respond(cmd, {
        data: { ...defaultState, ...fixture.state, sessionFile: activeSessionFile() },
      });
      return;
    case 'get_available_models':
      respond(cmd, { data: { models: fixture.models ?? [] } });
      return;
    case 'get_messages':
      respond(cmd, { data: { messages: fixture.messages ?? [] } });
      return;
    case 'set_model': {
      const model = (fixture.models ?? []).find(
        (m) => m.id === cmd.modelId && m.provider === cmd.provider,
      );
      if (model) respond(cmd, { data: model });
      else
        respond(cmd, { success: false, error: `Model not found: ${cmd.provider}/${cmd.modelId}` });
      return;
    }
    case 'switch_session': {
      // Switching to a known branch file re-activates it (branch switching).
      const i = branches.findIndex((b) => b.file === cmd.sessionPath);
      if (i !== -1) activeBranch = i;
      respond(cmd, { data: { cancelled: false } });
      return;
    }
    case 'new_session':
    case 'clone':
      respond(cmd, { data: { cancelled: false } });
      return;
    case 'fork': {
      const active = branches[activeBranch];
      const idx = active.userMsgs.findIndex((u) => u.entryId === cmd.entryId);
      if (idx === -1) {
        writeLine({
          type: 'response',
          command: 'fork',
          success: false,
          error: 'Invalid entry ID for forking',
          ...(cmd.id !== undefined ? { id: cmd.id } : {}),
        });
        return;
      }
      const text = active.userMsgs[idx].text;
      // New branch = the entries BEFORE the forked message (real pi sets the
      // fork's leaf to the forked user message's PARENT), in a fresh file that
      // becomes active. The caller re-prompts to append the edited turn.
      branches.push({
        file: `/mock/sessions/${fixture.name ?? 'branch'}-${branches.length}.jsonl`,
        userMsgs: active.userMsgs.slice(0, idx).map((u) => ({ ...u })),
      });
      activeBranch = branches.length - 1;
      respond(cmd, { data: { text, cancelled: false } });
      return;
    }
    case 'get_last_assistant_text':
      respond(cmd, { data: { text: null } });
      return;
    case 'get_fork_messages':
      respond(cmd, {
        data: {
          messages: branches[activeBranch].userMsgs.map((u) => ({
            entryId: u.entryId,
            text: u.text,
          })),
        },
      });
      return;
    case 'get_commands':
      respond(cmd, { data: { commands: fixture.commands ?? [] } });
      return;
    case 'steer':
    case 'follow_up':
    case 'set_thinking_level':
    case 'set_steering_mode':
    case 'set_follow_up_mode':
    case 'set_auto_compaction':
    case 'set_auto_retry':
    case 'abort_retry':
    case 'abort_bash':
    case 'set_session_name':
      respond(cmd);
      return;
    default:
      writeLine({
        type: 'response',
        command: cmd.type,
        success: false,
        error: `mock-pi: unhandled command: ${cmd.type}`,
        ...(cmd.id !== undefined ? { id: cmd.id } : {}),
      });
  }
}

// ---------------------------------------------------------------------------
// stdin: strict JSONL reader (LF only, tolerate CRLF)
// ---------------------------------------------------------------------------

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\n');
  while (idx >= 0) {
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\n');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch (err) {
      writeLine({
        type: 'response',
        command: 'parse',
        success: false,
        error: `Failed to parse command: ${String(err?.message)}`,
      });
      continue;
    }
    handleCommand(cmd);
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
// The consumer disappearing mid-write (kill ladder, closed pipe) is a normal
// shutdown, not a crash.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

if (fixture.greeting) void play(fixture.greeting);
