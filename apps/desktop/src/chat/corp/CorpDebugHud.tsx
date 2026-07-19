/**
 * CORP LIVE ACTIVITY HUD — a dev diagnostic overlay (shown only when the corp env
 * override `?corp` is set, i.e. a `PI_DESKTOP_CORP=1` / observed run) that answers,
 * at every instant: what does the system BELIEVE it is doing right now, and what
 * SHOULD the canvas be showing? It reads the same corp store the feed/canvas do,
 * so a "frozen with no streaming" moment can be diagnosed on the spot:
 *
 *  - a big clock + the shown node + its state,
 *  - the CURRENT activity: THINKING / STREAMING / WRITING <path> / EXECUTING <cmd>
 *    / a tool call / idle,
 *  - the EXPECTED canvas state (which tab should be live),
 *  - TIME SINCE the last stream delta (turns red past 3s while the node is still
 *    `working` — that is an inter-turn stall where a "Working…" indicator is owed),
 *  - a rolling, timestamped LOG of each activity section + its duration.
 *
 * Pure diagnostic: it never drives anything, and renders nothing outside a `?corp`
 * run, so it cannot affect a real user's app.
 */
import { useEffect, useRef, useState } from 'react';
import { type CorpBlock, shownCorpNode, useCorpStore } from '../../state/corp-store';

/** Only render inside a corp ENV-override run (`?corp` on the window URL) — a dev
 * diagnostic, never shown to a settings-enabled user. */
// The visual HUD is a DEV diagnostic — it must NOT ride the `?corp` feature flag
// (that's just "corp mode is on", which every corp user has). It requires its own
// explicit opt-in `?corphud` (PI_DESKTOP_CORP_HUD=1), so a normal corp run shows
// no debug overlay.
function hudEnabled(): boolean {
  try {
    return (
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('corphud')
    );
  } catch {
    return false;
  }
}

// The raw-store exposure for e2e probes rides the E2E flag (like `__pi_store`),
// independent of the visual HUD, so diagnostics keep working with no overlay.
function e2eEnabled(): boolean {
  try {
    return (
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')
    );
  } catch {
    return false;
  }
}

const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface Activity {
  readonly label: string;
  readonly canvas: string;
}

