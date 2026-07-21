import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef, useState } from 'react';
import { DiffStat } from './activity.tsx';
import { CodeBlock } from './code-block.tsx';
import { type DiffFileData, DiffView } from './diff-view.tsx';
import { IconCheck, IconChevronRight, IconExternal } from './icons.tsx';
import { Markdown } from './markdown.tsx';
import { ShimmerText } from './shimmer.tsx';
import { Spinner } from './spinner.tsx';
import { ToolIcon, type ToolIconKind } from './tool-icons.tsx';
import { type WebSearchResultData, WebSearchResults } from './web-search.tsx';

/*
 * Collapsed activity chain (THEME 3, match Claude img8–11). A run of tool/
 * thinking steps collapses to ONE dim summary line that AGGREGATES the whole
 * chain by kind ("Ran 10 commands, thought for 1h 20m, read 3 files"); a
 * trailing chevron appears on hover. Click rolls the chain open to a vertical
 * stacked step list threaded by a left connector line.
 *
 * Step anatomy:
 *   - every step surfaces its PRIMARY arg inline next to the verb ("Read a file:
 *     config.ts" / "Ran: <cmd>" / "Searched: <query>") — jedd round-2 #2.
 *   - thinking / search steps are ALWAYS-EXPANDED inside the open chain — the
 *     thought text / web-search list render directly under the row, no click.
 *   - bash / edit / read / file steps make the WHOLE ROW a disclosure control
 *     (trailing chevron); clicking it reveals the full arg + the content
 *     (command+output / diff / preview).
 *   - media/preview steps carry `opensInCanvas` and route to the canvas.
 * Every open/collapse is a smooth height roll (reduced-motion safe).
 */

export type ActivityStepKind = ToolIconKind;
export type ActivityStatus = 'running' | 'done';

interface ActivityStepCommon {
  /** Stable key for lists; derived from kind+label when omitted. */
  id?: string;
  /** Present/past-tense row label ("Rewriting the plan…" / "Ran a command"). */
  label: string;
  /**
   * The step's PRIMARY argument, surfaced inline right after the verb so a row
   * reads "Read a file: <path>" / "Ran: <cmd>" / "Searched: <query>" instead of
   * a bare verb (jedd round-2 #2). Carries the FULL value (full path / command /
   * query / url): file-path kinds show its basename on the collapsed row and the
   * whole path in the expanded reveal; the rest show it verbatim. Empty/omitted →
   * no inline arg (the row falls back to just the verb).
   */
  detail?: string;
  /** Small pill/subtitle ("Script", or a filename). */
  tag?: ReactNode;
  /** Drives the file-extension icon badge and the default pill/tag. */
  filename?: string;
  /** `running` shimmers the row + spins; defaults to `done`. */
  status?: ActivityStatus;
  /**
   * Wall-clock this step took, in milliseconds. Summed per kind for the
   * aggregated summary line (thinking → "thought for 1h 20m").
   */
  durationMs?: number;
  /**
   * Media/preview steps (image/pdf/rendered file) do NOT expand inline —
   * activating them opens the canvas. The app reads this flag and routes.
   */
  opensInCanvas?: boolean;
}

