/**
 * Execution-grounded PREFLIGHT — "does the assembled product actually LOAD?"
 * (spec §8 the tester gate, generalized past "a file named index.html exists").
 *
 * WHY this exists (the real-run defect it fixes): an overnight run signed off a
 * "production-ready" web product whose `index.html` imported `./src/engine/state.ts`
 * and `./src/engine/input.ts` — TWO FILES THAT DO NOT EXIST (the real exports lived
 * in `src/engine/index.ts`) — via `.ts` specifiers a browser cannot execute, with a
 * bare `import 'three'` and no import map, and `import … from 'node:media'` (not a
 * real module) inside the audio code. Opening the entry does NOTHING but throw. Yet
 * the tester gate PASSED (a file named `index.html` was present) and the CEO signed
 * off "all verification checks PASS". The whole verification chain was NARRATIVE,
 * never execution: nothing ever resolved an import or loaded the entry.
 *
 * This is the missing MODEL-FREE, DETERMINISTIC measurement: for a web product, take
 * the runnable entry, walk its import graph against the files that ACTUALLY exist in
 * the workspace, and report the concrete load-breakers — a relative import with no
 * target on disk (with a "did you mean" pointing at the file that really exports the
 * symbol), a `.ts`/`.tsx` module a browser can't run, a bare specifier with no import
 * map, a `node:*` builtin in a browser artifact, a runtime import of a types-only
 * `@types/*` package. Any of those means the product does not load — a BLOCKING gate
 * failure the CEO's APPROVE is gated on, and a concrete defect list the integration
 * recovery bounces DOWN so the entry gets rebuilt self-contained.
 *
 * Deliberately STATIC (no browser, no toolchain) so it stays pure + portable like
 * {@link verifyProduct} — it is the sibling whole-product check to verify.ts's
 * per-file check. A live headless load is a future INJECTABLE seam; this static
 * import-graph pass already catches every defect the overnight run shipped. It is
 * scoped to WEB products (an `index.html` entry a browser opens): a pure-logic
 * product has no browser entry and is `applicable: false` (the gate passes — the
 * existing per-file verify + tester lens govern it). Pure + deterministic; never
 * throws.
 */

import type { WorkspaceReadFs } from './workspace.js';

/** The kinds of load-breaker a static preflight can prove without running anything. */
export type PreflightDefectKind =
  /** A relative/absolute import whose target does not exist on disk. */
  | 'missing-module'
  /** A resolved import points at a `.ts`/`.tsx` file a browser cannot execute. */
  | 'ts-in-browser'
  /** A bare specifier (`three`) with no import map to resolve it in the browser. */
  | 'bare-import-no-map'
  /** A `node:*` builtin imported into a browser artifact. */
  | 'node-builtin-in-browser'
  /** A runtime import of a types-only `@types/*` package (no runtime value). */
  | 'types-only-import';

/** One concrete, proven reason the product will not load: which file, which import,
 * and a human-legible message (with a "did you mean" for a missing module). */
export interface PreflightDefect {
  readonly kind: PreflightDefectKind;
  /** The workspace-relative file the bad import appears in (`index.html`, a module). */
  readonly importer: string;
  /** The offending import specifier, verbatim. */
  readonly specifier: string;
  /** A concrete, actionable description (includes the "did you mean" when known). */
  readonly message: string;
}

/** The objective load evidence the tester gate + CEO review read. `ok` is true when
 * the product loads (no defects) OR the check does not apply (no web entry). */
export interface PreflightResult {
  /** True when the product loads: `!applicable`, or applicable with zero defects. */
  readonly ok: boolean;
  /** True only for a web product with a runnable `index.html` entry to check. A
   * pure-logic product (no browser entry) is `false` — the gate passes vacuously. */
  readonly applicable: boolean;
  /** The entry that was walked (workspace-relative), when applicable. */
  readonly entry?: string;
  /** How many files the import walk actually read. */
  readonly filesChecked: number;
  /** Every proven load-breaker, in discovery order. */
  readonly defects: readonly PreflightDefect[];
}

/** A browser-executable module/script extension (what a `<script type=module>` or a
 * resolved relative import may legally be). `.ts`/`.tsx` are deliberately EXCLUDED —
 * a browser cannot run TypeScript, so resolving to one is a {@link PreflightDefect}. */
const BROWSER_MODULE_EXT = ['.js', '.mjs', '.cjs'];
/** Every source extension a relative import may resolve to (browser-legal or not);
 * `.ts`/`.tsx`/`.jsx` resolve but are flagged, so we still FOLLOW them for deeper
 * defects. Order matters: the browser-legal ones win a resolution tie. */
