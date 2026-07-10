import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ArtifactContent } from '../model.ts';
import { MarkdownSurface } from './markdown-surface.tsx';

function md(text: string): ArtifactContent {
  return { kind: 'markdown', text };
}

describe('MarkdownSurface', () => {
  it('renders GitHub-flavored markdown (headings, tables, emphasis)', () => {
    const out = renderToStaticMarkup(
      <MarkdownSurface
        content={md('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**bold**')}
        streaming={false}
      />,
    );
    expect(out).toContain('<h1');
    expect(out).toContain('<table');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('routes fenced code through the shared CodeBlock', () => {
    const out = renderToStaticMarkup(
      <MarkdownSurface content={md('```js\nconst x = 1;\n```')} streaming={false} />,
    );
    expect(out).toContain('pd-code-block');
    expect(out).toContain('const x = 1;');
  });

  it('escapes raw embedded HTML (no rehype-raw — script cannot inject)', () => {
    const out = renderToStaticMarkup(
      <MarkdownSurface content={md('<script>alert(1)</script>\n\nsafe text')} streaming={false} />,
    );
    expect(out).not.toContain('<script>');
    expect(out).toContain('safe text');
  });
});