export type ActivityStepData =
  | (ActivityStepCommon & { kind: 'thinking'; thought?: string })
  | (ActivityStepCommon & { kind: 'bash' | 'python'; command?: string; output?: string })
  | (ActivityStepCommon & {
      kind: 'edit';
      diff?: DiffFileData[];
      /** Explicit change counts for the label stat; derived from `diff` when omitted. */
      added?: number;
      deleted?: number;
    })
  | (ActivityStepCommon & { kind: 'read' | 'file' | 'skill'; preview?: ReactNode })
  | (ActivityStepCommon & {
      kind: 'search';
      query?: string;
      results?: WebSearchResultData[];
      /** Backend note shown in the empty state when there are no results. */
      note?: string;
    })
  | (ActivityStepCommon & {
      // Browser-action steps (round-10 #17): the URL/target is carried for a tag,
      // and browser-read expands the page text it returned as an inline preview.
      kind: 'browser-navigate' | 'browser-click' | 'browser-type' | 'browser-read';
      url?: string;
      preview?: ReactNode;
    })
  // Generic tool rows (tool-search + the NEUTRAL unknown-tool fallback) and
  // connector/MCP calls. All three reveal their raw args + result on click
  // (`argsText`/`output`); a connector also carries its brand mark (`iconSvg`)
  // so the row reads "Used <connector icon> <connector name>".
  | (ActivityStepCommon & {
      kind: 'tool-search' | 'tool';
      argsText?: string;
      output?: string;
    })
  | (ActivityStepCommon & {
      kind: 'connector';
      /** The connector's inline brand SVG (mcp-lite connector-icons), if resolved. */
      iconSvg?: string;
      argsText?: string;
      output?: string;
    })
  | (ActivityStepCommon & { kind: 'image' | 'pdf' | 'canvas-open' });

/* ------------------------------------------------------------------ */
/* Summary derivation (pure — unit-tested)                             */
/* ------------------------------------------------------------------ */

interface VerbSpec {
  verb: string;
  singular: string;
  /** Empty = non-countable phrase (e.g. "searched the web"), never pluralized. */
  plural: string;
}

const VERBS: Record<ActivityStepKind, VerbSpec> = {
  thinking: { verb: 'Thought', singular: '', plural: '' },
  bash: { verb: 'Ran', singular: 'a command', plural: 'commands' },
  python: { verb: 'Ran', singular: 'Python', plural: '' },
  edit: { verb: 'Edited', singular: 'a file', plural: 'files' },
  read: { verb: 'Read', singular: 'a file', plural: 'files' },
  file: { verb: 'Presented', singular: 'a file', plural: 'files' },
  skill: { verb: 'Read', singular: 'a skill', plural: 'skills' },
  search: { verb: 'Searched', singular: 'the web', plural: '' },
  'tool-search': { verb: 'Searched', singular: 'tools', plural: '' },
  'browser-navigate': { verb: 'Visited', singular: 'a page', plural: 'pages' },
  'browser-click': { verb: 'Clicked', singular: '', plural: '' },
  'browser-type': { verb: 'Typed', singular: '', plural: '' },
  'browser-read': { verb: 'Read', singular: 'the page', plural: 'pages' },
  connector: { verb: 'Used', singular: 'a connector', plural: 'connectors' },
  tool: { verb: 'Used', singular: 'a tool', plural: 'tools' },
  image: { verb: 'Generated', singular: 'an image', plural: 'images' },
  pdf: { verb: 'Created', singular: 'a PDF', plural: 'PDFs' },
  'canvas-open': { verb: 'Opened', singular: 'the canvas', plural: '' },
};

/**
 * Canonical phrase order for the aggregated summary. The summary is
 * order-INDEPENDENT (input order is discarded); kinds always read in this fixed
 * order so "ran, thought, ran, read" collapses to "Ran … thought … read …".
 */
const KIND_ORDER: ActivityStepKind[] = [
  'bash',
  'python',
  'thinking',
  'edit',
  'read',
  'file',
  'skill',
  'search',
  'tool-search',
  'browser-navigate',
  'browser-click',
  'browser-type',
  'browser-read',
  'connector',
  'tool',
  'image',
  'pdf',
  'canvas-open',
];