const RESOLVE_EXT = [...BROWSER_MODULE_EXT, '.ts', '.tsx', '.jsx'];
/** Extensions whose import graph we parse + follow (source modules). */
const SOURCE_EXT = /\.(?:[cm]?js|tsx?|jsx)$/i;
/** TypeScript module extensions — resolvable on disk but not by a browser. */
const TS_EXT = /\.(?:tsx?)$/i;

/** Strip line + block comments from source so a commented-out `import` never reads as
 * a real one (the main false-positive source). String-naive but comment-safe: it
 * removes `//…` and `/* … *\/`; a URL's `//` inside a string is rare in module code
 * and an accepted edge (mirrors verify.ts's lightweight-heuristic stance). Pure. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** One parsed import: its specifier and the binding names it pulls in (for the
 * "did you mean" search). Namespace/side-effect imports carry no named bindings. */
interface ParsedImport {
  readonly specifier: string;
  readonly names: readonly string[];
  /** True for a default import (`import Foo from …`) — searched as `export default`. */
  readonly hasDefault: boolean;
}

/** Extract every static/dynamic import + re-export specifier from a JS/TS source,
 * with the bound names for named/default imports. Comment-stripped first. Pure. */
function parseImports(src: string): ParsedImport[] {
  const code = stripComments(src);
  const out: ParsedImport[] = [];

  // `import <clause> from '<spec>'` and `export <clause> from '<spec>'`.
  const fromRe = /\b(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  for (let m = fromRe.exec(code); m !== null; m = fromRe.exec(code)) {
    const clause = m[1] ?? '';
    const specifier = m[2] ?? '';
    const names: string[] = [];
    let hasDefault = false;
    // Named bindings: `{ A, B as C }` → A, C.
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of (braces[1] ?? '').split(',')) {
        const seg = part.trim();
        if (seg === '') continue;
        const asMatch = /\bas\s+([A-Za-z_$][\w$]*)/.exec(seg);
        const name = asMatch ? asMatch[1] : seg.split(/\s+/)[0];
        if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
      }
    }
    // A default binding is a bare identifier before the first `{`/`*`/`,`.
    const defMatch = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$|\bfrom\b)/.exec(
      clause.replace(/\bfrom\b[\s\S]*$/, ''),
    );
    if (defMatch && clause.trimStart()[0] !== '{' && clause.trimStart()[0] !== '*')
      hasDefault = true;
    out.push({ specifier, names, hasDefault });
  }

  // Side-effect import: `import '<spec>'` (no clause, no `from`).
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (let m = bareRe.exec(code); m !== null; m = bareRe.exec(code)) {
    out.push({ specifier: m[1] ?? '', names: [], hasDefault: false });
  }

  // Dynamic import: `import('<spec>')` (skips `import.meta`, which has no `(`).
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = dynRe.exec(code); m !== null; m = dynRe.exec(code)) {
    out.push({ specifier: m[1] ?? '', names: [], hasDefault: false });
  }

  return out;
}

