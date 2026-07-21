/**
 * Validation spike (branch: modalities) — does running qwen as an *engineer role
 * inside a pi agentic harness* (tools + sampling) eliminate the runaway
 * "overthinking" that the bare single-completion path suffers?
 *
 * Standalone; does NOT touch corp production code. Starts + kills its own
 * llama-server. Uses pi SDK 0.68.1 in-process, headless.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---- constants -------------------------------------------------------------
const HOME = os.homedir();
const SERVER_BIN = `${HOME}/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server`;
const MODEL_GGUF = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const CHAT_TEMPLATE = `${HOME}/.cache/pi-desktop/chat-templates/Qwen--Qwen3.5-4B.jinja`;
const HOST = "127.0.0.1";
const PORT = 8171;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const PROVIDER = "corp-local";
const MODEL_ID = "qwen3.5-4b";
const CONTEXT_WINDOW = 16384;
const MAX_TOKENS = 8192;
const MAX_TOOL_CALLS = 15;
const PROMPT_TIMEOUT_MS = 9 * 60 * 1000;

const PI_INDEX =
  "/Users/jedd/Desktop/OSS-harness-modtest/node_modules/.pnpm/@mariozechner+pi-coding-agent@0.68.1_ws@8.21.0_zod@4.4.3/node_modules/@mariozechner/pi-coding-agent/dist/index.js";

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), "harness-spike-"));
const SERVER_LOG = path.join(RUN_DIR, "server.log");

const ENGINEER_SYSTEM_PROMPT = [
  "You are a senior TypeScript engineer working inside an agentic coding harness.",
  "You have file tools (read, write, edit, grep, find, ls) and a bash tool.",
  "Your job: implement the assigned contract by WRITING the required file(s) into the workspace using the `write` tool.",
  "Guidelines:",
  "- Write clean, idiomatic TypeScript with JSDoc. No external dependencies unless the contract says a package is available.",
  "- After writing, you MAY run one quick `bash` self-check (e.g. `ls` or `npx -y tsc --noEmit <file>`), but typechecking tooling may be absent and dependencies are NOT installed — do not install anything and do not block on a green typecheck.",
  "- Keep your reasoning and prose focused and short. Do not over-explain.",
  "- STOP as soon as the required file(s) are written. Do not keep iterating.",
].join("\n");

const CONTRACTS = [
  {
    id: "vec3",
    targetFile: "src/engine/vec3.ts",
    prompt:
      "Implement src/engine/vec3.ts — a Vector3 class with methods: add, subtract, dot, cross, normalize, length. TypeScript, JSDoc on each method, no external dependencies.",
  },
  {
    id: "scene",
    targetFile: "src/engine/scene.ts",
    prompt:
      "Implement src/engine/scene.ts — a minimal Three.js scene manager that sets up a scene, camera, renderer, a render loop, and window resize handling. Assume the `three` package is available (import from 'three'). TypeScript, JSDoc, focused.",
  },
];

// ---- tiny logger -----------------------------------------------------------
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
  console.error(line);
}

// ---- server lifecycle ------------------------------------------------------
let serverProc = null;

function startServer() {
  const args = [
    "-m", MODEL_GGUF,
    "--host", HOST,
    "--port", String(PORT),
    "-c", String(CONTEXT_WINDOW),
    "--parallel", "1",
    "--spec-type", "draft-mtp",
    "--spec-draft-n-max", "2",
    "--jinja",
    "--chat-template-file", CHAT_TEMPLATE,
  ];
  log("starting llama-server:", SERVER_BIN, args.join(" "));
  serverProc = spawn(SERVER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const append = (d) => { try { appendFileSync(SERVER_LOG, d); } catch {} };
  serverProc.stdout.on("data", append);
  serverProc.stderr.on("data", append);
  serverProc.on("exit", (code, sig) => log(`llama-server exited code=${code} sig=${sig}`));
}

function killServer() {
  if (serverProc && !serverProc.killed) {
    log("killing llama-server pid", serverProc.pid);
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

async function waitForHealth(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProc && serverProc.exitCode !== null) throw new Error("server exited before healthy");
    try {
      const r = await fetch(HEALTH_URL);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (!j.status || j.status === "ok") { log("server healthy:", JSON.stringify(j)); return; }
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 750));
  }
  throw new Error("server never became healthy");
}

// ---- workspace helpers -----------------------------------------------------
function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, base, out);
    else out.push({ path: path.relative(base, full), bytes: st.size, full });
  }
  return out;
}

// ---- one run ---------------------------------------------------------------
async function runContract(pi, contract) {
  const {
    createAgentSession, AuthStorage, ModelRegistry,
    DefaultResourceLoader, SessionManager, SettingsManager,
  } = pi;

  const workspace = path.join(RUN_DIR, `ws-${contract.id}`);
  mkdirSync(workspace, { recursive: true });
  const agentDir = path.join(RUN_DIR, `agent-${contract.id}`);
  mkdirSync(agentDir, { recursive: true });

  // --- model registration (keyless local openai-completions) ---
  const auth = AuthStorage.inMemory();
  const registry = ModelRegistry.create(auth);
  registry.registerProvider(PROVIDER, {
    baseUrl: BASE_URL,
    apiKey: "none",
    api: "openai-completions",
    models: [{
      id: MODEL_ID,
      name: "Corp Qwen",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CONTEXT_WINDOW,
      maxTokens: MAX_TOKENS,
      compat: { thinkingFormat: "qwen-chat-template" },
    }],
  });
  auth.setRuntimeApiKey(PROVIDER, "none"); // belt & suspenders for keyless streamFn
  const model = registry.find(PROVIDER, MODEL_ID);
  if (!model) throw new Error("model not found after registration");

  // --- per-run capture state ---
  const samplingLog = [];       // proof the sampling params were sent
  let providerCallSeq = 0;
  let strippedThinkingBlocks = 0;
  let toolCallSeq = 0;
  let stepCapHit = false;

  // --- extension factories (the harness "modality") ---
  const samplingFactory = (api) => {
    api.on("before_provider_request", (e) => {
      const p = e.payload;
      if (p && typeof p === "object") {
        p.top_p = 0.95;
        p.top_k = 20;
        p.min_p = 0;
        p.presence_penalty = 0;
        p.repetition_penalty = 1.0;
        p.temperature = 0.6;
        providerCallSeq += 1;
        samplingLog.push({
          call: providerCallSeq,
          top_p: p.top_p, top_k: p.top_k, min_p: p.min_p,
          presence_penalty: p.presence_penalty, repetition_penalty: p.repetition_penalty,
          temperature: p.temperature,
          max_tokens: p.max_tokens, max_completion_tokens: p.max_completion_tokens,
          stream: p.stream,
          enable_thinking:
            (p.chat_template_kwargs && p.chat_template_kwargs.enable_thinking) ?? p.enable_thinking,
          payloadKeys: Object.keys(p),
        });
        return p;
      }
      return undefined;
    });
  };

  const stripThinkingFactory = (api) => {
    // preserve-thinking OFF: strip prior thinking blocks from the outgoing context
    api.on("context", (e) => {
      const messages = e.messages.map((m) => {
        if (m && m.role === "assistant" && Array.isArray(m.content)) {
          const kept = m.content.filter((b) => b && b.type !== "thinking");
          const removed = m.content.length - kept.length;
          if (removed > 0 && kept.length > 0) {
            strippedThinkingBlocks += removed;
            return { ...m, content: kept };
          }
        }
        return m;
      });
      return { messages };
    });
  };

  const stepCapFactory = (api) => {
    api.on("tool_call", (e) => {
      toolCallSeq += 1;
      if (toolCallSeq > MAX_TOOL_CALLS) {
        stepCapHit = true;
        return { block: true, reason: `step cap (${MAX_TOOL_CALLS}) reached` };
      }
      return undefined;
    });
  };

  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager: settings,
    systemPrompt: ENGINEER_SYSTEM_PROMPT,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [samplingFactory, stripThinkingFactory, stepCapFactory],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir,
    authStorage: auth,
    modelRegistry: registry,
    model,
    thinkingLevel: "medium",
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: settings,
  });

  // --- capture events ---
  const toolEvents = [];
  const turnEvents = [];
  const unsub = session.subscribe((ev) => {
    if (ev.type === "tool_execution_end") toolEvents.push({ tool: ev.toolName, isError: ev.isError });
    if (ev.type === "turn_end") turnEvents.push(ev.turnIndex);
  });

  // --- run under timeout backstop ---
  let timedOut = false;
  let promptError = null;
  const t0 = Date.now();
  const timer = setTimeout(() => { timedOut = true; try { session.abort(); } catch {} }, PROMPT_TIMEOUT_MS);
  try {
    await session.prompt(contract.prompt);
  } catch (err) {
    promptError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  const wallMs = Date.now() - t0;
  unsub();

  // --- gather results ---
  const messages = session.state?.messages ?? [];
  const assistantTurns = messages
    .filter((m) => m.role === "assistant")
    .map((m, i) => {
      const content = Array.isArray(m.content) ? m.content : [];
      const thinking = content.filter((b) => b.type === "thinking");
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls = content.filter((b) => b.type === "toolCall").map((b) => b.name);
      return {
        turn: i + 1,
        outputTokens: m.usage?.output ?? null,
        stopReason: m.stopReason,
        thinkingChars: thinking.reduce((n, b) => n + (b.thinking?.length ?? 0), 0),
        textChars: text.length,
        toolCalls,
      };
    });

  let stats = null;
  try { stats = session.getSessionStats(); } catch {}
  const lastText = (() => { try { return session.getLastAssistantText(); } catch { return undefined; } })();

  const files = walkFiles(workspace).map((f) => ({
    path: f.path,
    bytes: f.bytes,
    head: readFileSync(f.full, "utf8").slice(0, 200),
  }));

  try { session.dispose(); } catch {}

  const maxTurnOutput = assistantTurns.reduce((mx, t) => Math.max(mx, t.outputTokens ?? 0), 0);
  const anyLength = assistantTurns.some((t) => t.stopReason === "length");
  const targetWritten = files.some((f) => f.path === contract.targetFile);
  const backstopped = timedOut || stepCapHit;
  const cleanTermination = !backstopped && !promptError;

  return {
    contract: contract.id,
    targetFile: contract.targetFile,
    wallMs,
    modelTurns: assistantTurns.length,
    assistantTurns,
    maxTurnOutputTokens: maxTurnOutput,
    anyTurnStopReasonLength: anyLength,
    ceilingContext: CONTEXT_WINDOW,
    toolCallsExecuted: toolEvents,
    toolCallCount: toolEvents.length,
    filesWritten: files,
    targetWritten,
    strippedThinkingBlocks,
    samplingCallCount: samplingLog.length,
    samplingSample: samplingLog.slice(0, 3),
    samplingParamsPresentEveryCall:
      samplingLog.length > 0 &&
      samplingLog.every((s) => s.top_p === 0.95 && s.top_k === 20 && s.temperature === 0.6 && s.repetition_penalty === 1.0),
    thinkingEnabledInPayload: samplingLog.length > 0 && samplingLog.every((s) => s.enable_thinking === true),
    stepCapHit,
    timedOut,
    promptError,
    cleanTermination,
    stats: stats && {
      totalMessages: stats.totalMessages,
      toolCalls: stats.toolCalls,
      tokens: stats.tokens,
    },
    lastAssistantTextHead: (lastText ?? "").slice(0, 300),
  };
}

// ---- main ------------------------------------------------------------------
async function main() {
  const results = [];
  try {
    startServer();
    await waitForHealth();

    const piMod = await import(pathToFileURL(PI_INDEX).href);

    for (const contract of CONTRACTS) {
      log(`==== running contract: ${contract.id} ====`);
      try {
        const r = await runContract(piMod, contract);
        results.push(r);
        log(`contract ${contract.id} done: turns=${r.modelTurns} maxTurnOut=${r.maxTurnOutputTokens} tools=${r.toolCallCount} clean=${r.cleanTermination} written=${r.targetWritten}`);
      } catch (err) {
        const msg = err instanceof Error ? (err.stack || err.message) : String(err);
        log(`contract ${contract.id} FAILED:`, msg);
        results.push({ contract: contract.id, fatalError: msg });
      }
    }
  } finally {
    killServer();
  }

  // server-log token cross-check
  let serverTiming = [];
  try {
    const logText = readFileSync(SERVER_LOG, "utf8");
    serverTiming = logText.split("\n").filter((l) => /n_decoded|tokens predicted|eval time|prompt eval/i.test(l)).slice(-24);
  } catch {}

  const report = { runDir: RUN_DIR, serverLog: SERVER_LOG, results, serverTimingTail: serverTiming };
  const outPath = path.join(RUN_DIR, "report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("\n===REPORT_JSON===");
  console.log(JSON.stringify(report, null, 2));
  console.log("===END_REPORT_JSON===");
  console.error("report written to", outPath);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { killServer(); process.exit(1); });
}
process.on("uncaughtException", (e) => { log("uncaughtException", e?.stack || e); killServer(); process.exit(1); });

main().then(() => { killServer(); process.exit(0); }).catch((e) => { log("main failed", e?.stack || e); killServer(); process.exit(1); });
