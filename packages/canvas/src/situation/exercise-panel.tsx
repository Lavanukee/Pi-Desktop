/**
 * The exercise panel — the headline moment of the situation room (spec §11):
 * when the run BROWSES references, RUNS its own build, or executes a TEST
 * pass, this panel slides in prominently over the work tree and shows it
 * happening live — a cursor moving over a page, a build being played, a test
 * run streaming — instead of burying it as a feed line.
 *
 * The engine only sends the session lifecycle ({@link ExerciseSessionView});
 * the live visual is rendered here (mocked content today, the same slot a real
 * browser-use / runner feed will fill). All motion is token-driven and fully
 * disabled under prefers-reduced-motion.
 */

import type { ExerciseSessionView } from '@pi-desktop/coordination';
import { IconCheck, IconCompass, IconEye, IconTerminal, ShimmerText } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';

export interface ExercisePanelProps {
  session: ExerciseSessionView;
  /** True while the panel is animating out (drives the slide-away). */
  leaving?: boolean;
}

function kindIcon(kind: ExerciseSessionView['kind']) {
  switch (kind) {
    case 'browse':
      return <IconCompass size={13} />;
    case 'test':
      return <IconTerminal size={13} />;
    case 'run':
      return <IconEye size={13} />;
  }
}

function kindEyebrow(kind: ExerciseSessionView['kind']): string {
  switch (kind) {
    case 'browse':
      return 'Looking things up';
    case 'test':
      return 'Testing the work';
    case 'run':
      return 'Trying the build';
  }
}

