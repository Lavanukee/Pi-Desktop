import { describe, expect, it } from 'vitest';
import { defaultFileCheck, type FileCheck, verifyProduct } from './verify.js';
import type { WorkspaceReadFs } from './workspace.js';

/** An in-memory read seam over an absolute path→content map. */
function memFs(byPath: Record<string, string>): WorkspaceReadFs {
  const store = new Map(Object.entries(byPath));
  return {
    readFile: (p) => store.get(p),
    listFiles: () => [...store.keys()],
  };
}

describe('verifyProduct (mock checks — the objective evidence)', () => {
  const files = { '/ws/a.ts': 'A', '/ws/b.ts': 'B', '/ws/c.ts': 'C' };

  it('reports ok with no errors when every file passes', () => {
    const allPass: FileCheck = () => undefined;
    const result = verifyProduct('/ws', memFs(files), allPass);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.filesChecked).toBe(3);
  });

  it('collects a concrete error per failing file and flips ok to false', () => {
    const someFail: FileCheck = (file) =>
      file.endsWith('b.ts') ? 'type error on line 3' : undefined;
    const result = verifyProduct('/ws', memFs(files), someFail);
    expect(result.ok).toBe(false);
    expect(result.filesChecked).toBe(3);
    expect(result.errors).toEqual([{ file: '/ws/b.ts', message: 'type error on line 3' }]);
  });

  it('passes each file path and content to the injected check', () => {
    const seen: Array<{ file: string; content: string }> = [];
    const capture: FileCheck = (file, content) => {
      seen.push({ file, content });
      return undefined;
    };
    verifyProduct('/ws', memFs({ '/ws/x.ts': 'body-x' }), capture);
    expect(seen).toEqual([{ file: '/ws/x.ts', content: 'body-x' }]);
  });

  it('captures a THROWING check as evidence rather than crashing (non-throwing)', () => {
    const boom: FileCheck = () => {
      throw new Error('checker exploded');
    };
    const result = verifyProduct('/ws', memFs({ '/ws/a.ts': 'x' }), boom);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('checker exploded');
  });

  it('is ok over an empty workspace (nothing to check)', () => {
    const result = verifyProduct('/ws', memFs({}), () => 'never called');
    expect(result).toEqual({ ok: true, filesChecked: 0, errors: [] });
  });

  it('survives a listing seam that throws', () => {
    const throwingFs: WorkspaceReadFs = {
      readFile: () => undefined,
      listFiles: () => {
        throw new Error('no dir');
      },
    };
    expect(verifyProduct('/ws', throwingFs).ok).toBe(true);
  });
});

describe('defaultFileCheck (built-in structural heuristic)', () => {
  it('passes a well-formed, balanced code file', () => {
    const src = [
      "import { x } from './x';",
      '',
      'export function make(): number {',
      '  const arr = [1, 2, 3];',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${…} is the scanner's input under test
      '  const s = `sum ${arr.reduce((a, b) => a + b, 0)}`;',
      '  return s.length; // ) ] } in a comment do not count',
      '}',
    ].join('\n');
    expect(defaultFileCheck('src/x.ts', src)).toBeUndefined();
  });

  it('flags an empty / whitespace-only file', () => {
    expect(defaultFileCheck('src/a.ts', '')).toContain('empty');
    expect(defaultFileCheck('src/a.ts', '   \n  ')).toContain('empty');
  });

  it('flags a leaked Markdown code fence in the body', () => {
    expect(defaultFileCheck('src/a.ts', '```ts\nexport const a = 1;\n```')).toContain('code fence');
  });

  it('flags a truncated code file (openers never closed)', () => {
    const truncated = 'export function cut() {\n  const x = [1, 2,';
    expect(defaultFileCheck('src/a.ts', truncated)).toContain('never closed');
  });

  it('flags a stray closer with no opener', () => {
    expect(defaultFileCheck('src/a.ts', 'export const a = 1;\n}')).toContain('no opener');
  });

  it('does not structurally scan non-code files (only empty/fence apply)', () => {
    expect(
      defaultFileCheck('README.md', 'A prose file with } an unbalanced brace.'),
    ).toBeUndefined();
  });

  it('does not count brackets inside strings or comments', () => {
    const src = 'export const s = "a { b ( c [";\n// ) ] } trailing\nexport const t = 1;\n';
    expect(defaultFileCheck('src/a.ts', src)).toBeUndefined();
  });
});
