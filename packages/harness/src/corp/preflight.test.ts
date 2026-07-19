import { describe, expect, it } from 'vitest';
import { preflightProduct, summarizePreflight } from './preflight.js';
import type { WorkspaceReadFs } from './workspace.js';

/** An in-memory read seam over an absolute path→content map (mirrors verify.test). */
function memFs(byPath: Record<string, string>): WorkspaceReadFs {
  const store = new Map(Object.entries(byPath));
  return {
    readFile: (p) => store.get(p),
    listFiles: () => [...store.keys()],
  };
}

/** Wrap an inline module body in a minimal entry HTML. */
function htmlWithModule(body: string, head = ''): string {
  return `<!doctype html><html><head>${head}</head><body><script type="module">${body}</script></body></html>`;
}

describe('preflightProduct — applicability', () => {
  it('is a vacuous PASS for a pure-logic product (no index.html entry)', () => {
    const r = preflightProduct('/ws', memFs({ '/ws/src/main.ts': 'export const x = 1;' }));
    expect(r.applicable).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.defects).toEqual([]);
  });

  it('is a PASS over an empty workspace', () => {
    const r = preflightProduct('/ws', memFs({}));
    expect(r).toEqual({ ok: true, applicable: false, filesChecked: 0, defects: [] });
  });

  it('picks the SHALLOWEST index.html as the entry', () => {
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/deep/nested/index.html': htmlWithModule(''),
        '/ws/index.html': htmlWithModule(''),
      }),
    );
    expect(r.applicable).toBe(true);
    expect(r.entry).toBe('index.html');
  });
});

describe('preflightProduct — path normalization (no false FAIL on a correct product)', () => {
  // The workspace arg and the listFiles output can differ by a trailing/double slash
  // (a $TMPDIR ending in "/"). A prefix miss would leave every path absolute and read
  // a CORRECT product as all-imports-missing. Both forms must resolve identically.
  const correct = {
    '/ws/index.html': htmlWithModule("import { start } from './game.js'; start();"),
    '/ws/game.js': 'export function start() {}',
  };

  it('a trailing-slash workspace arg still resolves relative imports', () => {
    const r = preflightProduct('/ws/', memFs(correct));
    expect(r.applicable).toBe(true);
    expect(r.entry).toBe('index.html');
    expect(r.ok).toBe(true);
  });

  it('a double-slash workspace arg still resolves relative imports', () => {
    const r = preflightProduct('/ws//', memFs(correct));
    expect(r.ok).toBe(true);
    expect(r.entry).toBe('index.html');
  });
});

