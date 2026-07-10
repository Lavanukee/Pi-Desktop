/**
 * Ambient module declarations for side-effect asset imports.
 *
 * In this source-exports monorepo, a consumer's `tsc --noEmit` type-checks the
 * dependency `.ts` sources it imports under the CONSUMER's compilerOptions. The
 * `@pi-desktop/ui` `Markdown` component pulls in KaTeX's stylesheet via
 * `import 'katex/dist/katex.min.css'`; ui declares this ambient for itself
 * (ui/src/globals.d.ts), but canvas — which also imports from `@pi-desktop/ui`
 * and so traverses that source — carries only `types: ["node"]` and would
 * otherwise fail with TS2882. This mirrors ui's declaration so canvas can
 * typecheck the shared source. (Pure build glue — no runtime/design impact.)
 */
declare module '*.css';
