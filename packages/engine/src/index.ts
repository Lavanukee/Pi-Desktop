/**
 * @pi-desktop/engine — pi RPC integration layer.
 *
 * This root export is renderer-safe (types + pure translation logic only).
 * The Node-only bridge (child-process spawn) lives behind the
 * `@pi-desktop/engine/main` subpath so renderer bundles never pull in
 * node:child_process.
 */
export * from './renderer/event-router';
export * from './renderer/rehydrate';
export * from './renderer/store-sink';
export * from './types/chat';
export * from './types/rpc';