describe('preflightProduct — loadable products PASS (no false positives)', () => {
  it('a fully self-contained inline entry with no imports loads', () => {
    const r = preflightProduct(
      '/ws',
      memFs({ '/ws/index.html': htmlWithModule('const canvas = document.body; run();') }),
    );
    expect(r.ok).toBe(true);
    expect(r.defects).toEqual([]);
  });

  it('a relative import that resolves to a real .js loads (and is followed)', () => {
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/index.html': htmlWithModule("import { start } from './game.js'; start();"),
        '/ws/game.js': 'export function start() {}',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('a bare specifier COVERED by an import map loads', () => {
    const head =
      '<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js"}}</script>';
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/index.html': htmlWithModule(
          "import * as THREE from 'three'; new THREE.Scene();",
          head,
        ),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('an absolute-URL import loads (CDN / inline)', () => {
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/index.html': htmlWithModule(
          "import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';",
        ),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('a classic non-module <script src> that resolves loads', () => {
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/index.html':
          '<!doctype html><html><body><script src="./bundle.js"></script></body></html>',
        '/ws/bundle.js': 'console.log("hi")',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('a commented-out import is NOT treated as a real one', () => {
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/index.html': htmlWithModule("// import { X } from './does-not-exist.js';\nrun();"),
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('preflightProduct — proven load-breakers FAIL', () => {
  it('flags a missing relative module WITH a did-you-mean pointing at the real exporter', () => {
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/index.html': htmlWithModule("import { GameState } from './src/engine/state.ts';"),
        '/ws/src/engine/index.ts': 'export class GameState {}',
      }),
    );
    expect(r.ok).toBe(false);
    const d = r.defects[0];
    expect(d?.kind).toBe('missing-module');
    expect(d?.specifier).toBe('./src/engine/state.ts');
    expect(d?.message).toContain('src/engine/index.ts');
    expect(d?.message).toContain('GameState');
  });

  it('flags a .ts import a browser cannot run (even when the file exists)', () => {
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/index.html': htmlWithModule("import { X } from './mod.ts';"),
        '/ws/mod.ts': 'export const X = 1;',
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.defects[0]?.kind).toBe('ts-in-browser');
  });

  it('flags an extensionless import that RESOLVES to a .ts file as ts-in-browser', () => {
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/index.html': htmlWithModule("import { X } from './mod';"),
        '/ws/mod.ts': 'export const X = 1;',
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.defects[0]?.kind).toBe('ts-in-browser');
  });

  it('flags a bare specifier with no import map', () => {
    const r = preflightProduct(
      '/ws',
      memFs({ '/ws/index.html': htmlWithModule("import * as THREE from 'three';") }),
    );
    expect(r.ok).toBe(false);
    expect(r.defects[0]?.kind).toBe('bare-import-no-map');
  });

  it('flags a node: builtin in a browser artifact', () => {
    const r = preflightProduct(
      '/ws',
      memFs({ '/ws/index.html': htmlWithModule("import { writeFileSync } from 'node:fs';") }),
    );
    expect(r.ok).toBe(false);
    expect(r.defects[0]?.kind).toBe('node-builtin-in-browser');
  });

  it('flags a runtime import of a types-only @types package', () => {
    const r = preflightProduct(
      '/ws',
      memFs({ '/ws/index.html': htmlWithModule("import { Scene } from '@types/three';") }),
    );
    expect(r.ok).toBe(false);
    expect(r.defects[0]?.kind).toBe('types-only-import');
  });

  it('surfaces a defect discovered TRANSITIVELY (entry → a.js → missing b)', () => {
    const r = preflightProduct(
      '/ws',
      memFs({
        '/ws/index.html': htmlWithModule("import './a.js';"),
        '/ws/a.js': "import './b.js';", // b.js does not exist
      }),
    );
    expect(r.ok).toBe(false);
    const d = r.defects[0];
    expect(d?.kind).toBe('missing-module');
    expect(d?.importer).toBe('a.js');
  });
});

describe('preflightProduct — the overnight run reproduction', () => {
  // index.html imported ./src/engine/state.ts (GameState) + ./src/engine/input.ts
  // (InputManager) — BOTH missing; the real exports lived in src/engine/index.ts.
  const files = {
    '/ws/index.html': htmlWithModule(
      "import { GameState } from './src/engine/state.ts';\n" +
        "import { InputManager } from './src/engine/input.ts';\n" +
        'new GameState();',
    ),
    '/ws/src/engine/index.ts': 'export class GameState {}\nexport class InputManager {}',
    '/ws/src/engine/world.ts': "import * as THREE from 'three';",
  };

  it('FAILS with a missing-module per broken import, each pointing at engine/index.ts', () => {
    const r = preflightProduct('/ws', memFs(files));
    expect(r.ok).toBe(false);
    expect(r.defects).toHaveLength(2);
    expect(r.defects.every((d) => d.kind === 'missing-module')).toBe(true);
    expect(r.defects.every((d) => d.message.includes('src/engine/index.ts'))).toBe(true);
    // The would-be sign-off is impossible: summarize gives a concrete bounce block.
    const summary = summarizePreflight(r);
    expect(summary).toContain('DOES NOT LOAD');
    expect(summary).toContain('./src/engine/state.ts');
    expect(summary).toContain('./src/engine/input.ts');
  });
});

describe('summarizePreflight', () => {
  it('is empty when the product loads or the check does not apply', () => {
    expect(summarizePreflight({ ok: true, applicable: true, filesChecked: 1, defects: [] })).toBe(
      '',
    );
    expect(summarizePreflight({ ok: true, applicable: false, filesChecked: 0, defects: [] })).toBe(
      '',
    );
  });
});