/** Normalize a POSIX-ish path, resolving `.`/`..` segments. Pure. */
function normalizeParts(parts: string[]): string {
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** Resolve a relative specifier against the importer's directory → a normalized
 * workspace-relative base (no extension applied yet). Pure. */
function resolveRelative(importerRel: string, specifier: string): string {
  const slash = importerRel.lastIndexOf('/');
  const dir = slash === -1 ? '' : importerRel.slice(0, slash);
  return normalizeParts([...(dir === '' ? [] : dir.split('/')), ...specifier.split('/')]);
}

/** First existing file among the resolution candidates for a relative `base`
 * (exact, then `base+ext`, then `base/index+ext`), or `undefined`. Pure. */
function resolveOnDisk(base: string, files: ReadonlyMap<string, string>): string | undefined {
  if (files.has(base)) return base;
  for (const ext of RESOLVE_EXT) if (files.has(base + ext)) return base + ext;
  for (const ext of RESOLVE_EXT) if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return undefined;
}

/** Search the product for the file that EXPORTS one of `names` (or a default, when
 * `hasDefault`), for a missing-module "did you mean". Returns the first match's
 * relative path + the name it matched, or `undefined`. Pure. */
function findExporter(
  imp: ParsedImport,
  files: ReadonlyMap<string, string>,
): { path: string; name: string } | undefined {
  for (const name of imp.names) {
    const named = new RegExp(
      `export\\s+(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${name}\\b` +
        `|export\\s*\\{[^}]*\\b${name}\\b`,
    );
    for (const [path, content] of files) {
      if (SOURCE_EXT.test(path) && named.test(content)) return { path, name };
    }
  }
  if (imp.hasDefault) {
    for (const [path, content] of files) {
      if (SOURCE_EXT.test(path) && /export\s+default\b/.test(content)) {
        return { path, name: 'default' };
      }
    }
  }
  return undefined;
}

/** Bare specifiers this import map can resolve (its `imports` keys, matched exactly
 * or as a `pkg/`-prefix). Tolerant of a malformed map (→ empty set). Pure. */
function importMapKeys(entryHtml: string): Set<string> {
  const keys = new Set<string>();
  const block = /<script[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(
    entryHtml,
  );
  if (!block) return keys;
  try {
    const parsed: unknown = JSON.parse(block[1] ?? '{}');
    const imports =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as { imports?: unknown }).imports
        : undefined;
    if (imports !== null && typeof imports === 'object') {
      for (const k of Object.keys(imports as Record<string, unknown>)) keys.add(k);
    }
  } catch {
    /* malformed import map → no keys (still a bare-import defect below) */
  }
  return keys;
}

/** True when a bare specifier is covered by an import-map key (exact, or a `pkg/…`
 * subpath under a `pkg/` key). Pure. */
function coveredByMap(specifier: string, keys: ReadonlySet<string>): boolean {
  if (keys.has(specifier)) return true;
  for (const key of keys) if (key.endsWith('/') && specifier.startsWith(key)) return true;
  return false;
}

/** The module specifiers the entry HTML loads: inline `<script type=module>` imports
 * (returned as source to parse) + `src=`/module `src` references (returned as
 * relative specifiers to resolve + follow). Pure. */
function entryModuleSources(entryHtml: string): { inline: string[]; srcs: string[] } {
  const inline: string[] = [];
  const srcs: string[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = scriptRe.exec(entryHtml); m !== null; m = scriptRe.exec(entryHtml)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const isImportMap = /type\s*=\s*["']importmap["']/i.test(attrs);
    if (isImportMap) continue;
    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (srcMatch) srcs.push(srcMatch[1] ?? '');
    else if (body.trim() !== '') inline.push(body);
  }
  return { inline, srcs };
}

/** Classify one specifier from `importerRel` and push a defect if it will not load.
 * Returns the resolved relative path to FOLLOW next (a local source module), or
 * `undefined`. Mutates `defects`; pure aside from that. */
function checkSpecifier(
  imp: ParsedImport,
  importerRel: string,
  files: ReadonlyMap<string, string>,
  mapKeys: ReadonlySet<string>,
  defects: PreflightDefect[],
): string | undefined {
  const spec = imp.specifier.trim();
  if (spec === '') return undefined;
  // External / inline — always loadable.
  if (/^(?:https?:)?\/\//i.test(spec) || spec.startsWith('data:') || spec.startsWith('blob:')) {
    return undefined;
  }
  // Node builtin in a browser artifact.
  if (spec.startsWith('node:')) {
    defects.push({
      kind: 'node-builtin-in-browser',
      importer: importerRel,
      specifier: spec,
      message: `imports '${spec}' — a Node.js builtin that does not exist in a browser. A product that opens in a browser cannot use node: modules; use a Web API or bundle a browser shim.`,
    });
    return undefined;
  }
  // Relative / absolute path → resolve against the real files.
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const base = spec.startsWith('/') ? spec.slice(1) : resolveRelative(importerRel, spec);
    const resolved = resolveOnDisk(base, files);
    if (resolved === undefined) {
      const hint = findExporter(imp, files);
      const didYouMean =
        hint !== undefined
          ? ` — did you mean './${hint.path}'? (it exports ${hint.name === 'default' ? 'a default' : hint.name})`
          : '';
      defects.push({
        kind: 'missing-module',
        importer: importerRel,
        specifier: spec,
        message: `imports '${spec}' but no such file exists in the product${didYouMean}. The entry must import files that actually exist.`,
      });
      return undefined;
    }
    if (TS_EXT.test(resolved)) {
      defects.push({
        kind: 'ts-in-browser',
        importer: importerRel,
        specifier: spec,
        message: `imports '${spec}' which resolves to TypeScript (${resolved}) — a browser cannot execute .ts. Ship compiled .js, or inline the code into the entry.`,
      });
    }
    return SOURCE_EXT.test(resolved) ? resolved : undefined;
  }
  // Bare specifier.
  if (spec.startsWith('@types/')) {
    defects.push({
      kind: 'types-only-import',
      importer: importerRel,
      specifier: spec,
      message: `imports '${spec}' — a types-only package with no runtime value; importing it at runtime throws. Import the real package (via an import map) instead.`,
    });
    return undefined;
  }
  if (!coveredByMap(spec, mapKeys)) {
    defects.push({
      kind: 'bare-import-no-map',
      importer: importerRel,
      specifier: spec,
      message: `imports bare '${spec}' with no import map to resolve it — a browser cannot resolve bare specifiers with no build. Add a <script type="importmap"> mapping '${spec}' to a URL, or import it from a CDN URL directly.`,
    });
  }
  return undefined;
}

/**
 * Statically PREFLIGHT the assembled product in `workspace`: for a web product (an
 * `index.html` entry), walk the entry's import graph against the files that actually
 * exist and report every proven load-breaker (missing module, `.ts` in the browser,
 * bare specifier with no import map, `node:*`, `@types/*`). Model-free + deterministic
 * — the sibling whole-product check to {@link verifyProduct}'s per-file check, and
 * the ground truth the tester gate + CEO review read. `applicable` is false (and `ok`
 * true) for a pure-logic product with no browser entry. Never throws: a listing/read
 * failure yields an empty/again-vacuous result rather than a crash.
 */
export function preflightProduct(workspace: string, fs: WorkspaceReadFs): PreflightResult {
  // Read every file into a workspace-relative map (the resolution universe).
  const files = new Map<string, string>();
  let absList: readonly string[];
  try {
    absList = fs.listFiles(workspace);
  } catch {
    absList = [];
  }
  const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`;
  for (const abs of absList) {
    let content: string | undefined;
    try {
      content = fs.readFile(abs);
    } catch {
      content = undefined;
    }
    if (content === undefined) continue;
    const rel = (abs.startsWith(prefix) ? abs.slice(prefix.length) : abs).replace(/\\/g, '/');
    files.set(rel, content);
  }

  // The entry: the shallowest index.html(m) (a browser opens it directly).
  let entry: string | undefined;
  for (const rel of files.keys()) {
    if (!/(?:^|\/)index\.html?$/i.test(rel)) continue;
    if (entry === undefined || rel.split('/').length < entry.split('/').length) entry = rel;
  }
  if (entry === undefined) {
    return { ok: true, applicable: false, filesChecked: 0, defects: [] };
  }

  const entryHtml = files.get(entry) ?? '';
  const mapKeys = importMapKeys(entryHtml);
  const defects: PreflightDefect[] = [];
  const visited = new Set<string>();
  let filesChecked = 1;

  // BFS the import graph from the entry's inline modules + module srcs.
  const queue: Array<{ rel: string; src: string }> = [];
  const enqueue = (rel: string): void => {
    if (visited.has(rel)) return;
    visited.add(rel);
    const src = files.get(rel);
    if (src !== undefined) {
      filesChecked += 1;
      queue.push({ rel, src });
    }
  };

  const { inline, srcs } = entryModuleSources(entryHtml);
  for (const body of inline) {
    for (const imp of parseImports(body)) {
      const follow = checkSpecifier(imp, entry, files, mapKeys, defects);
      if (follow !== undefined) enqueue(follow);
    }
  }
  for (const src of srcs) {
    const follow = checkSpecifier(
      { specifier: src, names: [], hasDefault: false },
      entry,
      files,
      mapKeys,
      defects,
    );
    if (follow !== undefined) enqueue(follow);
  }

  while (queue.length > 0) {
    const { rel, src } = queue.shift() as { rel: string; src: string };
    for (const imp of parseImports(src)) {
      const follow = checkSpecifier(imp, rel, files, mapKeys, defects);
      if (follow !== undefined) enqueue(follow);
    }
  }

  return { ok: defects.length === 0, applicable: true, entry, filesChecked, defects };
}

/** A concise, deterministic one-block summary of the preflight defects for a prompt
 * or bounce note (the entry + each defect, capped). Empty string when the product
 * loads or the check does not apply. Pure. */
export function summarizePreflight(result: PreflightResult): string {
  if (result.ok || result.defects.length === 0) return '';
  const lines = [
    `The runnable entry (${result.entry ?? 'index.html'}) DOES NOT LOAD — ${result.defects.length} proven load-breaker(s):`,
  ];
  for (const d of result.defects) lines.push(`  - [${d.kind}] ${d.importer}: ${d.message}`);
  return lines.join('\n');
}
