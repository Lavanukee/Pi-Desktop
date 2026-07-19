/**
 * The pure live-write extractor ({@link liveFileWrites} / {@link
 * liveFileContentForPath}) that pulls a corp worker's file body out of its
 * streamed CorpBlocks — a PARTIAL (still-typing) `<function=write>` as well as a
 * settled one — so the canvas file tab renders the ACTUAL growing content, not the
 * empty mid-run product peek.
 */
import { describe, expect, it } from 'vitest';
import type { CorpBlock } from '../../state/corp-store';
import {
  corpBashSteps,
  currentCorpFile,
  isHtmlPath,
  liveFileContentForPath,
  liveFileWrites,
} from './corp-file-content';

const text = (t: string, streaming = false): CorpBlock => ({ kind: 'text', text: t, streaming });

describe('liveFileWrites — the streamed write body, partial and complete', () => {
  it('extracts a still-STREAMING write (content not yet closed)', () => {
    const block = text(
      '<function=write><parameter=path>index.html</parameter><parameter=content>\n<!DOCTYPE html><body><h1>Hi',
      true,
    );
    const [w] = liveFileWrites([block]);
    expect(w?.path).toBe('index.html');
    expect(w?.content).toBe('<!DOCTYPE html><body><h1>Hi'); // leading newline trimmed
    expect(w?.streaming).toBe(true);
  });

  it('extracts a SETTLED write, cutting the content at </parameter> (no scaffolding leaks)', () => {
    const block = text(
      '<function=write><parameter=path>src/app.tsx</parameter><parameter=content>export const A = 1;\n</parameter></function>',
    );
    const [w] = liveFileWrites([block]);
    expect(w?.path).toBe('src/app.tsx');
    expect(w?.content).toBe('export const A = 1;\n');
    expect(w?.streaming).toBe(false);
    expect(w?.content).not.toContain('</parameter>');
    expect(w?.content).not.toContain('</function>');
  });

  it('drops a trailing PARTIAL close tag so no half-written scaffolding flickers in', () => {
    const block = text(
      '<function=write><parameter=path>a.txt</parameter><parameter=content>done</para',
      true,
    );
    const [w] = liveFileWrites([block]);
    expect(w?.content).toBe('done'); // the partial "</para" is stripped
  });

  it('waits for the PATH to close before surfacing a write (nothing to key a tab on yet)', () => {
    const block = text('<function=write><parameter=path>index.htm', true);
    expect(liveFileWrites([block])).toHaveLength(0);
  });

  it('keeps the LAST write to a path (newest content wins)', () => {
    const blocks: CorpBlock[] = [
      text(
        '<function=write><parameter=path>x.ts</parameter><parameter=content>v1</parameter></function>',
      ),
      text(
        '<function=write><parameter=path>x.ts</parameter><parameter=content>v2 longer</parameter></function>',
      ),
    ];
    const writes = liveFileWrites(blocks);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.content).toBe('v2 longer');
  });

  it('ignores prose that merely mentions writing (no call shape)', () => {
    expect(liveFileWrites([text('I will write index.html next.')])).toHaveLength(0);
  });
});

describe('liveFileContentForPath — newest write across all nodes', () => {
  it('finds a write by exact path or suffix', () => {
    const store = {
      'eng-1': [
        text(
          '<function=write><parameter=path>site/index.html</parameter><parameter=content>PAGE</parameter></function>',
        ),
      ],
    };
    expect(liveFileContentForPath(store, 'site/index.html')?.content).toBe('PAGE');
    expect(liveFileContentForPath(store, 'index.html')?.content).toBe('PAGE'); // suffix match
    expect(liveFileContentForPath(store, 'other.html')).toBeUndefined();
  });
});

describe('liveFileContentForPath — structured file-block bodies too', () => {
  it('surfaces a STRUCTURED write body (C1), not just text-form calls', () => {
    const store = {
      'eng-1': [
        {
          kind: 'file',
          path: 'src/menu.ts',
          addedLines: 2,
          removedLines: 0,
          content: 'export const x = 1;',
        },
      ] as CorpBlock[],
    };
    expect(liveFileContentForPath(store, 'src/menu.ts')?.content).toBe('export const x = 1;');
    expect(liveFileContentForPath(store, 'menu.ts')?.content).toBe('export const x = 1;'); // suffix
  });
});

describe('currentCorpFile — the ONE file a node is showing right now', () => {
  it('returns a STRUCTURED write with its captured body + authoritative badge', () => {
    const blocks: CorpBlock[] = [
      { kind: 'file', path: 'src/x.ts', addedLines: 33, removedLines: 1, content: 'a\nb\nc' },
    ];
    expect(currentCorpFile(blocks)).toEqual({
      path: 'src/x.ts',
      content: 'a\nb\nc',
      streaming: false,
      addedLines: 33,
      removedLines: 1,
    });
  });

  it('is still-streaming for a body-less START row (opens the tab; fills on completion)', () => {
    const blocks: CorpBlock[] = [
      { kind: 'file', path: 'src/x.ts', addedLines: 0, removedLines: 0 },
    ];
    const f = currentCorpFile(blocks);
    expect(f?.path).toBe('src/x.ts');
    expect(f?.content).toBe('');
    expect(f?.streaming).toBe(true);
  });

  it('returns the NEWEST file across a mix of text-form + structured writes', () => {
    const blocks: CorpBlock[] = [
      text(
        '<function=write><parameter=path>a.ts</parameter><parameter=content>A</parameter></function>',
      ),
      { kind: 'file', path: 'b.ts', addedLines: 4, removedLines: 0, content: 'BBBB' },
    ];
    // The structured b.ts is the last file-bearing block → the current file.
    expect(currentCorpFile(blocks)).toMatchObject({ path: 'b.ts', content: 'BBBB', addedLines: 4 });
  });

  it('is undefined when the node has written nothing', () => {
    expect(currentCorpFile([text('just some prose, no write')])).toBeUndefined();
  });
});

describe('corpBashSteps — a node’s shell commands in order', () => {
  it('collects each bash command with its captured output (one terminal mirror)', () => {
    const blocks: CorpBlock[] = [
      { kind: 'tool', toolName: 'bash', detail: 'npm run build', output: 'Build OK' },
      { kind: 'tool', toolName: 'read', detail: 'x.ts' },
      { kind: 'tool', toolName: 'bash', detail: 'npm test', output: 'Tests pass' },
    ];
    expect(corpBashSteps(blocks)).toEqual([
      { command: 'npm run build', output: 'Build OK' },
      { command: 'npm test', output: 'Tests pass' },
    ]);
  });
});

describe('isHtmlPath', () => {
  it('matches .html / .htm only', () => {
    expect(isHtmlPath('index.html')).toBe(true);
    expect(isHtmlPath('a/b/mockup.HTM')).toBe(true);
    expect(isHtmlPath('style.css')).toBe(false);
    expect(isHtmlPath('app.tsx')).toBe(false);
  });
});
