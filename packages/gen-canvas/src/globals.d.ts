/**
 * Ambient module declarations for side-effect asset imports.
 *
 * In this source-exports monorepo, a consumer's `tsc --noEmit` type-checks the
 * dependency `.ts` sources it imports under the CONSUMER's compilerOptions. The
 * `@pi-desktop/ui` `Markdown` component pulls in KaTeX's stylesheet via
 * `import 'katex/dist/katex.min.css'`; because gen-canvas imports from
 * `@pi-desktop/ui` (Spinner) it traverses that source and would otherwise fail
 * with TS2882. Mirrors packages/canvas/src/globals.d.ts. (Pure build glue.)
 */
declare module '*.css';
