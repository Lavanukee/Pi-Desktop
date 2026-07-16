import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityChain, ActivityStep, type ActivityStepData } from './activity-chain.tsx';

/**
 * Tool-row arg surfacing + disclosure (jedd round-2 #2). Every tool row must
 * name WHICH file/command/query it acted on ("Read a file: <path>") and the
 * whole row must be a click-to-expand disclosure that reveals the full arg +
 * the result/output. Asserted through the repo's jsdom-free static-markup
 * convention — `expanded` is a controlled prop, so both states render here.
 */
function render(data: ActivityStepData, expanded = false): string {
  return renderToStaticMarkup(<ActivityStep data={data} expanded={expanded} />);
}

describe('ActivityStep — primary arg surfaced inline', () => {
  const read: ActivityStepData = {
    kind: 'read',
    label: 'Read a file',
    detail: '/Users/jedd/src/deep/config.ts',
    filename: 'config.ts',
    preview: 'export const x = 1;',
  };

  it('shows the verb AND the file basename as a subline (spec-tool-call-row)', () => {
    const html = render(read);
    expect(html).toContain('Read a file');
    // A file-op row names its file on a SUBLINE under the verb (not inline).
    expect(html).toContain('pd-chain-step-subline');
    expect(html).toContain('>config.ts<');
    // …with the full path carried on `title` for hover.
    expect(html).toContain('title="/Users/jedd/src/deep/config.ts"');
  });

  it('makes the whole row a disclosure button with a chevron', () => {
    const collapsed = render(read, false);
    expect(collapsed).toContain('pd-chain-step-chevron');
    expect(collapsed).toMatch(/<button[^>]*class="pd-chain-step-row/);
    expect(collapsed).toContain('aria-expanded="false"');
    // The same row flips its expanded state from the controlled prop.
    expect(render(read, true)).toContain('aria-expanded="true"');
  });

  it('carries the FULL path + the result inside the reveal', () => {
    const html = render(read, true);
    expect(html).toContain('pd-chain-arg');
    // Full path (not just basename) in the reveal header, plus the file body.
    expect(html).toContain('/Users/jedd/src/deep/config.ts');
    expect(html).toContain('export const x = 1;');
  });

  it('surfaces a bash command verbatim (no basename truncation)', () => {
    const html = render({
      kind: 'bash',
      label: 'Ran a command',
      detail: 'cat src/app.ts',
      command: 'cat src/app.ts',
      output: 'ok',
    });
    expect(html).toContain('Ran a command');
    // A command keeps its slashes — it is NOT reduced to a basename.
    expect(html).toContain('cat src/app.ts');
  });

  it('surfaces a search query inline without turning the row into a disclosure', () => {
    const html = render({
      kind: 'search',
      label: 'Searched the web',
      detail: 'weather in tokyo',
      results: [{ title: 'Tokyo', url: 'https://example.com', domain: 'example.com' }],
    });
    expect(html).toContain('weather in tokyo');
    // Search renders its results inline (always open) — no click-to-reveal chevron.
    expect(html).not.toContain('pd-chain-step-chevron');
  });

  it('still surfaces the arg while running, before any result exists', () => {
    const html = render({
      kind: 'read',
      label: 'Reading a file',
      status: 'running',
      detail: '/tmp/notes.md',
      filename: 'notes.md',
    });
    expect(html).toContain('notes.md');
    // Nothing to reveal yet → no disclosure chevron.
    expect(html).not.toContain('pd-chain-step-chevron');
  });

  it('omits the inline arg entirely when no detail is provided', () => {
    const html = render({ kind: 'read', label: 'Read a file', preview: 'body' });
    expect(html).not.toContain('pd-chain-step-detail');
    expect(html).not.toContain('pd-chain-step-subline');
  });
});

/**
 * A2 — a read/edit/skill row can OPEN its file in the canvas. With `onOpenFile`
 * wired, the primary click opens the file and a separate chevron button still
 * discloses the args + result (deliverable 2 + 3 coexisting, no nested buttons).
 */
describe('ActivityStep — open-in-canvas affordance', () => {
  const read: ActivityStepData = {
    kind: 'read',
    label: 'Read a file',
    detail: '/repo/src/app.ts',
    filename: 'app.ts',
    preview: 'body',
  };

  it('splits into an open-file main button + a disclosure chevron when content exists', () => {
    const html = renderToStaticMarkup(
      <ActivityStep data={read} onOpenFile={() => {}} expanded={false} />,
    );
    expect(html).toContain('pd-chain-step-row--split');
    expect(html).toContain('pd-chain-step-open-main');
    expect(html).toContain('pd-chain-step-disclose');
    // The main button's accessible name names the file it opens.
    expect(html).toContain('Open app.ts in canvas');
    // The chevron still drives the reveal.
    expect(html).toContain('aria-expanded="false"');
  });

  it('makes the WHOLE row open the file when there is no content to disclose yet', () => {
    const running: ActivityStepData = {
      kind: 'read',
      label: 'Reading a file',
      status: 'running',
      detail: '/repo/src/app.ts',
      filename: 'app.ts',
    };
    const html = renderToStaticMarkup(<ActivityStep data={running} onOpenFile={() => {}} />);
    expect(html).toContain('Open app.ts in canvas');
    expect(html).not.toContain('pd-chain-step-row--split');
    expect(html).not.toContain('pd-chain-step-chevron');
  });

  it('does NOT offer to open a non-file kind (e.g. bash) even with onOpenFile wired', () => {
    const html = renderToStaticMarkup(
      <ActivityStep
        data={{ kind: 'bash', label: 'Ran a command', detail: 'ls', command: 'ls', output: 'ok' }}
        onOpenFile={() => {}}
      />,
    );
    expect(html).not.toContain('pd-chain-step-open-main');
  });
});

/**
 * A1/A4 — a connector row renders "Used <connector icon> <connector name>" with
 * the injected brand SVG, and every generic tool row is a disclosure that reveals
 * the raw args + result (never a mislabeled "Read a file").
 */
describe('ActivityStep — connector + generic tool rows', () => {
  it('renders a connector row with its injected brand SVG and a disclosure', () => {
    const html = renderToStaticMarkup(
      <ActivityStep
        data={{
          kind: 'connector',
          label: 'Set a reminder',
          iconSvg: '<svg data-testid="brand"></svg>',
          argsText: '{ "title": "Call" }',
          output: 'ok',
        }}
      />,
    );
    expect(html).toContain('Set a reminder');
    expect(html).toContain('data-testid="brand"');
    expect(html).toContain('pd-chain-step-chevron');
  });

  it('reveals a generic tool row’s input + output on expand', () => {
    const html = renderToStaticMarkup(
      <ActivityStep
        data={{ kind: 'tool', label: 'Do thing', argsText: 'input-args-here', output: 'result' }}
        expanded
      />,
    );
    expect(html).toContain('Do thing');
    expect(html).toContain('input-args-here');
    expect(html).toContain('result');
    // Labeled Input + Output frames inside the reveal.
    expect(html).toContain('>Input<');
    expect(html).toContain('>Output<');
  });
});

/**
 * A3 — the terminal "Done" row appears ONLY once the run is finished, never on
 * the momentary inter-tool gap while the chain is live (`active`).
 */
describe('ActivityChain — "Done" gating (A3 flash fix)', () => {
  const steps: ActivityStepData[] = [{ kind: 'bash', label: 'Ran a command', status: 'done' }];

  it('shows "Done" when the run is finished (not active)', () => {
    const html = renderToStaticMarkup(<ActivityChain steps={steps} expanded active={false} />);
    expect(html).toContain('pd-chain-done');
    expect(html).toContain('Done');
  });

  it('hides "Done" while the chain is still live (active) — no mid-chain flash', () => {
    const html = renderToStaticMarkup(<ActivityChain steps={steps} expanded active />);
    expect(html).not.toContain('pd-chain-done');
  });
});
