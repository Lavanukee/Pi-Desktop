/**
 * Child-agent runner — spawns an isolated `pi --mode rpc` child, drives ONE
 * task to completion, and returns ONLY a concise summary to the caller. The
 * child's full transcript (its reasoning, every tool call, intermediate text)
 * never crosses back — the parent context receives the child's final assistant
 * turn and nothing else. This is the summary-only contract, mirrored from
 * RemotePi's commission.ts (a child process whose sole stdout summary returns).
 *
 * Behaviors kept from the engine's PiBridge: strict LF-only JSONL framing
 * (U+2028/U+2029 are never record delimiters), send-immediately (no readiness
 * handshake — pi buffers stdin), and a SIGTERM→SIGKILL teardown ladder so a
 * hung/crashed child fails the parent instead of wedging it.
 *
 * The child is spawned by re-executing the SAME pi launcher that runs the parent
 * (reconstructed from argv), with the same `-e` extension set (so local model
 * providers still work) but a fresh `--no-session` and an incremented
 * {@link SUBAGENT_DEPTH_ENV} so the child's own harness won't register the spawn
 * tool (no runaway recursion). Everything host-touching is injectable so this
 * unit-tests against a mock child with no real pi.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readSubagentDepth, SUBAGENT_DEPTH_ENV } from './types.js';

/** Structural slice of a spawned child process (tests inject a fake). */
export interface ChildLike {
  readonly pid?: number;
  readonly stdin: { write(data: string): void; end(): void };
  readonly stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void };
  readonly stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void };
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; cwd?: string },
) => ChildLike;

/** A reconstructed launch plan for a child pi. */
export interface ChildSpawnPlan {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string | undefined>;
}

export interface ChildSpawnOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly cwd?: string;
}

/** Pull the `-e <path>` / `--extension <path>` pairs out of a pi argv. */
export function extractExtensionPaths(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === '-e' || argv[i] === '--extension') {
      const p = argv[i + 1];
      if (p !== undefined && !p.startsWith('-')) out.push(p);
    }
  }
  return out;
}

/**
 * Reconstruct a child-pi launch plan from the parent's argv/env. Reuses the
 * parent launcher (`argv[0] argv[1]`) and its `-e` extensions, forces a fresh
 * headless session, and bumps the subagent depth. Pure — no spawning.
 */
export function buildChildSpawnPlan(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  overrides: ChildSpawnOverrides = {},
): ChildSpawnPlan {
  const eFlags = extractExtensionPaths(argv).flatMap((p) => ['-e', p]);
  const depth = readSubagentDepth(env) + 1;
  const childEnv: Record<string, string | undefined> = {
    ...env,
    // Headless: no ANSI, no color — the child's stdout is protocol JSONL only.
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    [SUBAGENT_DEPTH_ENV]: String(depth),
  };
  const piArgs = ['--mode', 'rpc', '--no-session', '--no-extensions', ...eFlags];
  if (overrides.provider !== undefined) piArgs.push('--provider', overrides.provider);
  if (overrides.model !== undefined) piArgs.push('--model', overrides.model);

  const command = argv[0];
  const cliEntry = argv[1];
  if (command !== undefined && cliEntry !== undefined && !cliEntry.startsWith('-')) {
    // node/electron + cli.js (the bundled / dev / mock-pi launcher).
    return { command, args: [cliEntry, ...piArgs], env: childEnv };
  }
  // Degrade: an explicit PI_BIN, else bare `pi` on PATH.
  const piBin = env.PI_BIN;
  if (piBin !== undefined && piBin !== '') return { command: piBin, args: piArgs, env: childEnv };
  return { command: 'pi', args: piArgs, env: childEnv };
}

export interface RunChildAgentOptions {
  /** The task the child agent should carry out (its prompt). */
  readonly goal: string;
  /** Display name (the app bridge titles the nested chat with it; the in-process
   * runner ignores it). */
  readonly name?: string;
  /** Hard timeout; on expiry the child is torn down and the run fails. */
  readonly timeoutMs: number;
  readonly provider?: string;
  readonly model?: string;
  readonly cwd?: string;
  /** Parent argv used to reconstruct the child launcher. Default process.argv. */
  readonly argv?: readonly string[];
  /** Parent env. Default process.env. */
  readonly env?: Record<string, string | undefined>;
  /** Spawn seam (tests inject a mock child). Default node's child_process. */
  readonly spawn?: SpawnLike;
  /** Live step callback — one call per observed tool/step in the child. */
  readonly onStep?: (step: string) => void;
  /** Abort the run (parent turn aborted); tears the child down. */
  readonly signal?: AbortSignal;
  /** Grace between SIGTERM and SIGKILL. Default 1500ms. */
  readonly killGraceMs?: number;
}

export interface ChildAgentResult {
  readonly ok: boolean;
  /** The child's final assistant text — the ONLY thing that returns. */
  readonly summary: string;
  /** Number of tool/steps the child took (for surfacing, not the transcript). */
  readonly steps: number;
  readonly timedOut: boolean;
  readonly error?: string;
}

