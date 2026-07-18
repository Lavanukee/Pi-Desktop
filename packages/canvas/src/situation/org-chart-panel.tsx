/**
 * The living work tree — the emotional core of the situation room (spec §11).
 *
 * Renders the run as three tiers of cards (the lead → the plan/structure →
 * the areas of work, with builders as small indicators inside their area card)
 * over an SVG edge layer. All copy is USER-meaningful: what is happening to
 * the user's project, never the harness's internal org vocabulary.
 *
 * Motion (the build ANIMATES as it grows):
 *  - new cards materialize with the app's rise-in + a soft blur settle, and
 *    siblings that arrive in the same snapshot stagger in;
 *  - existing cards GLIDE to their new position (FLIP over the offset chain)
 *    when a sibling lands, so growth reads deliberate, not jumpy;
 *  - edges morph with the layout (CSS `d` transition) and carry a comet of
 *    energy while the downstream worker is mid-turn;
 *  - working cards get an elevated tint + a slow breathing glow, not a flat
 *    fill; indicators are thin animated rings, not solid dots.
 *
 * Geometry: cards are laid out by plain flex rows; the edge layer measures
 * card positions via the offset chain (transform-immune, so entrance motion
 * and FLIP glides never bend an edge) and draws cubic connectors beneath.
 */

import type { OrgChartView, OrgNodeView } from '@pi-desktop/coordination';
import { IconCheck } from '@pi-desktop/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Per-area task progress, keyed by area NAME (checklist group). */
export type DivisionProgress = Readonly<Record<string, { done: number; total: number }>>;

export interface SituationOrgChartProps {
  chart: OrgChartView;
  progress?: DivisionProgress;
  /** Power users see owned paths on area cards; everyone else sees purposes. */
  userMode?: 'user' | 'power';
  /** Clicking a node routes that worker's live stream to the app (spec §11). */
  onSelectNode?: (node: OrgNodeView) => void;
  selectedNodeId?: string;
}

/** Plain, user-meaningful role captions — never the internal org vocabulary. */
function roleLabel(node: OrgNodeView): string {
  switch (node.role) {
    case 'solo':
      return 'Working solo';
    case 'ceo':
      return 'Lead';
    case 'manager':
      return 'Planning';
    case 'division':
      return 'Work area';
    case 'division-head':
      return 'Area lead';
    case 'engineer':
      return 'Builder';
    case 'specialist':
      return 'Specialist';
  }
}

/** Plain-language state word for tooltips ("building", not "working"). */
function stateWord(state: OrgNodeView['state']): string {
  switch (state) {
    case 'working':
      return 'building';
    case 'idle':
      return 'waiting';
    case 'blocked':
      return 'blocked';
    case 'done':
      return 'done';
    case 'retired':
      return 'stepped away';
  }
}

interface EdgeGeom {
  key: string;
  d: string;
  length: number;
  /** The downstream node is mid-turn — run the energy comet along the edge. */
  active: boolean;
}

interface SeamGeom {
  key: string;
  d: string;
  active: boolean;
  title: string;
}

function cubicDown(x1: number, y1: number, x2: number, y2: number): string {
  const dy = Math.max(16, (y2 - y1) * 0.5);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

/** Approximate curve length — close enough to drive the draw-in dash. */
function approxLength(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1) * 1.2 + 8;
}

/** Offset-chain position of `el` relative to `container` (transform-immune). */
function offsetWithin(el: HTMLElement, container: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cursor: HTMLElement | null = el;
  while (cursor && cursor !== container) {
    x += cursor.offsetLeft;
    y += cursor.offsetTop;
    cursor = cursor.offsetParent instanceof HTMLElement ? cursor.offsetParent : null;
  }
  return { x, y };
}

