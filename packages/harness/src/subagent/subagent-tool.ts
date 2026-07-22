/**
 * `spawn_subagent` — the tool the model calls to outsource an isolated sub-task
 * to a child pi agent. It runs the child to completion through the memory-aware
 * {@link SubagentScheduler} and returns ONLY the child's concise summary to the
 * parent context — never the child's transcript, tool calls, or reasoning.
 *
 * Over-budget requests are rejected (or queued) by the scheduler, so the model
 * gets a clear "not started" reason instead of a silent RAM blow-up. Live
 * progress is surfaced separately by the scheduler's onChange publisher (wired
 * in the harness to `ctx.ui.setStatus('harness-subagents', …)`); this tool only
 * submits + reports the summary.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Static, Type } from '@sinclair/typebox';
import { type ChildAgentResult, type RunChildAgentOptions, runChildAgent } from './child-agent.js';
import type { SubagentRunner, SubagentScheduler } from './scheduler.js';
import { SPAWN_SUBAGENT_TOOL_NAME } from './types.js';

export { SPAWN_SUBAGENT_TOOL_NAME };

const DEFAULT_TIMEOUT_S = 300;
const MIN_TIMEOUT_S = 15;
const MAX_TIMEOUT_S = 1800;

const SubagentParams = Type.Object({
  goal: Type.String({
    description:
      'The self-contained task for the subagent, in plain English. It runs in ' +
      'isolation and only its final summary returns — include everything it needs.',
  }),
  name: Type.Optional(
    Type.String({
      description: 'Short label shown in the live subagent list (e.g. "Research docs").',
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: 'Optional model id override for the subagent (else inherits yours).',
    }),
  ),
  provider: Type.Optional(
    Type.String({ description: 'Optional provider override for the subagent.' }),
  ),
  est_ram_gb: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description:
        'Optional RAM estimate (GiB) for scheduling. Must be > 0. Raise it when the subagent uses a bigger/different model.',
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
    }),
  ),
});
type SubagentInput = Static<typeof SubagentParams>;

export interface SubagentToolDeps {
  readonly scheduler: SubagentScheduler;
  /** Child runner seam (tests inject a mock). Default: real child pi via {@link runChildAgent}. */
  readonly runChild?: (opts: RunChildAgentOptions) => Promise<ChildAgentResult>;
}

/** Derive a compact display name from the goal when the model omits one. */
export function deriveSubagentName(goal: string): string {
  const words = goal.trim().split(/\s+/).slice(0, 6).join(' ');
  return words.length > 48 ? `${words.slice(0, 45)}…` : words || 'Subagent';
}

function clampTimeout(seconds: number | undefined): number {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : DEFAULT_TIMEOUT_S;
  return Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, s)) * 1000;
}

/**
 * Register the `spawn_subagent` tool. The child run is scheduled (memory-aware)
 * and only the summary returns.
 */
export function registerSubagentTool(pi: ExtensionAPI, deps: SubagentToolDeps): void {
  const runChild = deps.runChild ?? runChildAgent;

  pi.registerTool({
    name: SPAWN_SUBAGENT_TOOL_NAME,
    label: 'Spawn Subagent',
    description:
      'Outsource a self-contained sub-task to an isolated child agent. The child runs its own ' +
      'agent loop in a separate process; its intermediate steps never enter your context — you ' +
      'receive ONLY its final summary. Use it to parallelize independent work or to keep a large ' +
      'sub-investigation out of your own context. Spawns are memory-scheduled: over-budget ' +
      'requests queue or are declined with a reason.',
    promptSnippet:
      'spawn_subagent: run an isolated sub-task in a child agent and get back only its summary.',
    promptGuidelines: [
      'Use spawn_subagent for independent sub-tasks (research, a contained refactor) whose details you do not need in-context.',
      'Give a fully self-contained goal — the subagent cannot see your conversation, only the goal you pass.',
    ],
    parameters: SubagentParams,
    async execute(toolCallId, params: SubagentInput, signal, _onUpdate, _ctx) {
      const goal = typeof params.goal === 'string' ? params.goal.trim() : '';
      if (goal.length === 0) {
        return {
          content: [{ type: 'text', text: 'spawn_subagent requires a non-empty "goal".' }],
          isError: true,
          details: { rejected: true },
        };
      }
      const name = params.name?.trim() ? params.name.trim() : deriveSubagentName(goal);
      const id = toolCallId && toolCallId.length > 0 ? toolCallId : `sub-${Date.now()}`;
      const timeoutMs = clampTimeout(params.timeout_seconds);

      // Captured (via a holder, so control-flow keeps its nullable type) — lets
      // the final tool result report steps/timeout without ever surfacing the
      // child's transcript (summary-only).
      const captured: { result: ChildAgentResult | null } = { result: null };
      const run: SubagentRunner = async ({ setStep }) => {
        setStep('Working…');
        const child = await runChild({
          goal,
          id,
          name,
          timeoutMs,
          ...(params.model !== undefined ? { model: params.model } : {}),
          ...(params.provider !== undefined ? { provider: params.provider } : {}),
          onStep: (step) => setStep(`Running ${step}`),
          ...(signal !== undefined ? { signal } : {}),
        });
        captured.result = child;
        return {
          ok: child.ok,
          summary: child.summary,
          ...(child.error !== undefined ? { error: child.error } : {}),
        };
      };

      // Forward ONLY a finite, positive estimate — a 0/negative/NaN value would
      // poison the scheduler's shared RAM accounting or slip past the budget.
      // (The schema's exclusiveMinimum guards the validated path; this guards a
      // hand-built/unvalidated call too.)
      const estRamGB =
        typeof params.est_ram_gb === 'number' &&
        Number.isFinite(params.est_ram_gb) &&
        params.est_ram_gb > 0
          ? params.est_ram_gb
          : undefined;
      const result = await deps.scheduler.submit({
        id,
        name,
        ...(estRamGB !== undefined ? { estRamGB } : {}),
        run,
      });

      if (!result.accepted) {
        return {
          content: [{ type: 'text', text: `Subagent not started: ${result.reason}` }],
          isError: true,
          details: { rejected: true, reason: result.reason },
        };
      }

      const outcome = result.outcome;
      const steps = captured.result?.steps ?? 0;
      const timedOut = captured.result?.timedOut ?? false;

      if (!outcome.ok) {
        const reason = outcome.error ?? outcome.summary ?? 'unknown error';
        return {
          content: [
            {
              type: 'text',
              text: `Subagent "${name}" ${timedOut ? 'timed out' : 'failed'}: ${reason}`,
            },
          ],
          isError: true,
          details: { ok: false, timedOut, steps, name },
        };
      }

      const summary = outcome.summary.trim() || '(the subagent produced no summary)';
      return {
        // ONLY the summary crosses back — this is the summary-only contract.
        content: [
          {
            type: 'text',
            text: `Subagent "${name}" completed in ${steps} step(s).\n\nSummary:\n${summary}`,
          },
        ],
        details: { ok: true, steps, name },
      };
    },
  });
}
