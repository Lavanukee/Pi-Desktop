import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HarnessStageIndicator } from './HarnessStatus';
import { type HarnessStage, stageDisplay } from './harness-status';

/**
 * The harness publishes a coarse lifecycle `stage` on its status; the footer must
 * make that phase legible to the owner ("building / testing / touching up / final
 * sweep / done") without inventing a stage the harness never published. These
 * tests pin the pure stage→display mapping and the rendered label, using the
 * repo's jsdom-free static-markup convention.
 */
describe('stageDisplay (pure mapping)', () => {
  it('maps every in-flight stage to its verb, live=true', () => {
    const cases: Array<[HarnessStage, string]> = [
      ['classifying', 'Classifying'],
      ['working', 'Working'],
      ['repairing', 'Repairing'],
      ['reviewing', 'Reviewing'],
      ['revising', 'Revising'],
      ['verifying', 'Verifying'],
    ];
    for (const [stage, label] of cases) {
      expect(stageDisplay(stage)).toEqual({ label, live: true });
    }
  });

  it('maps the terminal `done` stage to a non-live label', () => {
    expect(stageDisplay('done')).toEqual({ label: 'Done', live: false });
  });

  it('hides idle / absent / unknown stages (returns null)', () => {
    expect(stageDisplay('idle')).toBeNull();
    expect(stageDisplay(null)).toBeNull();
    expect(stageDisplay(undefined)).toBeNull();
    // A garbled payload could smuggle an out-of-enum value; tolerate it.
    expect(stageDisplay('bogus' as HarnessStage)).toBeNull();
  });
});

describe('HarnessStageIndicator (renders the published stage)', () => {
  it('renders an in-flight stage as a muted "verb…" label carrying data-stage', () => {
    const html = renderToStaticMarkup(<HarnessStageIndicator stage="reviewing" />);
    expect(html).toContain('data-testid="harness-stage"');
    expect(html).toContain('data-stage="reviewing"');
    expect(html).toContain('Reviewing…');
    expect(html).toContain('text-text-muted');
    // The subtle per-stage glyph rides alongside the label.
    expect(html).toContain('<svg');
  });

  it('renders the terminal stage as a plain "Done" in the success tint (no ellipsis)', () => {
    const html = renderToStaticMarkup(<HarnessStageIndicator stage="done" />);
    expect(html).toContain('data-stage="done"');
    expect(html).toContain('>Done<');
    expect(html).not.toContain('Done…');
    expect(html).toContain('text-status-success-fg');
  });

  it('renders nothing when idle or absent', () => {
    expect(renderToStaticMarkup(<HarnessStageIndicator stage="idle" />)).toBe('');
    expect(renderToStaticMarkup(<HarnessStageIndicator stage={undefined} />)).toBe('');
    expect(renderToStaticMarkup(<HarnessStageIndicator stage={null} />)).toBe('');
  });
});
