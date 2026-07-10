/**
 * Permission modes: bypass / reviewer / review-all.
 *
 * - `bypass`      — allow every tool call (fastest; trusted).
 * - `reviewer`    — allow everything except "scary" bash commands, which require
 *                   user confirmation. Scary is decided by the seeded regex rules
 *                   (permissions/rules.ts) plus an optional injectable
 *                   classifier-model hook.
 * - `review-all`  — confirm every tool call before it runs.
 *
 * The policy decision is a pure, synchronous function ({@link evaluateToolCall})
 * so it is trivially unit-tested; {@link registerPermissions} wires it to pi's
 * `tool_call` event and performs the actual `ctx.ui.confirm` / `{ block }`.
 */

import type { ExtensionAPI, ToolCallEvent } from '@mariozechner/pi-coding-agent';
import { isToolCallEventType } from '@mariozechner/pi-coding-agent';
import { checkScaryBash, type ScaryBashRules } from './rules.js';

export type PermissionMode = 'bypass' | 'reviewer' | 'review-all';

export const PERMISSION_MODES: readonly PermissionMode[] = ['bypass', 'reviewer', 'review-all'];

export function isPermissionMode(v: string): v is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(v);
}

/** The policy outcome for a single tool call. */
export type ToolCallDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'block'; readonly reason: string }
  | { readonly action: 'confirm'; readonly reason: string };

export interface EvaluateInput {
  readonly mode: PermissionMode;
  readonly toolName: string;
  /** Command text for bash calls (used by reviewer mode). */
  readonly bashCommand?: string;
  /**
   * Pre-computed scary reason for a bash command (from rules and/or the model
   * hook). `null`/undefined = not flagged. When provided, it overrides the
   * built-in rule check so async model flagging can be folded in by the caller.
   */
  readonly scaryReason?: string | null;
  /** Rule set for the built-in check when `scaryReason` is not supplied. */
  readonly rules?: ScaryBashRules;
}

/**
 * Pure permission policy. Decides allow / block / confirm for one tool call.
 * No UI, no async — the caller turns `confirm` into an actual dialog.
 */
export function evaluateToolCall(input: EvaluateInput): ToolCallDecision {
  switch (input.mode) {
    case 'bypass':
      return { action: 'allow' };

    case 'review-all':
      return { action: 'confirm', reason: 'review-all mode: confirm every tool call' };

    case 'reviewer': {
      if (input.toolName !== 'bash') return { action: 'allow' };
      const reason =
        input.scaryReason !== undefined
          ? input.scaryReason
          : checkScaryBash(input.bashCommand ?? '', input.rules);
      if (reason) return { action: 'confirm', reason: `reviewer mode: ${reason}` };
      return { action: 'allow' };
    }
  }
}

/** Injectable classifier-model hook: flag a bash command as scary (or not). */
export type BashFlagger = (command: string) => Promise<string | null>;

export interface PermissionController {
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
}

export interface RegisterPermissionsOptions {
  /** Initial mode (default "reviewer"). */
  readonly initialMode?: PermissionMode;
  /** Extra/overridden scary-bash rules. */
  readonly rules?: ScaryBashRules;
  /** Optional utility-model bash flagger, layered on top of the regex rules. */
  readonly flagBash?: BashFlagger;
  /** Notified whenever a call is blocked (for status/telemetry). */
  readonly onBlock?: (info: { readonly toolName: string; readonly reason: string }) => void;
}

/**
 * Wire the permission gate to pi's `tool_call` event. Returns a controller the
 * `/harness` command uses to switch modes at runtime.
 */
export function registerPermissions(
  pi: ExtensionAPI,
  opts: RegisterPermissionsOptions = {},
): PermissionController {
  let mode: PermissionMode = opts.initialMode ?? 'reviewer';

  pi.on('tool_call', async (event: ToolCallEvent, ctx) => {
    // Resolve a scary reason for bash up front (rules + optional model hook).
    let scaryReason: string | null | undefined;
    if (mode === 'reviewer' && isToolCallEventType('bash', event)) {
      const command = event.input.command ?? '';
      scaryReason = checkScaryBash(command, opts.rules);
      if (scaryReason === null && opts.flagBash !== undefined) {
        try {
          scaryReason = await opts.flagBash(command);
        } catch {
          scaryReason = null;
        }
      }
    }

    const bashCommand = isToolCallEventType('bash', event)
      ? (event.input.command ?? '')
      : undefined;
    const decision = evaluateToolCall({
      mode,
      toolName: event.toolName,
      bashCommand,
      scaryReason,
      rules: opts.rules,
    });

    if (decision.action === 'allow') return;

    if (decision.action === 'block') {
      opts.onBlock?.({ toolName: event.toolName, reason: decision.reason });
      return { block: true, reason: decision.reason };
    }

    // confirm
    if (!ctx.hasUI) {
      // No UI available (print mode) → fail safe: block rather than silently run.
      opts.onBlock?.({ toolName: event.toolName, reason: decision.reason });
      return { block: true, reason: `${decision.reason} (no UI to confirm)` };
    }
    const preview = bashCommand !== undefined ? `\n\n${bashCommand.slice(0, 200)}` : '';
    const ok = await ctx.ui.confirm(`Allow ${event.toolName}?`, `${decision.reason}${preview}`);
    if (!ok) {
      opts.onBlock?.({ toolName: event.toolName, reason: decision.reason });
      return { block: true, reason: `declined: ${decision.reason}` };
    }
    return;
  });

  return {
    getMode: () => mode,
    setMode: (m: PermissionMode) => {
      mode = m;
    },
  };
}