export function SituationOrgChart({
  chart,
  progress,
  userMode = 'power',
  onSelectNode,
  selectedNodeId,
}: SituationOrgChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [edges, setEdges] = useState<readonly EdgeGeom[]>([]);
  const [seams, setSeams] = useState<readonly SeamGeom[]>([]);

  const nodes = chart.nodes;
  const root = nodes.find(
    (n) => n.parentId === undefined && (n.role === 'ceo' || n.role === 'solo'),
  );
  // The middle tier is the plan/structure row (managers + specialists) — never
  // a division: divisions own the tier below, so including them here (some
  // engines parent divisions straight to the root) would render each division
  // TWICE and, when selected, light up both copies (double `data-selected`).
  const midRow = nodes.filter(
    (n) =>
      n.role !== 'division' &&
      ((root !== undefined && n.parentId === root.id) ||
        (n.role === 'specialist' && n.parentId !== undefined && n.parentId !== root?.id)),
  );
  const divisions = nodes.filter((n) => n.role === 'division');
  const engineersOf = (divisionId: string) =>
    nodes.filter(
      (n) => n.parentId === divisionId && (n.role === 'engineer' || n.role === 'division-head'),
    );

  // Entrance orchestration: nodes that arrive in the SAME chart snapshot
  // stagger their materialize-in, so a burst of growth reads as a sequence.
  const seenNodes = useRef(new Set<string>());
  const enterDelay = new Map<string, number>();
  let newNodeIdx = 0;
  for (const n of nodes) {
    if (!seenNodes.current.has(n.id)) {
      enterDelay.set(n.id, Math.min(newNodeIdx, 5) * 90);
      newNodeIdx += 1;
    }
  }
  // Mark seen AFTER computing (in an effect) so re-renders keep stable delays.
  useEffect(() => {
    for (const n of chart.nodes) seenNodes.current.add(n.id);
  });

  // One-shot promotion flourish: when the root's role flips solo → ceo.
  const prevRole = useRef<OrgNodeView['role'] | undefined>(undefined);
  const [promoted, setPromoted] = useState(false);
  const rootRole = root?.role;
  useEffect(() => {
    const prev = prevRole.current;
    prevRole.current = rootRole;
    if (prev === 'solo' && rootRole === 'ceo') {
      setPromoted(true);
      const timer = setTimeout(() => setPromoted(false), 1100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [rootRole]);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const nodeById = new Map(chart.nodes.map((n) => [n.id, n]));
    // HONEST lighting: energy flows only toward nodes whose agent is actually
    // running. A division whose CREW is mid-turn counts — its builders ARE its
    // running work — but queued / parallel-not-yet-running nodes never light.
    const working = new Set(chart.nodes.filter((n) => n.state === 'working').map((n) => n.id));
    for (const n of chart.nodes) {
      if (
        (n.role === 'engineer' || n.role === 'division-head') &&
        n.state === 'working' &&
        n.parentId !== undefined
      ) {
        working.add(n.parentId);
      }
    }
    const divisionNodes = chart.nodes.filter((n) => n.role === 'division');
    const anchor = (id: string) => {
      const el = cardRefs.current.get(id);
      if (!el) return undefined;
      const { x, y } = offsetWithin(el, container);
      return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    };

    const nextEdges: EdgeGeom[] = [];
    for (const edge of chart.edges) {
      const child = nodeById.get(edge.to);
      if (!child || child.role === 'engineer' || child.role === 'division-head') continue;
      const from = anchor(edge.from);
      const to = anchor(edge.to);
      if (!from || !to) continue;
      const x1 = from.x + from.w / 2;
      const y1 = from.y + from.h;
      const x2 = to.x + to.w / 2;
      const y2 = to.y;
      nextEdges.push({
        key: `${edge.from}->${edge.to}`,
        d: cubicDown(x1, y1, x2, y2),
        length: approxLength(x1, y1, x2, y2),
        active: working.has(edge.to),
      });
    }

    const nextSeams: SeamGeom[] = [];
    if (chart.interfaces) {
      const cardByName = new Map(divisionNodes.map((d) => [d.name, d]));
      const seen = new Set<string>();
      let lane = 0;
      for (const seam of chart.interfaces) {
        for (const consumer of seam.consumedBy) {
          const a = cardByName.get(seam.exposedBy);
          const c = cardByName.get(consumer);
          if (!a || !c) continue;
          const pairKey = [a.id, c.id].sort().join('~');
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          const from = anchor(a.id);
          const to = anchor(c.id);
          if (!from || !to) continue;
          const x1 = from.x + from.w / 2;
          const x2 = to.x + to.w / 2;
          const y = Math.max(from.y + from.h, to.y + to.h);
          const dip = 12 + (lane % 4) * 7;
          lane += 1;
          nextSeams.push({
            key: pairKey,
            d: `M ${x1} ${y + 4} C ${x1} ${y + 4 + dip}, ${x2} ${y + 4 + dip}, ${x2} ${y + 4}`,
            active: working.has(a.id) || working.has(c.id),
            title: `${seam.name}: ${seam.exposedBy} → ${consumer}`,
          });
        }
      }
    }

    setEdges(nextEdges);
    setSeams(nextSeams);
  }, [chart]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // FLIP glide: when the layout reflows (a sibling landed), existing cards
  // animate from their previous offset to the new one instead of jumping.
  // The edge layer measures via the offset chain (transform-immune), so the
  // connectors morph to the FINAL geometry while cards glide into it.
  const prevPositions = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const liveIds = new Set(chart.nodes.map((n) => n.id));
    const next = new Map<string, { x: number; y: number }>();
    for (const [id, el] of cardRefs.current) {
      if (!el || !el.isConnected || !liveIds.has(id)) continue;
      next.set(id, offsetWithin(el, container));
    }
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced && typeof Element.prototype.animate === 'function') {
      for (const [id, pos] of next) {
        const prev = prevPositions.current.get(id);
        const el = cardRefs.current.get(id);
        if (!prev || !el) continue;
        const dx = prev.x - pos.x;
        const dy = prev.y - pos.y;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
          duration: 340,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
      }
    }
    prevPositions.current = next;
  }, [chart]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  const setCardRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el === null) cardRefs.current.delete(id);
    else cardRefs.current.set(id, el);
  };

  const moduleOf = (divisionName: string) => chart.modules?.find((m) => m.owner === divisionName);

  if (!root) {
    return (
      <div className="pd-sitroom-chart" ref={containerRef} data-empty>
        <div className="pd-sitroom-chart-empty">Getting ready…</div>
      </div>
    );
  }

  return (
    <div className="pd-sitroom-chart" ref={containerRef}>
      <svg className="pd-sitroom-edges" aria-hidden="true">
        <title>How the work connects</title>
        {seams.map((seam) => (
          <path
            key={seam.key}
            className="pd-sitroom-seam"
            d={seam.d}
            style={{ ['d' as string]: `path("${seam.d}")` }}
            data-active={seam.active || undefined}
          >
            <title>{seam.title}</title>
          </path>
        ))}
        {edges.map((edge) => (
          <g key={edge.key} style={{ ['--pd-edge-len' as string]: `${Math.round(edge.length)}px` }}>
            <path
              className="pd-sitroom-edge"
              d={edge.d}
              style={{ ['d' as string]: `path("${edge.d}")` }}
            />
            {edge.active ? (
              <>
                <path
                  className="pd-sitroom-edge-flow pd-sitroom-edge-flow--glow"
                  d={edge.d}
                  style={{ ['d' as string]: `path("${edge.d}")` }}
                />
                <path
                  className="pd-sitroom-edge-flow"
                  d={edge.d}
                  style={{ ['d' as string]: `path("${edge.d}")` }}
                />
              </>
            ) : null}
          </g>
        ))}
      </svg>

      <div className="pd-sitroom-tier pd-sitroom-tier--root">
        <NodeCard
          node={root}
          ref={setCardRef(root.id)}
          caption={roleLabel(root)}
          promoted={promoted}
          enterDelay={enterDelay.get(root.id)}
          selected={selectedNodeId === root.id}
          onSelect={onSelectNode}
        />
      </div>

      {midRow.length > 0 ? (
        <div className="pd-sitroom-tier">
          {midRow.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              ref={setCardRef(node.id)}
              caption={roleLabel(node)}
              enterDelay={enterDelay.get(node.id)}
              selected={selectedNodeId === node.id}
              onSelect={onSelectNode}
            />
          ))}
        </div>
      ) : null}

      {divisions.length > 0 ? (
        <div className="pd-sitroom-tier pd-sitroom-tier--divisions">
          {divisions.map((division) => {
            const engineers = engineersOf(division.id);
            const p = progress?.[division.name];
            const module = moduleOf(division.name);
            const caption =
              userMode === 'power'
                ? (module?.path ?? roleLabel(division))
                : (module?.purpose ?? roleLabel(division));
            // The area card carries the working glow while any of ITS builders
            // is actually mid-turn (the honest collective read); a division
            // whose crew is all queued stays dim.
            const crewActive = engineers.some((e) => e.state === 'working');
            return (
              <NodeCard
                key={division.id}
                node={division}
                ref={setCardRef(division.id)}
                caption={caption}
                captionMono={userMode === 'power' && module?.path !== undefined}
                meta={p && p.total > 0 ? `${p.done}/${p.total}` : undefined}
                crewActive={crewActive}
                enterDelay={enterDelay.get(division.id)}
                selected={selectedNodeId === division.id}
                onSelect={onSelectNode}
              >
                {engineers.length > 0 ? (
                  <span className="pd-sitroom-crew">
                    {engineers.map((engineer) => (
                      <button
                        key={engineer.id}
                        type="button"
                        className="pd-sitroom-crew-dot"
                        data-state={engineer.state}
                        data-selected={selectedNodeId === engineer.id || undefined}
                        title={`${engineer.name} — ${stateWord(engineer.state)}`}
                        aria-label={`${engineer.name} — ${stateWord(engineer.state)}`}
                        tabIndex={onSelectNode ? 0 : -1}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectNode?.(engineer);
                        }}
                      />
                    ))}
                  </span>
                ) : null}
              </NodeCard>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

interface NodeCardProps {
  node: OrgNodeView;
  caption?: string;
  captionMono?: boolean;
  /** Small trailing metric ("7/11"). */
  meta?: string;
  promoted?: boolean;
  /** An area card whose builders are mid-turn — carries the working glow. */
  crewActive?: boolean;
  /** Materialize-in stagger (ms) when this card is new in a snapshot burst. */
  enterDelay?: number;
  selected?: boolean;
  onSelect?: (node: OrgNodeView) => void;
  children?: React.ReactNode;
  ref?: (el: HTMLDivElement | null) => void;
}

function NodeCard({
  node,
  caption,
  captionMono,
  meta,
  promoted,
  crewActive,
  enterDelay,
  selected,
  onSelect,
  children,
  ref,
}: NodeCardProps) {
  const clickable = onSelect !== undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the card gets role="button" + tabIndex + keyboard handling whenever it is clickable (biome cannot see the conditional role).
    <div
      className="pd-sitroom-node"
      ref={ref}
      data-role={node.role}
      data-state={node.state}
      data-crew-active={crewActive || undefined}
      data-promoted={promoted || undefined}
      data-selected={selected || undefined}
      data-clickable={clickable || undefined}
      style={enterDelay ? { ['--pd-enter-delay' as string]: `${enterDelay}ms` } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={clickable ? `Watch ${node.name} live` : undefined}
      onClick={clickable ? () => onSelect(node) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(node);
              }
            }
          : undefined
      }
    >
      <span className="pd-sitroom-node-head">
        <span className="pd-sitroom-gem" data-state={node.state} aria-hidden="true">
          {node.state === 'done' ? (
            <IconCheck size={9} />
          ) : (
            <>
              <span className="pd-sitroom-gem-glow" />
              <span className="pd-sitroom-gem-ring" />
              <span className="pd-sitroom-gem-core" />
            </>
          )}
        </span>
        {/* Keyed by name so a promotion crossfades the label (Pi keeps the card, the hat changes). */}
        <span className="pd-sitroom-node-name" key={node.name}>
          {node.name}
        </span>
        {meta !== undefined ? <span className="pd-sitroom-node-meta">{meta}</span> : null}
      </span>
      {caption !== undefined ? (
        <span
          className="pd-sitroom-node-caption"
          data-mono={captionMono || undefined}
          key={caption}
        >
          {caption}
        </span>
      ) : null}
      {children}
    </div>
  );
}