/** Format a millisecond duration as "Xh Ym" / "Ym Zs" / "Zs". */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function phrase(kind: ActivityStepKind, count: number, durationMs: number): string {
  // Thinking is duration-first when we have one ("thought for 1h 20m").
  if (kind === 'thinking') {
    return durationMs > 0 ? `Thought for ${formatDuration(durationMs)}` : 'Thought';
  }
  const spec = VERBS[kind];
  if (!spec.plural) {
    return spec.singular ? `${spec.verb} ${spec.singular}` : spec.verb;
  }
  const noun = count > 1 ? `${count} ${spec.plural}` : spec.singular;
  return `${spec.verb} ${noun}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Derive the collapsed summary line (past tense) by aggregating the ENTIRE chain
 * by kind — order-independent, each kind appearing once with its total count and
 * summed duration ("Ran 10 commands, thought for 1h 20m, read 3 files"). The
 * first phrase is capitalized, the rest lower-cased. Pure + deterministic.
 */
export function summarizeActivity(steps: ActivityStepData[]): string {
  const agg = new Map<ActivityStepKind, { count: number; durationMs: number }>();
  for (const step of steps) {
    const cur = agg.get(step.kind) ?? { count: 0, durationMs: 0 };
    cur.count += 1;
    cur.durationMs += step.durationMs ?? 0;
    agg.set(step.kind, cur);
  }
  const phrases: string[] = [];
  for (const kind of KIND_ORDER) {
    const entry = agg.get(kind);
    if (entry) phrases.push(phrase(kind, entry.count, entry.durationMs));
  }
  return phrases.map((p, i) => (i === 0 ? p : lowerFirst(p))).join(', ');
}

/** Present-tense phrase for the step currently in flight (B3). */
const RUNNING_PHRASE: Record<ActivityStepKind, string> = {
  thinking: 'Thinking…',
  bash: 'Running a command',
  python: 'Running Python',
  edit: 'Editing a file',
  read: 'Reading a file',
  file: 'Presenting a file',
  skill: 'Reading a skill',
  search: 'Searching the web',
  'tool-search': 'Searching tools',
  'browser-navigate': 'Navigating',
  'browser-click': 'Clicking',
  'browser-type': 'Typing',
  'browser-read': 'Reading the page',
  connector: 'Using a connector',
  tool: 'Running a tool',
  image: 'Generating an image',
  pdf: 'Creating a PDF',
  'canvas-open': 'Opening the canvas',
};

/**
 * The collapsed summary line for the chain. While ANY step is still running it
 * reads in the PRESENT tense (the in-flight step's label, else "Working…") so a
 * live chain never claims past-tense completion; once every step is done it
 * flips to the past-tense {@link summarizeActivity} roll-up. Pure + unit-tested.
 */
export function activitySummary(steps: ActivityStepData[]): string {
  if (steps.length === 0) return 'Working…';
  const running = steps.some((s) => s.status === 'running');
  if (!running) return summarizeActivity(steps);
  const current = [...steps].reverse().find((s) => s.status === 'running');
  return current ? RUNNING_PHRASE[current.kind] : 'Working…';
}

/* ------------------------------------------------------------------ */
/* Step classification + content by kind                               */
/* ------------------------------------------------------------------ */

/** thinking + search render their content inline (no click) inside an open chain. */
function isInlineKind(kind: ActivityStepKind): boolean {
  return kind === 'thinking' || kind === 'search';
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * Kinds whose `detail` is a file PATH: the collapsed row shows just the basename
 * (the meaningful tail — "Read a file: config.ts") while the expanded reveal
 * restates the full path. Command/query/url kinds show `detail` verbatim.
 */
const PATH_DETAIL_KINDS = new Set<ActivityStepKind>(['read', 'edit', 'file', 'skill']);

/**
 * File-op kinds that surface their filename as a SUBLINE directly under the verb
 * ("Read a file" / <config.ts>) — a two-line row (spec-tool-call-row). These are
 * also the kinds whose row can OPEN the underlying file in the canvas (the
 * `onOpenFile` seam), so the subline doubles as the "which file" affordance.
 */
const SUBLINE_KINDS = new Set<ActivityStepKind>(['read', 'edit', 'skill']);

/**
 * Kinds whose expanded reveal leads with the full primary arg — their inline
 * content (a file/page preview) doesn't otherwise restate it. bash/edit skip
 * this: their reveal already shows the command / the diff's own path header.
 */
const ARG_HEADER_KINDS = new Set<ActivityStepKind>(['read', 'file', 'skill', 'browser-read']);

/** Char count past which an in-chain thought fades + offers "Show more". */
const CHAIN_THOUGHT_LONG = 240;

/**
 * An in-chain thought (jedd round-5 #3): renders inline (no click) but NEVER
 * scrolls — a long one clamps with a bottom fade + a small "Show more" below.
 */
function ChainThought({ text, live = false }: { text: string; live?: boolean }) {
  const [showMore, setShowMore] = useState(false);
  const long = text.trim().length > CHAIN_THOUGHT_LONG;
  // While the thought is streaming live, never clamp — the newest tokens stay
  // visible so the user watches it generate (the thread auto-scrolls to follow).
  const clamped = long && !showMore && !live;
  return (
    <div className="pd-chain-thought">
      {/* jedd UI#5: reasoning renders through the SAME Markdown pipeline as a
       * regular message (gfm, math, code chrome, hex swatches) — the scoped CSS
       * on `.pd-chain-thought .pd-markdown` just scales it to the footnote size +
       * secondary color of a thought. The clamp/fade lives on the wrapper. */}
      <div className="pd-chain-thought-text" data-clamped={clamped}>
        <Markdown>{text}</Markdown>
      </div>
      {long && !live ? (
        <button
          type="button"
          className="pd-showmore pd-focusable"
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
        >
          {showMore ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/** Sum per-file ± counts for the `edit` step label stat. */
function editTotals(step: Extract<ActivityStepData, { kind: 'edit' }>): {
  added: number;
  deleted: number;
} {
  if (step.added !== undefined || step.deleted !== undefined) {
    return { added: step.added ?? 0, deleted: step.deleted ?? 0 };
  }
  let added = 0;
  let deleted = 0;
  for (const file of step.diff ?? []) {
    added += file.added ?? 0;
    deleted += file.deleted ?? 0;
  }
  return { added, deleted };
}

/**
 * A labeled, scroll-inside output frame (round-5 #6): border + radius ride the
 * frame (overflow clipped) so it never gets cut off under horizontal scroll.
 * Shared by bash/python terminals and generic tool/connector result reveals.
 */
function OutputBlock({ text, label = 'Output' }: { text: string; label?: string }) {
  return (
    <div className="pd-chain-output">
      <div className="pd-chain-output-label">{label}</div>
      <div className="pd-chain-output-frame">
        <pre className="pd-chain-output-body pd-scroll">{text}</pre>
      </div>
    </div>
  );
}

function StepContent({ step, live = false }: { step: ActivityStepData; live?: boolean }) {
  switch (step.kind) {
    case 'thinking':
      return step.thought ? <ChainThought text={step.thought} live={live} /> : null;
    case 'bash':
    case 'python':
      return (
        <div className="pd-chain-terminal">
          {step.command !== undefined ? (
            <CodeBlock code={step.command} language={step.kind === 'python' ? 'python' : 'bash'} />
          ) : null}
          {step.output !== undefined ? <OutputBlock text={step.output} /> : null}
        </div>
      );
    case 'edit':
      return step.diff ? <DiffView files={step.diff} /> : null;
    case 'search':
      return step.results ? (
        <WebSearchResults
          query={step.query ?? step.label}
          results={step.results}
          emptyHint={step.note}
        />
      ) : null;
    case 'read':
    case 'file':
    case 'skill':
    case 'browser-read':
      return step.preview !== undefined ? (
        <div className="pd-chain-preview">{step.preview}</div>
      ) : null;
    // Generic tool / connector / tool_search: the reveal shows the raw call args
    // (input) then the tool's result (output) — so every tool row, even one we
    // don't specifically model, is transparent about what it did.
    case 'tool-search':
    case 'tool':
    case 'connector':
      return (
        <div className="pd-chain-terminal">
          {step.argsText !== undefined && step.argsText.length > 0 ? (
            <OutputBlock text={step.argsText} label="Input" />
          ) : null}
          {step.output !== undefined && step.output.length > 0 ? (
            <OutputBlock text={step.output} />
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

/** Whether a step has inline content worth a reveal (pill) or inline render. */
function hasInlineContent(step: ActivityStepData): boolean {
  if (step.opensInCanvas) return false;
  switch (step.kind) {
    case 'thinking':
      return step.thought !== undefined;
    case 'bash':
    case 'python':
      return step.command !== undefined || step.output !== undefined;
    case 'edit':
      return step.diff !== undefined && step.diff.length > 0;
    case 'search':
      return step.results !== undefined;
    case 'read':
    case 'file':
    case 'skill':
    case 'browser-read':
      return step.preview !== undefined;
    case 'tool-search':
    case 'tool':
    case 'connector':
      return (
        (step.argsText !== undefined && step.argsText.length > 0) ||
        (step.output !== undefined && step.output.length > 0)
      );
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* ActivityStep                                                        */
/* ------------------------------------------------------------------ */

export interface ActivityStepProps {
  data: ActivityStepData;
  /** Toggles a pill-gated step's content (bash/edit/read/file). */
  expanded?: boolean;
  /** This step is streaming live — thought content shows un-clamped. */
  live?: boolean;
  /** Toggles inline content (kinds without `opensInCanvas`). */
  onToggle?: () => void;
  /** Fired for `opensInCanvas` steps instead of toggling. */
  onOpenCanvas?: () => void;
  /**
   * Fired for a file-op row (read/edit/skill with a path) to OPEN that file in
   * the canvas. When set, the row's primary click opens the file and a trailing
   * chevron still discloses the raw args + result; when unset the row falls back
   * to the plain disclosure toggle. Wired by the app (ThreadActivity).
   */
  onOpenFile?: () => void;
}

/** One row of the expanded chain: icon + verb + inline arg, then a disclosure reveal. */
export const ActivityStep = forwardRef<HTMLDivElement, ActivityStepProps>(function ActivityStep(
  { data, expanded = false, live = false, onToggle, onOpenCanvas, onOpenFile },
  ref,
) {
  const running = data.status === 'running';
  const canvas = data.opensInCanvas === true;
  const inline = isInlineKind(data.kind);
  // Pill-gated kinds (bash/edit/read/file/skill/browser-read/connector/tool) turn
  // the WHOLE row into a disclosure control (jedd round-2 #2): click to reveal the
  // full arg + the result/output.
  const disclosable = !canvas && !inline && hasInlineContent(data);
  const canvasTag = data.tag ?? (data.filename ? basename(data.filename) : undefined);
  // The edit step carries its ±stat right beside the label (round-5 #12).
  const editStat = data.kind === 'edit' ? editTotals(data) : null;
  // The primary arg, surfaced next to the verb: a file-op path shows its basename
  // on a SUBLINE under the label; command/query/url kinds show it inline verbatim.
  const detail = data.detail !== undefined && data.detail !== '' ? data.detail : undefined;
  const subline =
    detail !== undefined && SUBLINE_KINDS.has(data.kind) ? basename(detail) : undefined;
  const detailInline =
    subline !== undefined
      ? undefined
      : detail === undefined
        ? undefined
        : PATH_DETAIL_KINDS.has(data.kind)
          ? basename(detail)
          : detail;
  const argHeader = disclosable && detail !== undefined && ARG_HEADER_KINDS.has(data.kind);
  // A file-op row (read/edit/skill with a path) can open that file in the canvas.
  const canOpen = onOpenFile !== undefined && SUBLINE_KINDS.has(data.kind) && detail !== undefined;

  const iconEl = (
    <span className="pd-chain-step-icon">
      {running ? (
        <Spinner size={14} />
      ) : (
        <ToolIcon
          kind={data.kind}
          filename={data.filename}
          iconSvg={data.kind === 'connector' ? data.iconSvg : undefined}
        />
      )}
    </span>
  );

  const labelText = running ? <ShimmerText>{data.label}</ShimmerText> : data.label;
  // File-op rows read as a two-line stack (verb + filename subline); other rows
  // keep the verb + inline arg on one line.
  const contentEls =
    subline !== undefined ? (
      <span className="pd-chain-step-labels">
        <span className="pd-chain-step-label">{labelText}</span>
        <span className="pd-chain-step-subline" title={detail}>
          {subline}
        </span>
      </span>
    ) : (
      <>
        <span className="pd-chain-step-label">{labelText}</span>
        {detailInline !== undefined ? (
          <span className="pd-chain-step-detail" title={detail}>
            {detailInline}
          </span>
        ) : null}
      </>
    );

  const editStatEl = editStat ? (
    <DiffStat
      className="pd-chain-step-diffstat"
      added={editStat.added}
      deleted={editStat.deleted}
    />
  ) : null;
  const chevronEl = (
    <span className="pd-chain-step-chevron" data-expanded={expanded}>
      <IconChevronRight size={12} />
    </span>
  );
  const openLabel = `Open ${subline ?? 'file'} in canvas`;

  return (
    <div
      ref={ref}
      className="pd-chain-step"
      data-expanded={disclosable ? expanded : undefined}
      data-kind={data.kind}
    >
      {canvas ? (
        <button type="button" className="pd-chain-step-row pd-focusable" onClick={onOpenCanvas}>
          {iconEl}
          {contentEls}
          {editStatEl}
          {canvasTag !== undefined ? <span className="pd-chain-step-tag">{canvasTag}</span> : null}
          <span className="pd-chain-step-canvas" role="img" aria-label="Opens in canvas">
            <IconExternal size={13} />
          </span>
        </button>
      ) : canOpen && disclosable ? (
        // File-op row with content: main click OPENS the file in canvas; the
        // trailing chevron discloses the raw args + result.
        <div className="pd-chain-step-row pd-chain-step-row--split">
          <button
            type="button"
            className="pd-chain-step-open-main pd-focusable"
            onClick={onOpenFile}
            aria-label={openLabel}
            title={openLabel}
          >
            {iconEl}
            {contentEls}
            {editStatEl}
          </button>
          <button
            type="button"
            className="pd-chain-step-disclose pd-focusable"
            aria-expanded={expanded}
            aria-label="Show details"
            onClick={onToggle}
          >
            {chevronEl}
          </button>
        </div>
      ) : canOpen ? (
        // File-op row with no captured content yet: the whole row opens the file.
        <button
          type="button"
          className="pd-chain-step-row pd-focusable"
          onClick={onOpenFile}
          aria-label={openLabel}
          title={openLabel}
        >
          {iconEl}
          {contentEls}
          {editStatEl}
          <span className="pd-chain-step-canvas" role="img" aria-label="Opens in canvas">
            <IconExternal size={13} />
          </span>
        </button>
      ) : disclosable ? (
        <button
          type="button"
          className="pd-chain-step-row pd-focusable"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {iconEl}
          {contentEls}
          {editStatEl}
          {chevronEl}
        </button>
      ) : (
        <div className="pd-chain-step-row">
          {iconEl}
          {contentEls}
          {editStatEl}
        </div>
      )}

      {inline && hasInlineContent(data) ? (
        // Thoughts never scroll (they fade + Show more); search keeps a bounded scroll.
        <div
          className={clsx(
            'pd-chain-step-inline',
            data.kind !== 'thinking' && 'pd-chain-step-inline--scroll pd-scroll',
          )}
        >
          <StepContent step={data} live={live} />
        </div>
      ) : null}

      {disclosable ? (
        <div className="pd-chain-reveal" data-open={expanded}>
          <div className="pd-chain-reveal-inner">
            <div className="pd-chain-step-content pd-scroll">
              {argHeader ? (
                <div className="pd-chain-arg" title={detail}>
                  {detail}
                </div>
              ) : null}
              <StepContent step={data} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* ActivityChain                                                       */
/* ------------------------------------------------------------------ */

export interface ActivityChainProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  steps: ActivityStepData[];
  /** Controlled chain expansion (collapsed summary <-> step list). */
  expanded?: boolean;
  defaultExpanded?: boolean;
  /**
   * Streaming/live: while true the chain is FORCE-EXPANDED and its thoughts show
   * un-clamped so the user watches the run generate; the moment it flips false
   * (the run's response text begins, or the turn ends) the chain COLLAPSES to its
   * summary. Overrides `defaultExpanded`/user toggles for the duration. Collapse
   * animates via the existing height roll (reduced-motion safe).
   */
  active?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Seed which pill-gated step's content is open on mount (index into `steps`). */
  defaultOpenStep?: number;
  /** Override the derived past-tense summary line. */
  summary?: ReactNode;
  /** Activated for a step whose `opensInCanvas` is set. */
  onOpenCanvas?: (step: ActivityStepData, index: number) => void;
  /** Activated for a file-op step (read/edit/skill) to open its file in the canvas. */
  onOpenFile?: (step: ActivityStepData, index: number) => void;
}

/** Collapsed/expandable run of tool + thinking steps. */
export const ActivityChain = forwardRef<HTMLDivElement, ActivityChainProps>(function ActivityChain(
  {
    steps,
    expanded,
    defaultExpanded = false,
    active = false,
    onExpandedChange,
    defaultOpenStep,
    summary,
    onOpenCanvas,
    onOpenFile,
    className,
    ...rest
  },
  ref,
) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  // While streaming (active), force open; when the run ends, active→false and the
  // chain falls back to internalExpanded (collapsed by default) → it collapses.
  const isExpanded = expanded ?? (active ? true : internalExpanded);
  const [openStep, setOpenStep] = useState<number | null>(defaultOpenStep ?? null);

  const running = steps.some((s) => s.status === 'running');
  const toggleChain = () => {
    // No manual toggle while streaming — the live run stays open until it's done.
    if (active) return;
    const next = !isExpanded;
    if (expanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  };
  const toggleStep = (index: number) => setOpenStep((cur) => (cur === index ? null : index));

  const summaryText = summary ?? activitySummary(steps);

  // Stable, index-free keys (dedupe repeated content with an occurrence suffix).
  const seen = new Map<string, number>();
  const renderSteps = steps.map((step, index) => {
    const base = step.id ?? `${step.kind}:${step.label}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { step, index, key: n === 0 ? base : `${base}#${n}` };
  });

  return (
    <div
      ref={ref}
      className={clsx('pd-chain', className)}
      data-expanded={isExpanded}
      data-running={running}
      {...rest}
    >
      <button
        type="button"
        className="pd-chain-summary pd-focusable"
        aria-expanded={isExpanded}
        onClick={toggleChain}
      >
        <span className="pd-chain-summary-text">
          {running ? <ShimmerText>{summaryText}</ShimmerText> : summaryText}
        </span>
        <span className="pd-chain-summary-chevron" data-expanded={isExpanded}>
          <IconChevronRight size={14} />
        </span>
      </button>

      {/* The step list rolls open/closed (grid-rows reveal) — steps stay mounted
       * so the collapse animates too. */}
      <div className="pd-chain-reveal" data-open={isExpanded}>
        <div className="pd-chain-reveal-inner">
          <div className="pd-chain-steps">
            {renderSteps.map(({ step, index, key }) => (
              <ActivityStep
                key={key}
                data={step}
                expanded={openStep === index}
                live={active}
                onToggle={() => toggleStep(index)}
                onOpenCanvas={() => onOpenCanvas?.(step, index)}
                {...(onOpenFile !== undefined ? { onOpenFile: () => onOpenFile(step, index) } : {})}
              />
            ))}
            {/* Terminal "Done" — shown ONLY once the run is fully finished
             * (`!active`), never on the momentary inter-tool gap while streaming
             * where every step is briefly done → running=false (A3 flash fix). */}
            {!running && !active ? (
              <div className="pd-chain-step pd-chain-done">
                <div className="pd-chain-step-row">
                  <span className="pd-chain-step-icon pd-chain-done-icon">
                    <IconCheck size={14} />
                  </span>
                  <span className="pd-chain-step-label">Done</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
});
