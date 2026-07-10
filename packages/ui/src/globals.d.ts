/**
 * Ambient module declarations for side-effect asset imports.
 *
 * The Markdown component pulls in KaTeX's vendored stylesheet via
 * `import 'katex/dist/katex.min.css'` so the app's bundler inlines it and
 * rewrites the KaTeX font URLs to local bundled assets (offline, no external
 * fetch). TypeScript needs this declaration to accept the CSS side-effect
 * import under `moduleResolution: bundler`.
 */
declare module '*.css';
