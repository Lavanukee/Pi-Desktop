import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';
import electron from 'vite-plugin-electron';
import electronSimple from 'vite-plugin-electron/simple';

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
    // pd-file: is the canvas media scheme (canvas-main.ts) that streams project
    // file bytes for previews — images (+ mammoth's inlined data: images), 3D
    // models / Office docs fetched as ArrayBuffers (connect-src), video/audio
    // (media-src), and the PDF iframe (frame-src).
    "img-src 'self' data: pd-file:",
    "font-src 'self' data:",
    "media-src 'self' pd-file:",
    // Dev only: Vite HMR websocket.
    dev
      ? "connect-src 'self' ws://localhost:* http://localhost:* pd-file:"
      : "connect-src 'self' pd-file:",
    // W7 canvas: the sandboxed artifact harness loads over the custom
    // pd-preview:// scheme (registered privileged+standard+secure in main.ts);
    // pd-file: carries a previewed PDF into the built-in viewer iframe.
    'frame-src pd-preview: pd-file:',
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
    // Builds electron/main.ts + electron/preload.ts to dist-electron/ and
    // (re)starts Electron against the Vite dev server during `vite` serve.
    //
    // node-pty is a native addon (.node) loaded via require at runtime — it must
    // never be bundled. Left external so the CJS `require('node-pty')` in
    // electron/terminal/pty-manager.ts resolves from node_modules (and asarUnpack
    // keeps its binary loadable in the packaged app).
    //
    // @mariozechner/pi-coding-agent is the FULL pi agent runtime (it pulls in
    // every provider SDK — mistralai, opentelemetry, …). The engine runs it as a
    // forked subprocess (its bundled dist/cli.js), never bundled into main. The
    // corp role-agent runtime (electron/corp/role-agent.ts) value-imports it
    // directly in main, so keep the WHOLE SDK external — it resolves from
    // node_modules at runtime, exactly like the engine's usage, instead of
    // rolldown trying (and failing) to bundle its optional peer deps.
    // NB: vite-plugin-electron reads `build.rolldownOptions` on Vite 8+ (and
    // `build.rollupOptions` on Vite < 8) — set both so the external applies
    // regardless. A FUNCTION external matches BOTH the bare specifier (kept as a
    // runtime require) AND the resolved workspace/.pnpm path (Vite resolves the
    // workspace import before a string-external check would fire).
    electronSimple({
      main: {
        // → dist-electron/main.js. The plugin's default startup argv is
        // ['.', '--no-sandbox']; keep the Chromium sandbox on in dev to match the
        // production security posture.
        entry: 'electron/main.ts',
        onstart: ({ startup }) => void startup(['.']),
        vite: {
          build: {
            rollupOptions: { external: electronMainExternal },
            rolldownOptions: { external: electronMainExternal },
          },
        },
      },
      preload: { input: 'electron/preload.ts' },
    }),
    // The inference-supervisor utilityProcess is built as its OWN isolated
    // rolldown pass (→ dist-electron/inference-supervisor.js), forked by
    // electron/inference/llm-main.ts. It MUST NOT co-bundle with main.ts: when
    // both were two entries of one rolldown build, rolldown centralized the shared
    // CJS interop runtime helpers into the first entry chunk (main.js) and emitted
    // `require("./main.js")` from the supervisor to reach them. Loading main.js in
    // the utilityProcess ran the ENTIRE main bootstrap
    // (app.requestSingleInstanceLock / app.whenReady, and the afm/mac module-level
    // `HELPER_PATH = resolveBundledPackageAsset(...)` → app.isPackaged/getAppPath)
    // where `electron.app` is undefined → a synchronous
    // `TypeError: reading 'isPackaged'` that KILLED the supervisor on load, so
    // llama-server never started. A separate build makes the supervisor
    // self-contained (its own helpers, no cross-entry require) — the isolated
    // utilityProcess it is documented to be. Same externals as main for parity.
    // onstart is a no-op: the electronSimple build above owns the single dev
    // Electron launch/reload; the supervisor is a runtime-forked utilityProcess, so
    // a renderer reload could never re-fork it anyway (a dev restart picks it up).
    electron([
      {
        entry: { 'inference-supervisor': 'electron/inference/supervisor-entry.ts' },
        onstart: () => {},
        vite: {
          build: {
            rollupOptions: { external: electronMainExternal },
            rolldownOptions: { external: electronMainExternal },
          },
        },
      },
    ]),
  ],
});
