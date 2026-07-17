import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';
import electron from 'vite-plugin-electron/simple';

/**
 * The renderer's CSP is delivered via a <meta> tag injected here so the exact
 * same policy applies in dev (http://localhost) and production (file://), where
 * response-header injection does not work. `frame-ancestors` is not usable in
 * meta CSPs; window embedding is instead prevented by Electron itself.
 */
function csp(dev: boolean): string {
  return [
    "default-src 'self'",
    // Dev only: @vitejs/plugin-react injects an inline react-refresh preamble.
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    // Tailwind (dev) and React inline styles require 'unsafe-inline' for styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    // Dev only: Vite HMR websocket.
    dev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
    // W7 canvas: the sandboxed artifact harness loads over the custom
    // pd-preview:// scheme (registered privileged+standard+secure in main.ts).
    'frame-src pd-preview:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Externals for the ELECTRON MAIN bundle (never the renderer):
 *  - `node-pty` — a native `.node` addon required at runtime.
 *  - `@mariozechner/pi-coding-agent` — the FULL pi agent runtime (pulls in every
 *    provider SDK, e.g. mistralai → an uninstalled optional `@opentelemetry/api`
 *    peer dep rolldown cannot bundle). The engine runs pi as a forked subprocess
 *    (its `dist/cli.js`); the corp role-agent runtime (electron/corp/role-agent.ts)
 *    value-imports it directly in main, so keep the whole SDK external — it
 *    resolves from node_modules at runtime, exactly like the engine's usage.
 * A function matches both the bare specifier and the resolved workspace/.pnpm path.
 */
function electronMainExternal(source: string): boolean {
  return source === 'node-pty' || source.includes('@mariozechner/pi-coding-agent');
}

function cspPlugin(): PluginOption {
  let dev = false;
  return {
    name: 'pi-desktop:csp',
    configResolved(config) {
      dev = config.command === 'serve';
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: csp(dev) },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cspPlugin(),
    // Builds electron/main.ts and electron/preload.ts to dist-electron/ and
    // (re)starts Electron against the Vite dev server during `vite` serve.
    electron({
      main: {
        // Record entry → dist-electron/main.js + dist-electron/inference-supervisor.js
        // (the plugin emits `[name].js` per entry). The supervisor is forked as
        // an Electron utilityProcess by electron/inference/llm-main.ts.
        entry: {
          main: 'electron/main.ts',
          'inference-supervisor': 'electron/inference/supervisor-entry.ts',
        },
        // The plugin's default startup argv is ['.', '--no-sandbox']; keep the
        // Chromium sandbox on in dev to match the production security posture.
        onstart: ({ startup }) => void startup(['.']),
        // node-pty is a native addon (.node) loaded via require at runtime — it
        // must never be bundled. Left external so the CJS `require('node-pty')`
        // in electron/terminal/pty-manager.ts resolves from node_modules (and
        // asarUnpack keeps its binary loadable in the packaged app).
        //
        // @mariozechner/pi-coding-agent is the FULL pi agent runtime (it pulls in
        // every provider SDK — mistralai, opentelemetry, …). The engine runs it as
        // a forked subprocess (its bundled dist/cli.js), never bundled into main.
        // The corp role-agent runtime (electron/corp/role-agent.ts) value-imports
        // it directly in main, so keep the WHOLE SDK external — it resolves from
        // node_modules at runtime, exactly like the engine's usage, instead of
        // rolldown trying (and failing) to bundle its optional peer deps.
        // NB: vite-plugin-electron reads `build.rolldownOptions` on Vite 8+ (and
        // `build.rollupOptions` on Vite < 8) — set both so the external applies
        // regardless. A FUNCTION external matches BOTH the bare specifier (kept as
        // a runtime require) AND the resolved workspace/.pnpm path (Vite resolves
        // the workspace import before a string-external check would fire).
        vite: {
          build: {
            rollupOptions: { external: electronMainExternal },
            rolldownOptions: { external: electronMainExternal },
          },
        },
      },
      preload: { input: 'electron/preload.ts' },
    }),
  ],
});