export function ExercisePanel({ session, leaving }: ExercisePanelProps) {
  const running = session.status === 'running';
  return (
    <section
      className="pd-sitroom-exercise"
      data-kind={session.kind}
      data-status={session.status}
      data-leaving={leaving || undefined}
      data-testid="exercise-panel"
      aria-live="polite"
    >
      <header className="pd-sitroom-exercise-head">
        <span className="pd-sitroom-exercise-icon" aria-hidden="true">
          {kindIcon(session.kind)}
        </span>
        <span className="pd-sitroom-exercise-eyebrow">{kindEyebrow(session.kind)}</span>
        <span className="pd-sitroom-exercise-title">
          {running ? <ShimmerText>{session.title}</ShimmerText> : session.title}
        </span>
        <span className="pd-sitroom-exercise-spacer" />
        {running ? (
          <span className="pd-sitroom-exercise-live">
            <span className="pd-sitroom-gem" data-state="working" aria-hidden="true">
              <span className="pd-sitroom-gem-glow" />
              <span className="pd-sitroom-gem-ring" />
              <span className="pd-sitroom-gem-core" />
            </span>
            live
          </span>
        ) : (
          <span className="pd-sitroom-exercise-verdict" data-verdict={session.status}>
            {session.status === 'failed' ? null : <IconCheck size={11} />}
            {session.status === 'passed'
              ? 'passed'
              : session.status === 'failed'
                ? 'failed'
                : 'done'}
          </span>
        )}
      </header>
      {session.detail !== undefined ? (
        <div className="pd-sitroom-exercise-detail">{session.detail}</div>
      ) : null}
      <div className="pd-sitroom-exercise-body">
        {session.kind === 'test' ? (
          <TestRunView running={running} passed={session.status === 'passed'} />
        ) : session.kind === 'browse' ? (
          <BrowseView running={running} detail={session.detail} />
        ) : (
          <GameRunView running={running} />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Test pass — a streaming suite run
// ---------------------------------------------------------------------------

const TEST_SUITES: readonly { name: string; checks: number }[] = [
  { name: 'engine/renderer', checks: 24 },
  { name: 'engine/loop', checks: 12 },
  { name: 'engine/physics', checks: 21 },
  { name: 'engine/collision', checks: 17 },
  { name: 'game/state', checks: 19 },
  { name: 'game/entities', checks: 16 },
  { name: 'game/combat', checks: 23 },
  { name: 'game/ai', checks: 14 },
  { name: 'game/save', checks: 11 },
  { name: 'ui/hud', checks: 13 },
  { name: 'ui/menu', checks: 9 },
  { name: 'audio/bus', checks: 12 },
  { name: 'audio/spatial', checks: 13 },
  { name: 'assets/manifest', checks: 10 },
];
const TOTAL_CHECKS = TEST_SUITES.reduce((sum, s) => sum + s.checks, 0);
const VISIBLE_ROWS = 6;

function TestRunView({ running, passed }: { running: boolean; passed: boolean }) {
  const [landed, setLanded] = useState(passed ? TEST_SUITES.length : 0);

  useEffect(() => {
    if (!running) {
      setLanded(TEST_SUITES.length);
      return undefined;
    }
    const timer = setInterval(() => {
      setLanded((n) => (n < TEST_SUITES.length ? n + 1 : n));
    }, 420);
    return () => clearInterval(timer);
  }, [running]);

  const done = TEST_SUITES.slice(0, landed);
  const checksDone = done.reduce((sum, s) => sum + s.checks, 0);
  const tail = done.slice(-VISIBLE_ROWS);
  const current = running && landed < TEST_SUITES.length ? TEST_SUITES[landed] : undefined;

  return (
    <div className="pd-sitroom-testrun">
      <div className="pd-sitroom-testrun-rows">
        {tail.map((suite) => (
          <div className="pd-sitroom-testrun-row" key={suite.name}>
            <span className="pd-sitroom-testrun-check" aria-hidden="true">
              <IconCheck size={10} />
            </span>
            <span className="pd-sitroom-testrun-name">{suite.name}</span>
            <span className="pd-sitroom-testrun-count">{suite.checks} checks</span>
          </div>
        ))}
        {current !== undefined ? (
          <div className="pd-sitroom-testrun-row" data-running key={current.name}>
            <span className="pd-sitroom-testrun-spin" aria-hidden="true" />
            <span className="pd-sitroom-testrun-name">
              <ShimmerText>{current.name}</ShimmerText>
            </span>
          </div>
        ) : null}
      </div>
      <div className="pd-sitroom-testrun-foot">
        <span
          className="pd-sitroom-testrun-track"
          role="progressbar"
          aria-valuenow={checksDone}
          aria-valuemin={0}
          aria-valuemax={TOTAL_CHECKS}
        >
          <span
            className="pd-sitroom-testrun-fill"
            style={{ width: `${(checksDone / TOTAL_CHECKS) * 100}%` }}
          />
        </span>
        <span className="pd-sitroom-testrun-tally">
          {checksDone} / {TOTAL_CHECKS} checks
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse — a live page with the worker's cursor moving over it
// ---------------------------------------------------------------------------

function BrowseView({ running, detail }: { running: boolean; detail?: string }) {
  return (
    <div className="pd-sitroom-browse" data-running={running || undefined}>
      <div className="pd-sitroom-browse-chrome" aria-hidden="true">
        <span className="pd-sitroom-browse-dot" />
        <span className="pd-sitroom-browse-dot" />
        <span className="pd-sitroom-browse-dot" />
        <span className="pd-sitroom-browse-address">{detail ?? 'reference material'}</span>
      </div>
      <div className="pd-sitroom-browse-page" aria-hidden="true">
        <span className="pd-sitroom-browse-h1" />
        <span className="pd-sitroom-browse-line" style={{ width: '86%' }} />
        <span className="pd-sitroom-browse-line" style={{ width: '72%' }} />
        <span className="pd-sitroom-browse-line" style={{ width: '80%' }} />
        <span className="pd-sitroom-browse-fig" />
        <span className="pd-sitroom-browse-line" style={{ width: '64%' }} />
        <span className="pd-sitroom-browse-line" style={{ width: '76%' }} />
        <span className="pd-sitroom-browse-line" style={{ width: '70%' }} />
        <span className="pd-sitroom-browse-h2" />
        <span className="pd-sitroom-browse-line" style={{ width: '82%' }} />
        <span className="pd-sitroom-browse-line" style={{ width: '58%' }} />
        <span className="pd-sitroom-browse-fig" data-alt />
        <span className="pd-sitroom-browse-line" style={{ width: '74%' }} />
        {running ? (
          <>
            <span className="pd-sitroom-cursor" />
            <span className="pd-sitroom-cursor-ripple" />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run — the build being played (abstract, premium; a real feed will fill this)
// ---------------------------------------------------------------------------

const PLAY_CAPTIONS = [
  'moving through the second level',
  'combat encounter — timing feels tight',
  'torchlight falloff reads right',
  'audio cue lands with the hit',
  'saving and reloading mid-run',
  'boss room — full loop holds',
];

function GameRunView({ running }: { running: boolean }) {
  const [caption, setCaption] = useState(0);
  const captionRef = useRef(caption);
  captionRef.current = caption;

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      setCaption((c) => (c + 1) % PLAY_CAPTIONS.length);
    }, 2100);
    return () => clearInterval(timer);
  }, [running]);

  const text = running ? PLAY_CAPTIONS[caption] : 'run complete';
  return (
    <div className="pd-sitroom-gamerun" data-running={running || undefined}>
      <div className="pd-sitroom-gamerun-view" aria-hidden="true">
        <span className="pd-sitroom-gamerun-wall" data-side="left" />
        <span className="pd-sitroom-gamerun-wall" data-side="right" />
        <span className="pd-sitroom-gamerun-floor" />
        <span className="pd-sitroom-gamerun-player" />
        <span className="pd-sitroom-gamerun-hud">
          <span className="pd-sitroom-gamerun-health" />
        </span>
        <span className="pd-sitroom-gamerun-minimap">
          <span className="pd-sitroom-gamerun-blip" />
        </span>
      </div>
      <div className="pd-sitroom-gamerun-caption" key={text}>
        {running ? <ShimmerText>{text}</ShimmerText> : text}
      </div>
    </div>
  );
}
