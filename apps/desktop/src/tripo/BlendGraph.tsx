/**
 * Animation state machine editor (ARDY, for motion matching). A full-viewport
 * node graph: each state is a motion, each edge a transition gated by a driving
 * parameter (Speed, MoveX, Grounded…). Drag nodes, wire transitions, edit their
 * conditions, mark the entry state, and export the whole graph as JSON — the
 * motion-matching set a game runtime drives. The motions themselves come from
 * the library (bundled presets + NL-authored ARDY clips) in the left panel.
 *
 * Design-backed until a live ARDY engine lands: the authoring is fully real
 * (real graph, real export); motion playback previews on the bundled dummy.
 */
import type { JSX, PointerEvent as ReactPointerEvent } from 'react';
import { useRef, useState } from 'react';
import { ANIM_PREVIEWS } from './assets/anim-previews';
import { IcBolt, IcClose, IcDownload, IcPlus, IcTrash } from './icons';
import { MenuAnchor, MenuItem, Segmented } from './primitives';
import { type BlendTransition, useTripoStore } from './store';

const NW = 138;
const NH = 66;

type Pt = { readonly x: number; readonly y: number };

/** Where the ray from a node's center toward `toward` exits the node rect —
 * so edges meet the node border (and its arrow lands on it), not the center. */
function borderPoint(cx: number, cy: number, toward: Pt): Pt {
  const hw = NW / 2 + 2;
  const hh = NH / 2 + 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const t = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : hw / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : hh / Math.abs(dy),
  );
  return { x: cx + dx * t, y: cy + dy * t };
}

function edgePath(a: Pt, b: Pt): string {
  // A gentle horizontal cubic between two border points.
  const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function TransitionEditor({ tr }: { readonly tr: BlendTransition }): JSX.Element {
  const params = useTripoStore((s) => s.blendParams);
  const states = useTripoStore((s) => s.blendStates);
  const motions = useTripoStore((s) => s.motionLibrary);
  const update = useTripoStore((s) => s.updateTransition);
  const remove = useTripoStore((s) => s.removeTransition);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);

  const nameOf = (stateId: string): string => {
    const st = states.find((x) => x.id === stateId);
    return motions.find((m) => m.id === st?.motionId)?.name ?? '—';
  };
  const param = params.find((p) => p.id === tr.paramId);
  const isBool = param?.type === 'bool';

  return (
    <div className="tp-tr-editor" data-testid="tp-transition-editor">
      <div className="tp-tr-editor-title">
        {nameOf(tr.from)} → {nameOf(tr.to)}
      </div>
      <div className="tp-tr-editor-row">
        <span className="tp-field-label">When</span>
        <MenuAnchor
          id="tr-param"
          placement="top-start"
          trigger={
            <button type="button" className="tp-select" onClick={() => toggleMenu('tr-param')}>
              {param?.name ?? 'param'}
            </button>
          }
          menu={params.map((p) => (
            <MenuItem
              key={p.id}
              label={p.name}
              checked={p.id === tr.paramId}
              onClick={() => {
                update(tr.id, { paramId: p.id });
                closeMenus();
              }}
            />
          ))}
        />
        <Segmented
          size="sm"
          options={(isBool ? (['==', '!='] as const) : (['>', '<', '==', '!='] as const)).map(
            (o) => ({ id: o, label: o }),
          )}
          value={tr.op}
          onChange={(v) => update(tr.id, { op: v })}
        />
        <input
          type="number"
          className="tp-textinput tp-tr-value"
          step={isBool ? 1 : 0.1}
          value={tr.value}
          data-testid="tp-transition-value"
          onChange={(e) => update(tr.id, { value: Number(e.target.value) })}
        />
      </div>
      <button
        type="button"
        className="tp-tr-delete"
        data-testid="tp-transition-delete"
        onClick={() => remove(tr.id)}
      >
        <IcTrash size={13} /> Delete transition
      </button>
    </div>
  );
}

