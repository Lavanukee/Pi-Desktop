# Pi Desktop architecture (W0 baseline)

> **No commits until the gate.** Per the project working agreement, nothing is committed
> until the "core done" quality gate: all v0.1 workstreams complete, the full checklist
> passes, and an adversarial testing pass comes back clean. The repo's first real commit
> is the single v0.1 commit. Until then: build, verify, do not commit.

## Process model

Four process kinds (plan §D). W0 ships the first two; the utility processes land in W4/W5.

| Process | Role |
| --- | --- |
| **main** | Window management, typed IPC broker, PiBridge child process per session window, fs-handlers, importers, mcp-lite host, updater. |
| **renderer(s)** | React UI. Always `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP. No Node access; everything flows through the typed preload bridge. |
| **utilityProcess "inference-supervisor"** (W4) | Downloads/verifies llama.cpp binaries; launches and supervises llama-server children (main + optional utility model); health checks, TPS sampling, crash-restart backoff. llama-server is owned here, never by pi. |
| **utilityProcess "job-runner"** (v0.1 interface + trivial impl) | JobQueue for long-running work; v0.2 generation services plug into it. |

### Renderer security (set in W0, binding)

- `BrowserWindow` webPreferences: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Window opening denied (`setWindowOpenHandler`) and navigation blocked (`will-navigate`).
- CSP is injected as a `<meta>` tag by a small Vite plugin (`apps/desktop/vite.config.ts`)
  so the identical mechanism covers dev (`http://localhost`) and packaged (`file://`) loads,
  where response-header injection is unavailable. Production policy:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
  Dev adds `'unsafe-inline'` scripts (react-refresh preamble) and `ws://localhost:*` (HMR).
  W7's sandboxed canvas iframes will extend `frame-src` deliberately when they land.
- Single-instance lock in main; second launches focus the existing window (creating one if all
  windows were closed on macOS).

### IPC sender trust (hardened after foundation review)

- Every window's `WebContents` is registered via `registerTrustedSender` at creation
  (`apps/desktop/electron/trusted-senders.ts`). All `pi:*`/app invoke handlers validate the caller
  with `isTrustedIpcEvent` (registered sender **and** main-frame-only: `senderFrame === sender.mainFrame`).
- The preload only forwards channels listed in `APP_INVOKE_CHANNELS`, which is compile-time-exhaustive
  against `AppInvokeMap` — a new channel must be added to the map **and** the list or the build breaks.
- **W7 canvas invariant (binding):** canvas iframes must be sandboxed **without** `allow-same-origin`,
  and the app preload must never be attached to a `WebContents` hosting untrusted/LLM-generated
  content. Sender-side IPC checks cannot distinguish a same-origin child frame that calls
  `window.top.piDesktop.invoke(...)` — it executes in the top frame's preload — so isolation must come
  from the frame sandbox, not from IPC validation alone.
- The `window.__pi_store` E2E hook is gated behind the `?piE2E=1` query param (set by `PI_E2E=1` at
  launch); it is absent from normal production runs. Future E2E specs must set that env var.

## Chosen versions (resolved 2026-07-07)

| Dependency | Version | Notes |
| --- | --- | --- |
| Electron | 43.x | latest stable |
| Vite | 8.x | rolldown-based |
| React | 19.2.x | current stable |
| TypeScript | 6.0.x | strict everywhere |
| Tailwind CSS | 4.3.x | CSS-first config via `@theme` |
| Zustand | 5.0.x | renderer state |
| Vitest | 4.1.x | unit tests |
| Turborepo | 2.10.x | task runner + cache |
| Biome | 2.5.x | lint + format (2-space, single quotes, 100 cols) |
| vite-plugin-electron | 1.1.x | dev orchestration + main/preload bundling |
| pnpm | 11.10.0 | pinned via `packageManager` |
| Node | >= 24 | `.nvmrc` = 24 (CI); Electron bundles its own Node at runtime |
| playwright-core | 1.61.x | `_electron` smoke probe (`apps/desktop/tests/e2e/probe.mjs`) |

## Dev workflow

