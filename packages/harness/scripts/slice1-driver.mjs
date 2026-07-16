#!/usr/bin/env node
/**
 * Slice-1 driver — promotion + one manager writing one division's contracts,
 * against a REAL OpenAI-compatible endpoint (a local llama-server /v1).
 *
 * This is a manual, model-in-the-loop harness for spec §12.1 ("does the worker
 * call create_production_hierarchy when — and only when — scope demands?") and
 * §12.2 ("does a manager write good contracts?"). It reuses the corp module
 * (@pi-desktop/harness/corp) end to end: the promotion system prompt, the tool
 * schema, the arg validator, buildManagerContractPrompt, and
 * parseManagerContracts. It does NOT launch a server — you point it at one.
 *
 * Usage:
 *   node packages/harness/scripts/slice1-driver.mjs \
 *     --url http://127.0.0.1:8080/v1 \
 *     --task "Build a 3D browser game with a storyline, gameplay, and UI"
 *
 * Options:
 *   --url         <baseUrl>   OpenAI-compat base ending in /v1        (required)
 *   --task        <prompt>    the user task to route                  (required)
 *   --model       <id>        model id sent in the body    (default "local-model")
 *   --max-tokens  <n>         generous cap — qwen3.5 THINKS first  (default 8192)
 *   --temperature <t>         sampling temperature                   (default 0.7)
 *   --timeout-ms  <ms>        per-call abort (local thinking is slow) (default 600000)
 *
 * Emits a single structured JSON report to STDOUT (progress goes to STDERR):
 *   { task, promoted, directAnswerPreview?, divisions?, firstDivisionContracts?,
 *     rawWorkerToolCall?, rawManagerReplyPreview, ...previews }
 */

import { register } from 'node:module';

// --- Import the corp TS module from a plain .mjs -----------------------------
// The corp sources use `.js` import specifiers that actually resolve to `.ts`
// (tsc rewrites them at build; Node's native type-stripping does not). This tiny
// resolve hook retries any relative `.js` specifier as `.ts` when the `.js` is
// absent, so `node slice1-driver.mjs` runs the TS module unbuilt.
const tsResolveHook = `
export async function resolve(specifier, context, next) {
  if (/^(\\.\\.?\\/|\\/)/.test(specifier) && specifier.endsWith('.js')) {
    try { return await next(specifier, context); }
    catch (err) {
      if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  }
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(tsResolveHook)}`);

const corpUrl = new URL('../src/corp/index.ts', import.meta.url).href;
const {
  PROMOTION_SYSTEM_PROMPT,
  CREATE_PRODUCTION_HIERARCHY,
  CREATE_PRODUCTION_HIERARCHY_TOOL,
  parseCreateHierarchyArgs,
  buildManagerContractPrompt,
  parseManagerContracts,
  getRolePrompt,
  roleThinkingEnabled,
} = await import(corpUrl);

// --- Args --------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = typeof args.url === 'string' ? args.url.replace(/\/+$/, '') : undefined;
const task = typeof args.task === 'string' ? args.task : undefined;
const model = typeof args.model === 'string' ? args.model : 'local-model';
const maxTokens = Number.isFinite(Number(args['max-tokens'])) ? Number(args['max-tokens']) : 8192;
const temperature = Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : 0.7;
const timeoutMs = Number.isFinite(Number(args['timeout-ms'])) ? Number(args['timeout-ms']) : 600000;

if (baseUrl === undefined || task === undefined) {
  console.error(
    'usage: node slice1-driver.mjs --url <http://host:port/v1> --task "<prompt>" [--model id] [--max-tokens n] [--temperature t] [--timeout-ms ms]',
  );
  process.exit(2);
}

const log = (...m) => console.error('[slice1]', ...m);
const preview = (s, n = 800) =>
  typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined;

// --- Per-role thinking control (corp knob) -----------------------------------
// qwen3.5 THINKS inside <think>…</think> before answering. Structured-output
// roles (the manager writing contract JSON) run thinking OFF — real-model testing
// showed the contract turn running away inside <think> and never closing it,
// starving the JSON (a 0-contract outcome). Judgment roles (the solo/promotion
// worker) run thinking ON — that reasoning is the value. See ROLE_THINKING in
// the corp module. When disabling, we set BOTH switches (belt-and-suspenders):
// llama.cpp's chat_template_kwargs.enable_thinking AND a /no_think prompt tag.
const NO_THINK_TAG = '/no_think';

/** The extra request body that carries the thinking switch for a turn. */
function thinkingBody(enabled) {
  return { chat_template_kwargs: { enable_thinking: enabled } };
}

/** Append the /no_think tag to a message string when thinking is disabled. */
function withThinkTag(content, enabled) {
  return enabled ? content : `${content}\n\n${NO_THINK_TAG}`;
}

// --- OpenAI-compat chat call: STREAMING (SSE) + accumulate -------------------
// Streaming, not one-shot: undici's hidden ~300s headers/body timeout kills a
// long non-streaming turn (the whole response is withheld until generation
// finishes). With stream:true the server sends tokens immediately and each SSE
// chunk resets the idle timer, so a >5min manager turn survives; the overall
// AbortSignal.timeout(timeoutMs) is the only hard cap. Returns the SAME message
// shape the rest of the driver expects ({ role, content, reasoning_content?,
// tool_calls? }), assembled from the deltas.
async function chat(body) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model, stream: true, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.body === null) throw new Error('streaming response had no body');
  return accumulateStream(res.body);
}