/** What is the shown node doing right now, and what should the canvas show. */
function deriveActivity(blocks: readonly CorpBlock[], nodeState: string | undefined): Activity {
  const last = blocks[blocks.length - 1];
  if (last === undefined) {
    return {
      label: nodeState === 'working' ? 'working (no output yet)' : 'starting…',
      canvas: '—',
    };
  }
  if (last.kind === 'thinking') {
    return { label: last.streaming ? 'THINKING' : 'thought (settled)', canvas: 'situation room' };
  }
  if (last.kind === 'text') {
    const w = /<function=(?:write|edit)>[\s\S]*?(?:<parameter=path>|["']path["']\s*:\s*["'])([^<"']+)/.exec(
      last.text,
    );
    if (w?.[1] !== undefined) {
      const p = w[1].trim();
      return { label: `WRITING ${p}`, canvas: `file ${p} (streaming)` };
    }
    const b = /<function=bash>[\s\S]*?(?:<parameter=command>|["']command["']\s*:\s*["'])([^<"']+)/.exec(
      last.text,
    );
    if (b?.[1] !== undefined) {
      return { label: `EXECUTING ${b[1].trim()}`, canvas: 'terminal' };
    }
    return { label: last.streaming ? 'STREAMING TEXT' : 'text (settled)', canvas: '—' };
  }
  if (last.kind === 'tool') {
    if (last.toolName === 'bash') {
      return { label: `EXECUTING ${last.detail ?? 'bash'}`, canvas: 'terminal' };
    }
    return { label: `TOOL ${last.toolName ?? '?'}`, canvas: last.path ? `file ${last.path}` : '—' };
  }
  return { label: `WROTE ${last.path} (+${last.addedLines})`, canvas: `file ${last.path}` };
}

/** A cheap content signature — grows whenever any block's text/output/count grows,
 * so a change marks a fresh stream delta (drives the stall timer). */
function blocksSig(blocks: readonly CorpBlock[]): number {
  let n = blocks.length;
  for (const b of blocks) {
    if (b.kind === 'text' || b.kind === 'thinking') n += b.text.length;
    else if (b.kind === 'tool') n += (b.detail?.length ?? 0) + (b.output?.length ?? 0);
    else n += b.addedLines + b.removedLines;
  }
  return n;
}

export function CorpDebugHud(): React.ReactElement | null {
  const enabled = hudEnabled();
  const e2e = e2eEnabled();
  const taskId = useCorpStore((s) => s.taskId);
  const workerBlocks = useCorpStore((s) => s.workerBlocks);
  const node = useCorpStore((s) => shownCorpNode(s));
  const [now, setNow] = useState(() => Date.now());
  const [log, setLog] = useState<Array<{ t: number; label: string }>>([]);
  const lastDeltaAt = useRef(Date.now());
  const lastSig = useRef(-1);
  const lastLabel = useRef('');

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // Dev diagnostic: expose the corp store so an e2e probe can inspect the raw
  // blocks (is the write content in the store as text vs a structured file block?).
  useEffect(() => {
    if (e2e && typeof window !== 'undefined') {
      (window as unknown as { __corpStore?: unknown }).__corpStore = useCorpStore;
    }
  }, [e2e]);

  const nodeId = node?.id;
  const blocks = nodeId !== undefined ? (workerBlocks[nodeId] ?? []) : [];
  const activity = deriveActivity(blocks, node?.state);

  // Track the last stream delta + log each activity-section change (in an effect,
  // not during render).
  useEffect(() => {
    const sig = blocksSig(blocks);
    if (sig !== lastSig.current) {
      lastSig.current = sig;
      lastDeltaAt.current = Date.now();
    }
    if (activity.label !== lastLabel.current) {
      lastLabel.current = activity.label;
      setLog((l) => [...l.slice(-13), { t: Date.now(), label: activity.label }]);
    }
  }, [blocks, activity.label]);

  // Reset the log when the task changes.
  useEffect(() => {
    setLog([]);
    lastLabel.current = '';
    lastSig.current = -1;
    lastDeltaAt.current = Date.now();
  }, [taskId]);

  if (!enabled || taskId === null) return null;

  const sinceDelta = now - lastDeltaAt.current;
  const working = node?.state === 'working';
  const stalled = sinceDelta > 2500 && working;
  // While a node is working but no token has streamed for a beat, the model is
  // PROCESSING (prefilling the prompt, or blocked on a slow tool) — surface that
  // instead of a stale "thought (settled)", so a gap never reads as frozen.
  const displayLabel = stalled ? `PROCESSING… (${(sinceDelta / 1000).toFixed(1)}s)` : activity.label;

  return (
    <div
      data-testid="corp-debug-hud"
      style={{
        // BOTTOM-LEFT, over the chat/sidebar — never over the canvas tab controls
        // (top-right) or the embedded browser view (which renders above the DOM and
        // would clip a right-side HUD). pointer-events:none so it never eats clicks.
        position: 'fixed',
        bottom: 8,
        left: 8,
        width: 320,
        zIndex: 2147483647,
        pointerEvents: 'none',
        background: 'rgba(6,8,12,0.92)',
        color: '#e6edf3',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 10,
        padding: '10px 12px',
        font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
        boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 1, fontVariantNumeric: 'tabular-nums' }}>
        {clockOf(now)}
      </div>
      <div style={{ opacity: 0.7, marginTop: 2 }}>
        node: {node?.name ?? '—'} · {node?.state ?? '—'}
      </div>
      <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: stalled ? '#ffd166' : '#e6edf3' }}>
        now: {displayLabel}
      </div>
      <div style={{ opacity: 0.85 }}>canvas: {activity.canvas}</div>
      <div style={{ marginTop: 4, color: stalled ? '#ff6b6b' : '#7ee787' }}>
        since last stream: {(sinceDelta / 1000).toFixed(1)}s{stalled ? '  ← processing, no tokens' : ''}
      </div>
      <div
        style={{
          marginTop: 8,
          paddingTop: 6,
          borderTop: '1px solid rgba(255,255,255,0.1)',
          opacity: 0.85,
          maxHeight: 190,
          overflow: 'hidden',
        }}
      >
        {log.map((e, i) => {
          const next = log[i + 1];
          const dur = ((next !== undefined ? next.t : now) - e.t) / 1000;
          return (
            <div key={`${e.t}-${i}`} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <span style={{ opacity: 0.6 }}>{clockOf(e.t)}</span> +{dur.toFixed(1)}s {e.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