export function BlendGraph(): JSX.Element {
  const states = useTripoStore((s) => s.blendStates);
  const transitions = useTripoStore((s) => s.blendTransitions);
  const motions = useTripoStore((s) => s.motionLibrary);
  const params = useTripoStore((s) => s.blendParams);
  const entryId = useTripoStore((s) => s.entryStateId);
  const selState = useTripoStore((s) => s.selectedStateId);
  const selTr = useTripoStore((s) => s.selectedTransitionId);
  const connectFrom = useTripoStore((s) => s.connectFromId);
  const set = useTripoStore((s) => s.set);
  const move = useTripoStore((s) => s.moveBlendState);
  const beginConnect = useTripoStore((s) => s.beginConnect);
  const finishConnect = useTripoStore((s) => s.finishConnect);
  const cancelConnect = useTripoStore((s) => s.cancelConnect);
  const removeState = useTripoStore((s) => s.removeBlendState);
  const setEntry = useTripoStore((s) => s.setEntryState);

  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);

  const motionOf = (id: string) => motions.find((m) => m.id === id);
  const nodeAt = (id: string) => states.find((s) => s.id === id);
  const center = (st: { x: number; y: number }): Pt => ({ x: st.x + NW / 2, y: st.y + NH / 2 });
  const rel = (clientX: number, clientY: number): Pt => {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  };

  const startDrag = (e: ReactPointerEvent, id: string) => {
    if (connectFrom !== null) return;
    const st = nodeAt(id);
    if (st === undefined) return;
    const p = rel(e.clientX, e.clientY);
    drag.current = { id, dx: p.x - st.x, dy: p.y - st.y };
    set('selectedStateId', id);
    set('selectedTransitionId', null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onCanvasMove = (e: ReactPointerEvent) => {
    if (connectFrom !== null) setCursor(rel(e.clientX, e.clientY));
    const d = drag.current;
    if (d === null) return;
    const p = rel(e.clientX, e.clientY);
    move(d.id, Math.max(0, p.x - d.dx), Math.max(0, p.y - d.dy));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const exportJson = () => {
    const graph = {
      kind: 'bobble-animation-state-machine',
      version: 1,
      parameters: params.map((p) => ({ name: p.name, type: p.type, default: p.value })),
      entry: entryId !== null ? (motionOf(nodeAt(entryId)?.motionId ?? '')?.name ?? null) : null,
      states: states.map((st) => ({
        id: st.id,
        motion: motionOf(st.motionId)?.name ?? 'motion',
        prompt: motionOf(st.motionId)?.prompt,
        entry: st.id === entryId,
      })),
      transitions: transitions.map((t) => ({
        from: motionOf(nodeAt(t.from)?.motionId ?? '')?.name ?? t.from,
        to: motionOf(nodeAt(t.to)?.motionId ?? '')?.name ?? t.to,
        condition: {
          parameter: params.find((p) => p.id === t.paramId)?.name ?? t.paramId,
          op: t.op,
          value: t.value,
        },
      })),
    };
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'state-machine.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const selectedTr = transitions.find((t) => t.id === selTr);

  return (
    <div className="tp-graph" data-testid="tp-blend-graph">
      <div className="tp-graph-head">
        <div className="tp-graph-titles">
          <span className="tp-graph-title">Animation State Machine</span>
          <span className="tp-graph-sub">Motion matching · {states.length} states</span>
        </div>
        <button
          type="button"
          className="tp-upload-btn tp-graph-export"
          data-testid="tp-graph-export"
          disabled={states.length === 0}
          onClick={exportJson}
        >
          <IcDownload size={14} />
          Export JSON
        </button>
        <button
          type="button"
          className="tp-iconbtn"
          aria-label="Close editor"
          data-testid="tp-graph-close"
          onClick={() => set('graphOpen', false)}
        >
          <IcClose size={16} />
        </button>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: canvas surface for a node-graph editor (nodes carry the real controls) */}
      <div
        ref={canvasRef}
        className="tp-graph-canvas"
        data-connecting={connectFrom !== null}
        onPointerMove={onCanvasMove}
        onPointerUp={endDrag}
        onPointerDown={(e) => {
          if (e.target === canvasRef.current) {
            set('selectedStateId', null);
            set('selectedTransitionId', null);
            if (connectFrom !== null) cancelConnect();
          }
        }}
      >
        <svg className="tp-graph-edges" aria-hidden="true">
          <defs>
            <marker
              id="tp-arrow"
              markerWidth="9"
              markerHeight="9"
              refX="7"
              refY="4.5"
              orient="auto"
            >
              <path d="M0 0 L9 4.5 L0 9 z" className="tp-arrow-head" />
            </marker>
          </defs>
          {transitions.map((t) => {
            const a = nodeAt(t.from);
            const b = nodeAt(t.to);
            if (a === undefined || b === undefined) return null;
            const ca = center(a);
            const cb = center(b);
            const pa = borderPoint(ca.x, ca.y, cb);
            const pb = borderPoint(cb.x, cb.y, ca);
            const param = params.find((p) => p.id === t.paramId);
            const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
            return (
              <g key={t.id} className="tp-edge" data-selected={t.id === selTr}>
                <path className="tp-edge-hit" d={edgePath(pa, pb)} />
                <path className="tp-edge-line" d={edgePath(pa, pb)} markerEnd="url(#tp-arrow)" />
                {/* biome-ignore lint/a11y/noStaticElementInteractions: SVG transition label, not a control surface */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: SVG label; the transition is also selectable/editable via its target node */}
                <g
                  className="tp-edge-label"
                  transform={`translate(${mid.x}, ${mid.y})`}
                  onClick={() => {
                    set('selectedTransitionId', t.id);
                    set('selectedStateId', null);
                  }}
                >
                  <rect x={-30} y={-11} width={60} height={22} rx={6} />
                  <text x={0} y={4} textAnchor="middle">
                    {(param?.name ?? '?').slice(0, 6)} {t.op} {t.value}
                  </text>
                </g>
              </g>
            );
          })}
          {connectFrom !== null && cursor !== null && nodeAt(connectFrom) !== undefined
            ? (() => {
                const c = center(nodeAt(connectFrom) as { x: number; y: number });
                return (
                  <path
                    className="tp-edge-ghost"
                    d={edgePath(borderPoint(c.x, c.y, cursor), cursor)}
                  />
                );
              })()
            : null}
        </svg>

        {states.map((st) => {
          const m = motionOf(st.motionId);
          const preview = m?.previewId !== undefined ? ANIM_PREVIEWS[m.previewId] : undefined;
          const isEntry = st.id === entryId;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: draggable graph node (contains its own real button controls)
            // biome-ignore lint/a11y/useKeyWithClickEvents: node is dragged/connected by pointer; its actions are real buttons inside
            <div
              key={st.id}
              className="tp-node"
              style={{ left: st.x, top: st.y, width: NW, height: NH }}
              data-entry={isEntry}
              data-selected={st.id === selState}
              data-testid={`tp-node-${st.id}`}
              onPointerDown={(e) => startDrag(e, st.id)}
              onClick={() => {
                if (connectFrom !== null && connectFrom !== st.id) finishConnect(st.id);
              }}
            >
              {isEntry ? <span className="tp-node-entry">Entry</span> : null}
              <div className="tp-node-thumb">
                {preview !== undefined ? (
                  <img src={preview.poster} alt="" draggable={false} />
                ) : (
                  <IcBolt size={16} />
                )}
              </div>
              <div className="tp-node-body">
                <span className="tp-node-name">{m?.name ?? 'motion'}</span>
                <span className="tp-node-kind">{m?.kind === 'generated' ? 'ARDY' : 'preset'}</span>
              </div>
              {/* connect handle — start a transition FROM this state */}
              <button
                type="button"
                className="tp-node-handle"
                aria-label="Draw transition"
                data-testid={`tp-node-connect-${st.id}`}
                data-active={connectFrom === st.id}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  beginConnect(st.id);
                }}
              >
                <IcPlus size={11} />
              </button>
              {st.id === selState ? (
                <div className="tp-node-tools" onPointerDown={(e) => e.stopPropagation()}>
                  {!isEntry ? (
                    <button
                      type="button"
                      className="tp-node-tool"
                      data-testid={`tp-node-entry-${st.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEntry(st.id);
                      }}
                    >
                      Set entry
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="tp-node-tool tp-node-tool-del"
                    aria-label="Delete state"
                    data-testid={`tp-node-del-${st.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeState(st.id);
                    }}
                  >
                    <IcTrash size={12} />
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}

        {states.length === 0 ? (
          <div className="tp-graph-empty" data-testid="tp-graph-empty">
            <IcBolt size={26} />
            <p>Add motions from the library to build your state machine</p>
            <span>Then wire transitions and set conditions for motion matching</span>
          </div>
        ) : null}

        {connectFrom !== null ? (
          <div className="tp-graph-hint">
            Click a target state to connect · click empty space to cancel
          </div>
        ) : null}
      </div>

      {selectedTr !== undefined ? <TransitionEditor tr={selectedTr} /> : null}
    </div>
  );
}