/** Fold streamed tool_call deltas (indexed, piecewise) into `acc` in place. */
function accumulateToolCalls(acc, deltas) {
  for (const d of deltas) {
    const idx = typeof d.index === 'number' ? d.index : acc.length;
    if (acc[idx] === undefined) {
      acc[idx] = {
        index: idx,
        id: undefined,
        type: 'function',
        function: { name: '', arguments: '' },
      };
    }
    const slot = acc[idx];
    if (typeof d.id === 'string') slot.id = d.id;
    if (typeof d.type === 'string') slot.type = d.type;
    const fn = d.function;
    if (fn !== undefined && fn !== null) {
      if (typeof fn.name === 'string') slot.function.name += fn.name;
      if (typeof fn.arguments === 'string') slot.function.arguments += fn.arguments;
    }
  }
}

/** Read an SSE body to completion, assembling one OpenAI-style message. */
async function accumulateStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const msg = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (line === '' || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = evt?.choices?.[0]?.delta;
        if (delta === undefined || delta === null) continue;
        if (typeof delta.content === 'string') msg.content += delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string') msg.reasoning_content += reasoning;
        if (Array.isArray(delta.tool_calls)) accumulateToolCalls(msg.tool_calls, delta.tool_calls);
      }
    }
  } finally {
    reader.releaseLock();
  }
  // Collapse empties back to the non-streaming shape callers already handle.
  msg.tool_calls = msg.tool_calls.filter(Boolean);
  if (msg.tool_calls.length === 0) msg.tool_calls = undefined;
  if (msg.reasoning_content === '') msg.reasoning_content = undefined;
  return msg;
}

/** Find the first balanced `{…}` in text and return it parsed, or undefined. */
function firstJsonObject(text) {
  if (typeof text !== 'string') return undefined;
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Detect a create_production_hierarchy call. Primary path = structured
 * `tool_calls`; fallback = the model wrote the call as prose in `content`
 * (spec §10 rung-0 territory). Returns { args, raw } or undefined.
 */
function detectPromotion(message) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (call?.function?.name !== CREATE_PRODUCTION_HIERARCHY) continue;
    const rawArgs = call.function.arguments;
    const decoded =
      typeof rawArgs === 'string' ? (firstJsonObject(rawArgs) ?? safeParse(rawArgs)) : rawArgs;
    const parsed = parseCreateHierarchyArgs(decoded);
    if (parsed !== undefined) return { args: parsed, raw: call };
  }
  // Fallback: a tool call written into content instead of the tool_calls array.
  const inText = parseCreateHierarchyArgs(firstJsonObject(message.content));
  if (inText !== undefined)
    return { args: inText, raw: { source: 'content', text: message.content } };
  return undefined;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// --- Run ---------------------------------------------------------------------
const report = { task, promoted: false };

try {
  // The pre-promotion solo worker has no node role of its own — it is a judgment
  // turn (promote or not), so it runs thinking ON like ROLE_THINKING's judgment
  // roles. Its reasoning is the value we want.
  const workerThinking = true;
  log(
    `worker turn → ${baseUrl} (max_tokens=${maxTokens}, timeout=${timeoutMs}ms, thinking=${workerThinking})`,
  );
  const workerMsg = await chat({
    messages: [
      { role: 'system', content: PROMOTION_SYSTEM_PROMPT },
      { role: 'user', content: task },
    ],
    tools: [CREATE_PRODUCTION_HIERARCHY_TOOL],
    tool_choice: 'auto',
    temperature,
    max_tokens: maxTokens,
    ...thinkingBody(workerThinking),
  });

  const workerReasoning = workerMsg.reasoning_content ?? workerMsg.reasoning;
  report.workerReasoningPreview = preview(workerReasoning);
  report.workerContentPreview = preview(workerMsg.content);

  const promotion = detectPromotion(workerMsg);
  if (promotion === undefined) {
    // Stayed solo — the model answered directly.
    report.promoted = false;
    report.directAnswerPreview = preview(workerMsg.content, 2000);
    log('result: stayed solo (no create_production_hierarchy call)');
  } else {
    report.promoted = true;
    report.divisions = promotion.args.divisions;
    report.promotionReason = promotion.args.reason;
    report.rawWorkerToolCall = promotion.raw;
    log(
      `result: PROMOTED — ${promotion.args.divisions.length} division(s): ${promotion.args.divisions
        .map((d) => d.name)
        .join(', ')}`,
    );

    // Manager turn for the FIRST division only (slice-1 scope).
    const firstDivision = promotion.args.divisions[0];
    report.firstDivision = firstDivision;
    const managerBase = getRolePrompt('manager').prompt;
    const managerUser = buildManagerContractPrompt(firstDivision, task);
    // Structured-output role: run thinking OFF so the contract JSON isn't starved
    // by a runaway <think> block. enable_thinking:false + a /no_think tag.
    const managerThinking = roleThinkingEnabled('manager');
    log(`manager turn → contracts for "${firstDivision.name}" (thinking=${managerThinking})`);
    const managerMsg = await chat({
      messages: [
        { role: 'system', content: managerBase },
        { role: 'user', content: withThinkTag(managerUser, managerThinking) },
      ],
      temperature,
      max_tokens: maxTokens,
      ...thinkingBody(managerThinking),
    });
    const managerReasoning = managerMsg.reasoning_content ?? managerMsg.reasoning;
    report.managerReasoningPreview = preview(managerReasoning);
    report.rawManagerReplyPreview = preview(managerMsg.content, 2000);
    const contracts = parseManagerContracts(managerMsg.content ?? '');
    report.firstDivisionContracts = contracts;
    report.firstDivisionContractCount = contracts.length;
    log(`parsed ${contracts.length} contract(s) for "${firstDivision.name}"`);
  }
} catch (err) {
  report.error = err instanceof Error ? err.message : String(err);
  log('ERROR:', report.error);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