/** Best-effort extraction of assistant text from a turn_end message shape. */
function assistantTextFromMessage(message: unknown): string {
  if (message === null || typeof message !== 'object') return '';
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== 'assistant') return '';
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  const parts: string[] = [];
  for (const block of m.content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/**
 * Run one subagent task to completion and resolve with a summary-only result.
 * Never rejects and never hangs: a child crash, spawn failure, timeout, or abort
 * all resolve with `ok: false` and a reason.
 */
export function runChildAgent(opts: RunChildAgentOptions): Promise<ChildAgentResult> {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const spawnFn = opts.spawn ?? ((c, a, o) => nodeSpawn(c, a, o) as unknown as ChildLike);
  const killGraceMs = opts.killGraceMs ?? 1500;
  const plan = buildChildSpawnPlan(argv, env, {
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });

  return new Promise<ChildAgentResult>((resolve) => {
    let settled = false;
    let steps = 0;
    let summary = '';
    let currentTurnText = '';
    const stderrTail: string[] = [];
    let stdoutBuf = '';
    let child: ChildLike;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (opts.signal !== undefined) opts.signal.removeEventListener('abort', onAbort);
    };

    const teardown = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, killGraceMs);
      killTimer.unref?.();
    };

    const finish = (result: ChildAgentResult, kill: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kill) teardown();
      resolve(result);
    };

    const onAbort = (): void => {
      finish({ ok: false, summary, steps, timedOut: false, error: 'aborted by parent' }, true);
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // startup banner / non-protocol noise
      }
      if (msg === null || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'message_update': {
          const ev = (
            msg as {
              assistantMessageEvent?: {
                type?: string;
                delta?: string;
                contentIndex?: number;
                partial?: { content?: Array<{ type?: string; name?: string }> };
              };
            }
          ).assistantMessageEvent;
          if (ev === undefined) break;
          if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
            currentTurnText += ev.delta;
          } else if (ev.type === 'toolcall_start') {
            steps += 1;
            const idx = typeof ev.contentIndex === 'number' ? ev.contentIndex : -1;
            const block = ev.partial?.content?.[idx];
            const name =
              block?.type === 'toolCall' && typeof block.name === 'string' ? block.name : 'tool';
            opts.onStep?.(name);
          }
          break;
        }
        case 'tool_execution_start': {
          const name = typeof msg.toolName === 'string' ? msg.toolName : 'tool';
          opts.onStep?.(name);
          break;
        }
        case 'turn_end': {
          const text = assistantTextFromMessage(msg.message);
          const chosen = text.trim().length > 0 ? text : currentTurnText;
          if (chosen.trim().length > 0) summary = chosen.trim();
          currentTurnText = '';
          break;
        }
        case 'agent_end': {
          const finalText = summary.trim().length > 0 ? summary : currentTurnText.trim();
          finish({ ok: true, summary: finalText, steps, timedOut: false }, true);
          break;
        }
        default:
          break;
      }
    };

    try {
      child = spawnFn(plan.command, plan.args, {
        env: plan.env,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    } catch (err) {
      finish(
        {
          ok: false,
          summary: '',
          steps: 0,
          timedOut: false,
          error: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        false,
      );
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      // Split on LF ONLY — U+2028/U+2029 inside JSON strings must stay intact.
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
        nl = stdoutBuf.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      for (const l of text.split('\n')) {
        if (l.trim().length > 0) stderrTail.push(l);
      }
      if (stderrTail.length > 40) stderrTail.splice(0, stderrTail.length - 40);
    });

    child.on('error', (err) => {
      finish(
        { ok: false, summary, steps, timedOut: false, error: `child error: ${err.message}` },
        false,
      );
    });

    child.on('exit', (code, signal) => {
      // A clean agent_end already resolved us; an exit before that is a crash.
      if (settled) return;
      const detail = stderrTail.slice(-6).join(' | ');
      finish(
        {
          ok: false,
          summary,
          steps,
          timedOut: false,
          error:
            `child exited before completing (code ${code ?? 'null'}, signal ${signal ?? 'null'})` +
            (detail.length > 0 ? `: ${detail}` : ''),
        },
        false,
      );
    });

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort);
    }

    timeoutTimer = setTimeout(() => {
      finish({ ok: false, summary, steps, timedOut: true, error: 'subagent timed out' }, true);
    }, opts.timeoutMs);
    timeoutTimer.unref?.();

    // Send-immediately: pi buffers stdin until its rpc reader attaches (PiBridge
    // does the same with its get_state probe). One prompt, then wait for
    // agent_end. `id` correlates the response but we drive off lifecycle events.
    try {
      child.stdin.write(`${JSON.stringify({ type: 'prompt', message: opts.goal, id: 'sub-1' })}\n`);
    } catch (err) {
      finish(
        {
          ok: false,
          summary: '',
          steps: 0,
          timedOut: false,
          error: `failed to send task: ${err instanceof Error ? err.message : String(err)}`,
        },
        true,
      );
    }
  });
}
