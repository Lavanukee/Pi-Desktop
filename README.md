# Pi Desktop

An open-source desktop app for local AI — chat, agentic tool use, and coding powered by local
models (llama.cpp) on the [pi](https://github.com/badlogic/pi-mono) agent engine, with
reference-quality desktop UX.

## Dev quickstart

Requirements: Node >= 24, pnpm 11 (`corepack enable` or `npm i -g pnpm`).

```sh
pnpm install
pnpm dev        # Vite dev server + Electron with hot reload
pnpm check      # lint + typecheck + test + build (what CI runs)
```

## Monorepo map

| Path | Purpose |
| --- | --- |
| `apps/desktop` | Electron app (main, preload, React renderer) |
| `packages/shared` | tsconfig base, typed IPC helpers, `Result`, logger |
| `packages/themes` | semantic design tokens; claude/codex x light/dark |
| `packages/ui` | shared component library (design system) |
| `packages/engine` | pi RPC bridge, event router, session rehydration |
| `packages/inference` | llama.cpp binary/model management, server supervisor |
| `packages/harness` | pi extension: classifier, toolsets, repair, permissions |
| `packages/provider-llamacpp` | pi provider for llama-server (SSE streaming) |
| `packages/web-tools` | web search / fetch / python tools |
| `packages/mcp-lite` | MCP stdio client + lite proxy mode |
| `packages/importers` | Claude / Codex config and session importers |
| `packages/canvas` | artifact surfaces (code/md/html/svg renderers) |
| `docs` | architecture and protocol docs |

See `docs/architecture.md` for the process model and conventions.

## License

[MIT](./LICENSE)