`pnpm dev` runs `vite` in `apps/desktop`; **vite-plugin-electron** (simple API) bundles
`electron/main.ts` and `electron/preload.ts` to `dist-electron/` and starts/hot-restarts
Electron against the dev server (`VITE_DEV_SERVER_URL`). Chosen over a `concurrently`
setup because it gives main-process hot restart, preload rebuilds, and renderer HMR from
a single Vite config with no port/race choreography.

Build artifact formats: renderer is ESM; `dist-electron/*` is CJS because **sandboxed
preload scripts must be CommonJS** (Electron constraint), and keeping main consistent with
preload simplifies the toolchain. All *source* is strict ESM TypeScript.

### Monorepo conventions (binding for all workstreams)

- **Internal-packages pattern:** workspace packages export TypeScript source directly
  (`"exports": { ".": "./src/index.ts" }`); the app's bundler compiles them. No per-package
  build step; `typecheck` (`tsc --noEmit`) and `lint` run per package via Turbo.
- **Dependency flow:** `apps/desktop` → `packages/*`; packages never import from apps;
  `@pi-desktop/shared` imports from nothing (not even `electron` — see IPC below).
- **tsconfig:** every package extends `packages/shared/tsconfig.base.json`
  (strict, ES2023, moduleResolution bundler, verbatimModuleSyntax, noUncheckedIndexedAccess).
- TypeScript strict everywhere; no `any` except at validated process/wire boundaries
  (each such cast justified by an adjacent runtime check or registration-side guarantee).
- Biome zero-warning policy in CI (`biome check`), 2-space indent, single quotes.
- Comments only for non-obvious constraints.

## IPC contract conventions

Helpers live in `packages/shared/src/ipc.ts`; the app's concrete surface in
`apps/desktop/electron/ipc-contract.ts`. Main, preload, and renderer all import the same
contract module, so any drift is a compile error on every side.

- **Channel maps are `type` aliases** (`AppInvokeMap`, `AppEventMap`) mapping channel name →
  `{ request, response }` (invoke) or payload (events). Aliases, not interfaces, so they
  satisfy the `Record` constraints.
- **Channel names:** `domain:action` kebab-case, e.g. `app:get-info`.
- **Renderer → main:** `createIpcClient` over `ipcRenderer.invoke`; main registers with
  `registerIpcHandlers` (exhaustive: one handler per channel, enforced by the type) or
  `registerIpcHandler` for a single channel.
- **Main → renderer events:** multiplexed over one wire channel (`IPC_EVENT_CHANNEL`) as
  `{ channel, payload }` envelopes via `createIpcEventSender`; the preload fans them out
  through `createIpcEventHub`.
- **Pre-mount event buffer (load-bearing, kept from RemotePi):** the preload attaches to
  the wire immediately; the hub buffers events per channel until the first subscriber
  attaches, then flushes in order. Main pushes events (e.g. `app:boot` on
  `did-finish-load`) before React mounts — without the buffer these are lost. The buffer
  exists only until a channel's first subscription; it is capped (drop-oldest, default 256)
  with an `onDrop` hook.
- **shared never imports `electron`:** helpers accept structural slices of
  `ipcRenderer`/`ipcMain`/`webContents`, keeping them unit-testable in plain Node.
- Preload exposes exactly one object, `window.piDesktop` (`PiDesktopBridge`), via
  `contextBridge.exposeInMainWorld`. Never expose raw `ipcRenderer`.

## Theming mechanism (proven in W0, filled in by W1)

`<html data-flavor="claude|codex" data-mode="dark|light">` drives token resolution:
`@pi-desktop/themes/themes.css` (generated from `packages/themes/src/tokens.ts` via
`pnpm --filter @pi-desktop/themes generate`) defines the full `--pd-*` vocabulary per
attribute combo, and Tailwind's default palette is cleared (`--color-*: initial`) with
utilities mapped via `@theme inline` onto `var(--pd-*)` only — so flipping the attributes
restyles everything live, no reload. The Zustand theme store writes the attributes.
`@pi-desktop/ui` primitives style exclusively through `--pd-*` tokens (plus the shared
`pd-*` keyframes emitted alongside them); consumers load `@pi-desktop/themes/themes.css`
and `@pi-desktop/ui/styles.css` once at the root.
