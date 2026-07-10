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
        vite: {
          build: {
            rollupOptions: { external: ['node-pty'] },
          },
        },
      },
      preload: { input: 'electron/preload.ts' },
    }),
  ],
});
