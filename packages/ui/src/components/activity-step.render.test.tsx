import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityStep, type ActivityStepData } from './activity-chain.tsx';

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

  it('shows the verb AND the file basename on the inline row', () => {
    const html = render(read);
    expect(html).toContain('Read a file');
    expect(html).toContain('pd-chain-step-detail');
    // The inline arg shows only the basename (the meaningful tail)…
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
  });
});
