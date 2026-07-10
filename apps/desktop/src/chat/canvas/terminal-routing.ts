/**
 * Route long-running / interactive bash tool calls to a LIVE terminal view in
 * the canvas (round-7). A conservative heuristic classifies a bash command as
 * interactive/long-running (dev servers, watchers, REPLs, `tail -f`, …); such a
 * call opens a read-only "mirror" terminal tab that streams the tool's command +
 * output into an xterm (native-surfaces renders it). Ordinary one-shot commands
 * (`ls`, `pwd`, …) stay in the thread's activity chain and never open a tab.
 *
 * The mirror tab is keyed by the tool-call id; the user can still open their own
 * interactive terminal via the top-bar "New terminal" control (real PTY).
 * Detection is pure/unit-testable; the hook does the canvas side effects.
 */
import { type CanvasTab, useCanvasTabs } from '@pi-desktop/canvas';
import type { ChatMsg, ContentBlock } from '@pi-desktop/engine';
import { useEffect, useRef } from 'react';
import { usePiStore } from '../../state/pi-slice';
import { toolStepKind } from '../activity-mapping';

type ToolCallBlock = Extract<ContentBlock, { type: 'toolCall' }>;

/** One bash tool call mirrored into a terminal tab. */
export interface BashTerminalEvent {
  callId: string;
  command: string;
  output: string;
  running: boolean;
}

/**
 * Patterns that mark a command as interactive or long-running enough to warrant
 * a live terminal. Deliberately narrow so a routine `ls`/`git status` never
 * pops a terminal — only clearly persistent/interactive processes do.
 */
const INTERACTIVE_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|watch|serve|preview)\b/,
  /\bvite\b/,
  /\bnodemon\b/,
  /\bwebpack(?:-dev-server)?\b/,
  /\bnext\s+(?:dev|start)\b/,
  /\b(?:tail|watch|top|htop|less|vim|nano|ssh|irb|psql)\b/,
  /\btail\s+-f\b/,
  /--watch\b/,
  /\bpython3?\s+-m\s+http\.server\b/,
  /\bhttp-server\b/,
  /\bjest\s+--watch\b/,
  /\bdocker\s+(?:run|compose\s+up)\b/,
  /&\s*$/,
];

/** True when a bash command is interactive / long-running (→ live terminal). */
export function isInteractiveCommand(command: string): boolean {
  const c = command.trim();
  if (c === '') return false;
  return INTERACTIVE_PATTERNS.some((re) => re.test(c));
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function commandOf(block: ToolCallBlock): string | undefined {
  if (toolStepKind(block.name) !== 'bash') return undefined;
  return str(block.arguments?.command);
}

/** Detect the interactive bash calls in the thread, newest-state per call id. */
export function detectBashTerminals(messages: ChatMsg[]): BashTerminalEvent[] {
  const resultByCall = new Map<string, string>();
  for (const m of messages) {
    if (m.kind === 'toolResult') resultByCall.set(m.toolCallId, m.text);
  }
  const events: BashTerminalEvent[] = [];
  for (const m of messages) {
    if (m.kind !== 'assistant') continue;
    for (const block of m.blocks) {
      if (block.type !== 'toolCall') continue;
      const command = commandOf(block);
      if (command === undefined || !isInteractiveCommand(command)) continue;
      const output = resultByCall.get(block.id);
      events.push({
        callId: block.id,
        command,
        output: output ?? '',
        running: output === undefined,
      });
    }
  }
  return events;
}

const terminalTabKey = (callId: string): string => `term:${callId}`;

/** The xterm text for a mirror terminal: the command prompt + its output. */
function mirrorText(ev: BashTerminalEvent): string {
  const body = ev.output.length > 0 ? ev.output : ev.running ? '(running…)' : '(no output)';
  return `$ ${ev.command}\n\n${body}\n`;
}

function shortTitle(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 3).join(' ');
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}

/**
 * Watch the stream and mirror interactive bash calls into live terminal tabs.
 * Opens each once (a user-closed tab is not reopened) and refreshes its text as
 * output arrives; native-surfaces reconciles the xterm from `data.mirrorText`.
 */
export function useBashTerminalCanvasRouting(): void {
  const { controller } = useCanvasTabs();
  const messages = usePiStore((s) => s.messages) as ChatMsg[];
  const opened = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const ev of detectBashTerminals(messages)) {
      const key = terminalTabKey(ev.callId);
      const data: CanvasTab['data'] = { mirror: true, mirrorText: mirrorText(ev) };
      const existing = controller.getState().tabs.find((t) => t.key === key);
      if (existing === undefined) {
        if (opened.current.has(key)) continue;
        opened.current.add(key);
        controller.upsertTab(key, {
          kind: 'terminal',
          key,
          title: shortTitle(ev.command),
          data,
        });
      } else if ((existing.data?.mirrorText as string | undefined) !== data.mirrorText) {
        controller.updateTab(existing.id, { data });
      }
    }
  }, [messages, controller]);
}
